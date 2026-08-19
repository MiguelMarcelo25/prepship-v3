/**
 * PS-502 production dependencies for the atomic replacement shipped command.
 *
 * Per user override `unlock shipped data` on 2026-08-19: these adapters operate only on the
 * replacement-owned shipment already locked by `shipReplacement`. They do not update the
 * original order lifecycle, notify a marketplace, or accept money/package quantities from HTTP.
 */
import { eq } from 'drizzle-orm';
import { billingConfig } from '../db/schema/billing';
import { clients } from '../db/schema/clients';
import { shipments } from '../db/schema/shipments';
import { replacements } from '../db/schema/replacements';
import { env } from '../lib/env.js';
import {
  billingLosAngelesDayForInstant,
  resolveBillingCalendarDay,
} from './billing-calendar-policy.js';
import { consumeOutboundPackageInTransaction } from './package-consumption.js';
import { writeReplacementBillingInTransaction } from './replacement-billing-writer.js';
import { resolveReplacementCustomerPostage } from './replacement-customer-money.js';
import type {
  ReplacementBillingWriter,
  ReplacementPackageConsumer,
} from './replacement-shipped-command.js';
import { isReplacementProviderCredentialAuthority } from './replacement-provider-credential-authority.js';

function validDate(value: unknown): Date | null {
  const parsed = value instanceof Date ? value : new Date(String(value ?? ''));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Consume the package selected and frozen on the replacement shipment. The route never gets
 * to state a package here; it could only choose one earlier as an attributed operator override.
 */
export const consumeReplacementPackage: ReplacementPackageConsumer = async (tx: any, input) => {
  const [replacement] = await tx
    .select({
      orderId: replacements.orderId,
      clientId: replacements.clientId,
      reference: replacements.reference,
      shipmentId: replacements.replacementShipmentId,
    })
    .from(replacements)
    .where(eq(replacements.id, input.replacementId))
    .limit(1);
  const [shipment] = await tx
    .select()
    .from(shipments)
    .where(eq(shipments.id, input.shipmentId))
    .limit(1);
  const clientRows = replacement?.clientId == null
    ? []
    : await tx
      .select({ id: clients.id, isTest: clients.isTest })
      .from(clients)
      .where(eq(clients.id, replacement.clientId))
      .limit(2);
  if (
    !replacement
    || !shipment
    || clientRows.length !== 1
    || shipment.source !== 'replacement'
    || replacement.shipmentId !== shipment.id
    || shipment.orderId !== null
    || shipment.clientId !== replacement.clientId
    || shipment.orderNumber !== replacement.reference
    || shipment.labelShipmentId !== input.providerShipmentId
    || !isReplacementProviderCredentialAuthority(input.providerCredentialAuthority)
  ) {
    return { consumed: false, reason: 'the replacement-owned shipment could not be read' };
  }

  const result = await consumeOutboundPackageInTransaction({
    shipmentId: shipment.id,
    // The vessel stays detached from generic original-order shipment consumers, while the
    // package ledger retains the relational original-order attribution supplied by replacement.
    orderId: replacement.orderId,
    orderNumber: shipment.orderNumber,
    source: 'replacement',
    // This is the exact V2 credential scope frozen before purchase, not the carrier-account id.
    sourceAccountId: input.providerCredentialAuthority.scope,
    providerShipmentId: input.providerShipmentId,
    // ShipStation numeric shipment ids are account-scoped. The local shipment PK is globally
    // unique, so two replacement labels on two accounts can never collapse one package claim.
    idempotencyIdentity: 'local_shipment',
    effectiveAt: input.effectiveAt,
    selectedPackageId: shipment.selectedPackageId,
    dimensions: {
      length: shipment.dimsL,
      width: shipment.dimsW,
      height: shipment.dimsH,
    },
    voided: shipment.voided,
    isReturn: shipment.isReturn,
    isTest: clientRows[0]!.isTest,
  }, tx);

  if (result.status === 'consumed' || result.status === 'already_consumed') {
    return { consumed: true };
  }
  return {
    consumed: false,
    reason: result.reason,
  };
};

/**
 * Resolve pick/pack and customer postage from their database owners inside the shipping tx.
 * A missing/inactive policy is not zero dollars; it is an unresolved billing decision.
 */
export const writeReplacementBilling: ReplacementBillingWriter = async (tx: any, input) => {
  const [shipment] = await tx
    .select()
    .from(shipments)
    .where(eq(shipments.id, input.shipmentId))
    .limit(1);
  if (
    !shipment
    || shipment.source !== 'replacement'
    || shipment.id !== input.replacement.replacementShipmentId
    || shipment.orderId !== null
    || shipment.clientId !== input.replacement.clientId
    || shipment.orderNumber !== input.replacement.reference
  ) {
    throw new Error('replacement billing shipment identity is not authoritative');
  }
  const clientId = input.replacement.clientId;
  if (!Number.isInteger(clientId) || Number(clientId) <= 0) {
    throw new Error('replacement billing requires an authoritative client identity');
  }

  const [policy] = await tx
    .select({
      active: billingConfig.active,
      pickPackFee: billingConfig.pickPackFee,
    })
    .from(billingConfig)
    .where(eq(billingConfig.clientId, Number(clientId)))
    .limit(1);
  if (!policy || policy.active !== true) {
    throw new Error('active billing_config is required before a billable replacement can ship');
  }
  const pickPackCharge = Number(policy.pickPackFee);
  if (!Number.isFinite(pickPackCharge) || pickPackCharge < 0) {
    throw new Error('billing_config.pick_pack_fee is not an authoritative money value');
  }

  const customerPostage = resolveReplacementCustomerPostage({
    frozenCustomerShippingMoney: shipment.selectedRateJson,
  });
  if (!customerPostage) {
    throw new Error('the replacement shipment has no authority-bearing frozen customer money');
  }

  const shipDate = validDate(input.effectiveAt)!;
  const calendar = resolveBillingCalendarDay({
    actualActivityDay: billingLosAngelesDayForInstant(shipDate),
    effectiveDate: env.BILLING_WEEKEND_ROLLFORWARD_EFFECTIVE_DATE,
  });
  const billingEffectiveDate = new Date(`${calendar.billingEffectiveDay}T00:00:00.000Z`);

  return writeReplacementBillingInTransaction(tx, {
    replacementId: input.replacement.id,
    orderId: input.replacement.orderId,
    clientId: Number(clientId),
    reference: input.replacement.reference,
    replacementShipmentId: input.shipmentId,
    billable: input.replacement.billable,
    customerPostage,
    pickPackCharge,
    shipDate,
    billingEffectiveDate,
    billingPolicyVersion: calendar.policyVersion,
  });
};
