import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { orderOverrides, orders } from '../db/schema/orders';
import { isEbayMarketplaceOrder } from './ebay-order-detection';
import {
  CACHE_TTL_MS,
  getCarrierAccountsForRateContext,
  getRateEngineLimiterSnapshot,
  getDirectCarrierRatesForRateInput,
  getRates,
  rateCacheKey,
  resolveRateInput,
  type RateInput,
} from './rates';
import { combineCarrierUniverses, rateTotal } from './rates-combined';
import {
  buildRateBrowseFailureDiagnostic,
  buildRateBrowseTimingDiagnostics,
} from './rate-browser-timing-diagnostics';
import { stampHouseTuple } from './shipping-workflow/house-tuple-stamp';
import { redactRateBrowserMoney } from './rate-browser-money-redaction';
import {
  buildResidentialEvidenceFromOrder,
  residentialEvidenceRateInput,
  type ResidentialEvidence,
} from './shipping-workflow/residential-evidence';
import { resolveAddressClassification } from './shipping-workflow/resolve-address-classification';
import {
  finalizeStrictRecalculationForResponse,
  planStrictRecalculateDecision,
} from './rates-recalculate';
import { persistStrictRecalculateOutcome } from './rates-recalculate-persist';
import {
  getCarrierEligibilityMode,
  evaluateOrderCarrierEligibility,
} from './shipping-workflow/carrier-eligibility-policy';
import {
  buildRateBrowseSingleFlightKey,
  runRateBrowseSingleFlight,
} from './rate-browse-singleflight';
import {
  isHugrabShippingContext,
  SHIPPING_SERVICE_ELIGIBILITY_VERSION,
} from '../lib/shipping-service-eligibility';
import {
  buildBestRateWorkflowDto,
} from './shipping-workflow/best-rate-workflow-dto';
import {
  BACKEND_RATE_PROOF_SOURCE,
  finalizeBestRateWithQuote,
  selectedRateOpaqueKey,
  withSelectedRateKeys,
} from './shipping-workflow/rate-quote-snapshot-store';
import {
  readText,
  stampHugrabCoverageDisplayFields,
  stampRateBrowserDisplayAliases,
} from './rate-browser-display-fields';
import { resolveRateBrowseDestinationCountry } from './rate-browse-destination-country';

type RateBrowseBody = Record<string, any>;

export type ProduceRateBrowsePayloadInput = {
  body: RateBrowseBody;
  canViewFinancials: boolean;
  browseStartedAt?: number;
};

function browseSotWritebackEnabled(): boolean {
  return process.env.BROWSE_SOT_WRITEBACK === 'on';
}

function hugrabShippCustomsValueProofEnabled(): boolean {
  return process.env.HUGRAB_SHIPP_CUSTOMS_VALUE_PROOF === 'on';
}

function orderedCarrierIds(carrierIds: string[] | undefined, preferredCarrierId?: string): string[] | undefined {
  const unique = [...new Set((carrierIds ?? []).filter(Boolean))];
  if (!preferredCarrierId || !unique.includes(preferredCarrierId)) return unique.length ? unique : undefined;
  return [preferredCarrierId, ...unique.filter((carrierId) => carrierId !== preferredCarrierId)];
}

export async function produceRateBrowsePayload({
  body,
  canViewFinancials,
  browseStartedAt = Date.now(),
}: ProduceRateBrowsePayloadInput): Promise<Record<string, unknown>> {
  const {
    forceRefresh,
    forceLive,
    cachedOnly,
    carrierId,
    carrierIds,
    preferredCarrierId,
    signature,
    confirmation,
    ...rest
  } = body;
  const requestedCarrierIds = carrierIds?.length ? carrierIds : carrierId ? [carrierId] : undefined;
  const preferred = preferredCarrierId ?? carrierId ?? requestedCarrierIds?.[0];
  const orderedIds = orderedCarrierIds(requestedCarrierIds, preferred);
  let orderForBrowse: {
    sourceProvider: string | null;
    raw: unknown;
    shipToPostalCode: string | null;
    shipToState: string | null;
    shipToCity: string | null;
    clientId: number | null;
    storeId: number | null;
    orderNumber: string | null;
    clientName: string | null;
    externalOrderId: string | null;
  } | null = null;
  let residentialEvidence: ResidentialEvidence | null = null;
  if (body.orderId) {
    try {
      const [ord] = await db
        .select({
          sourceProvider: orders.sourceProvider,
          raw: orders.raw,
          shipToPostalCode: orders.shipToPostalCode,
          shipToState: orders.shipToState,
          shipToCity: orders.shipToCity,
          shipToName: orders.shipToName,
          clientId: orders.clientId,
          storeId: orders.storeId,
          orderNumber: orders.orderNumber,
          clientName: clients.name,
          externalOrderId: orders.externalOrderId,
        })
        .from(orders)
        .leftJoin(clients, eq(clients.id, orders.clientId))
        .where(eq(orders.id, body.orderId))
        .limit(1);
      if (ord) {
        orderForBrowse = ord;
        const [ovr] = await db
          .select({ residential: orderOverrides.residential })
          .from(orderOverrides)
          .where(eq(orderOverrides.orderId, body.orderId))
          .limit(1);
        const browseRawShipTo = ((ord.raw as { shipTo?: Record<string, unknown> } | null)?.shipTo) ?? {};
        const browseResolved = await resolveAddressClassification({
          street1: typeof browseRawShipTo.street1 === 'string' ? browseRawShipTo.street1 : null,
          city: typeof browseRawShipTo.city === 'string' ? browseRawShipTo.city : null,
          state: typeof browseRawShipTo.state === 'string' ? browseRawShipTo.state : null,
          postalCode: typeof browseRawShipTo.postalCode === 'string' ? browseRawShipTo.postalCode : null,
          country: typeof browseRawShipTo.country === 'string' ? browseRawShipTo.country : null,
        });
        residentialEvidence = buildResidentialEvidenceFromOrder({
          rawShipTo: (ord.raw as { shipTo?: unknown } | null)?.shipTo,
          manualOverrideResidential: ovr?.residential,
          shipToName: ord.shipToName,
          resolved: browseResolved,
        });
      }
    } catch (err) {
      console.warn('[rates/browse] order residential-evidence load skipped:', err instanceof Error ? err.message : err);
    }
  }
  const orderRawShipTo = ((orderForBrowse?.raw as { shipTo?: Record<string, unknown> } | null)?.shipTo) ?? {};
  const browseRateInput = {
    ...rest,
    toZip: rest.toZip ?? orderForBrowse?.shipToPostalCode ?? readText(orderRawShipTo.postalCode) ?? rest.toZip,
    toCountry: resolveRateBrowseDestinationCountry({
      requestedCountry: rest.toCountry,
      canonicalCountry: readText(orderRawShipTo.country),
    }),
    toState: rest.toState ?? orderForBrowse?.shipToState ?? readText(orderRawShipTo.state) ?? rest.toState,
    toCity: rest.toCity ?? orderForBrowse?.shipToCity ?? readText(orderRawShipTo.city) ?? rest.toCity,
    confirmation: confirmation ?? signature ?? null,
    carrierIds: orderedIds,
    sourceProvider: orderForBrowse?.sourceProvider ?? null,
    rawOrder: orderForBrowse?.raw ?? undefined,
    isEbayMarketplaceOrder: isEbayMarketplaceOrder({
      clientName: orderForBrowse?.clientName ?? null,
      sourceProvider: orderForBrowse?.sourceProvider ?? null,
      externalOrderId: orderForBrowse?.externalOrderId ?? (rest as { externalOrderId?: string | null }).externalOrderId ?? null,
      raw: orderForBrowse?.raw ?? null,
    }),
    externalOrderId: orderForBrowse?.externalOrderId ?? (rest as { externalOrderId?: string | null }).externalOrderId ?? null,
    orderNumber: orderForBrowse?.orderNumber ?? (rest as { orderNumber?: string | null }).orderNumber ?? null,
    ...(residentialEvidence ? residentialEvidenceRateInput(residentialEvidence, rest.toName) : {}),
  } as RateInput & Record<string, any>;
  const isCachedOnlyLookup = Boolean(cachedOnly && !forceRefresh && !forceLive);
  const resolvedForBrowse = await resolveRateInput(browseRateInput);
  let carrierEligibility: { mode: string; wouldBlock: boolean; ruleId?: string } | null = null;
  let shipStationBlocked = false;
  if (body.orderId && orderForBrowse) {
    try {
      const mode = await getCarrierEligibilityMode();
      const eligibility = evaluateOrderCarrierEligibility({
        carrierFamily: 'shipstation',
        order: orderForBrowse,
        mode,
      });
      carrierEligibility = {
        mode,
        wouldBlock: eligibility.wouldBlock,
        ...(eligibility.ruleId ? { ruleId: eligibility.ruleId } : {}),
      };
      if (eligibility.wouldBlock) {
        if (!eligibility.allowed) shipStationBlocked = true;
        else {
          console.warn(
            `[carrier-eligibility] AUDIT would-block browse: order=${body.orderId} source=${eligibility.orderSource} mode=${mode} rule=${eligibility.ruleId}`,
          );
        }
      }
    } catch {
      // Best-effort read path: the purchase boundary remains authoritative.
    }
  }
  const browseSingleFlightKey = buildRateBrowseSingleFlightKey({
    rateCacheKey: rateCacheKey(resolvedForBrowse),
    forceRefresh: Boolean(forceRefresh || forceLive),
    forceLive: Boolean(forceLive),
    cachedOnly: isCachedOnlyLookup,
    requestedCarrierIds,
    directContext: {
      orderId: body.orderId ?? null,
      externalOrderId: browseRateInput.externalOrderId ?? null,
      orderNumber: browseRateInput.orderNumber ?? null,
      purchaseOrderId: browseRateInput.purchaseOrderId ?? null,
      sourceProvider: browseRateInput.sourceProvider ?? null,
      isEbayMarketplaceOrder: browseRateInput.isEbayMarketplaceOrder ?? null,
      includeVisibleDirectCarriers: browseRateInput.includeVisibleDirectCarriers ?? null,
      includeAllDirectCarriers: browseRateInput.includeAllDirectCarriers ?? null,
      clientId: browseRateInput.clientId ?? null,
      storeId: browseRateInput.storeId ?? null,
      insuranceProvider: resolvedForBrowse.effectiveInsuranceProvider ?? rest.insuranceProvider ?? null,
      insuredValue: resolvedForBrowse.effectiveInsuredValue ?? rest.insuredValue ?? null,
      effectiveInsuranceSource: resolvedForBrowse.effectiveInsuranceSource ?? null,
    },
  });
  const limiterBefore = getRateEngineLimiterSnapshot();
  const { result, directRates, shipStationDurationMs, directCarrierDurationMs } = await runRateBrowseSingleFlight(
    browseSingleFlightKey,
    async () => {
      let shipStationDurationMs = 0;
      let directCarrierDurationMs = 0;
      const [result, directRates] = await Promise.all([
        (async () => {
          const startedAt = Date.now();
          const r = shipStationBlocked
            ? {
                rates: [],
                bestRate: null,
                cached: false,
                cacheKey: rateCacheKey(resolvedForBrowse),
                fetchedAt: new Date().toISOString(),
                carrierDiagnostics: [],
                effectiveInsuranceProvider: resolvedForBrowse.effectiveInsuranceProvider ?? null,
                effectiveInsuredValue: resolvedForBrowse.effectiveInsuredValue ?? null,
                effectiveInsuranceSource: resolvedForBrowse.effectiveInsuranceSource ?? null,
                residential: resolvedForBrowse.residential === true,
                residentialClassification: resolvedForBrowse.residentialClassification ?? null,
                residentialSource: resolvedForBrowse.residentialSource ?? null,
              }
            : await getRates(browseRateInput, {
                forceRefresh: forceRefresh || forceLive,
                cachedOnly: isCachedOnlyLookup,
                priority: 'interactive',
              });
          shipStationDurationMs = Date.now() - startedAt;
          return r;
        })(),
        (async () => {
          const startedAt = Date.now();
          const r = await getDirectCarrierRatesForRateInput({
            ...browseRateInput,
            confirmation: confirmation ?? signature ?? null,
            carrierIds: requestedCarrierIds,
            insuranceProvider: resolvedForBrowse.effectiveInsuranceProvider ?? rest.insuranceProvider ?? null,
            insuredValue: resolvedForBrowse.effectiveInsuredValue ?? rest.insuredValue ?? null,
            effectiveInsuranceProvider: resolvedForBrowse.effectiveInsuranceProvider ?? null,
            effectiveInsuredValue: resolvedForBrowse.effectiveInsuredValue ?? null,
            effectiveInsuranceSource: resolvedForBrowse.effectiveInsuranceSource ?? null,
          }, { cachedOnly: isCachedOnlyLookup, priority: 'interactive' });
          directCarrierDurationMs = Date.now() - startedAt;
          return r;
        })(),
      ]);
      return { result, directRates, shipStationDurationMs, directCarrierDurationMs };
    },
  );
  const limiterAfter = getRateEngineLimiterSnapshot();
  const requestedSet = requestedCarrierIds?.length ? new Set(requestedCarrierIds) : null;
  const filtered = shipStationBlocked
    ? []
    : requestedSet
      ? result.rates.filter((r) => requestedSet.has(r.carrier_id))
      : result.rates;
  const accounts = await getCarrierAccountsForRateContext({
    storeId: rest.storeId ?? null,
    clientId: rest.clientId ?? null,
  }).catch(() => []);
  const combined = combineCarrierUniverses({
    ssRates: filtered,
    ssCacheKey: result.cacheKey,
    ssCached: result.cached,
    ssDiagnostics: result.carrierDiagnostics ?? [],
    directRates: directRates.rates,
    directDiagnostics: directRates.diagnostics,
    requestedCarrierIds,
    accountNamesByCarrierId: new Map(
      accounts.map((account) => [
        account.carrier_id,
        account.friendly_name ?? account.nickname ?? account.carrier_code ?? account.carrier_id,
      ])
    ),
    accountCarrierIds: accounts.map((account) => account.carrier_id),
    isCachedOnlyLookup,
  });
  const {
    combinedRates,
    cheapest,
    secondCheapest,
    combinedRequestKey,
    combinedCarrierStatuses,
    directCarrierDiagnostics,
    combinedCarrierDiagnostics,
    bestRateComplete,
  } = combined;
  const bestRateMetadata = cheapest
    ? {
        ...cheapest,
        requestFingerprint: combinedRequestKey,
        cacheKey: combinedRequestKey,
        cacheCreatedAt: result.fetchedAt,
        cacheExpiresAt: new Date(
          new Date(result.fetchedAt).getTime() + CACHE_TTL_MS
        ).toISOString(),
        effectiveInsuranceProvider: result.effectiveInsuranceProvider,
        effectiveInsuredValue: result.effectiveInsuredValue,
        effectiveInsuranceSource: result.effectiveInsuranceSource,
        insuranceProvider: result.effectiveInsuranceProvider,
        insuredValue: result.effectiveInsuredValue,
        isComplete: bestRateComplete,
        rateCount: combinedRates.length,
        matchType: result.cached ? 'cache' : 'live',
      }
    : null;
  const browseCacheExpiresAt = new Date(
    new Date(result.fetchedAt).getTime() + CACHE_TTL_MS
  ).toISOString();
  let responseRates: Array<Record<string, unknown>> = withSelectedRateKeys(combinedRates);
  let rateQuoteId: string | undefined;
  let bestRateOut = cheapest;
  let secondBestRateOut: Record<string, unknown> | null = null;
  if (cheapest) {
    const finalized = await finalizeBestRateWithQuote({
      bestRate: cheapest as Record<string, unknown>,
      rates: combinedRates as Array<Record<string, unknown>>,
      cacheKey: combinedRequestKey,
      bestRateComplete,
      fetchedAt: result.fetchedAt,
    });
    rateQuoteId = finalized.rateQuoteId;
    responseRates = finalized.rates;
    const finalizedSecondBestRate = secondCheapest
      ? {
          ...(secondCheapest as Record<string, unknown>),
          selectedRateKey: selectedRateOpaqueKey(secondCheapest),
          ...(rateQuoteId ? { rateQuoteId } : {}),
          proofSource: BACKEND_RATE_PROOF_SOURCE,
        }
      : null;
    secondBestRateOut =
      finalizedSecondBestRate && bestRateComplete
        ? {
            ...finalizedSecondBestRate,
            isComplete: bestRateComplete,
            requestFingerprint: combinedRequestKey,
            cacheKey: combinedRequestKey,
            cacheCreatedAt: result.fetchedAt,
            cacheExpiresAt: browseCacheExpiresAt,
            effectiveInsuranceProvider: result.effectiveInsuranceProvider,
            effectiveInsuredValue: result.effectiveInsuredValue,
            effectiveInsuranceSource: result.effectiveInsuranceSource,
            insuranceProvider: result.effectiveInsuranceProvider,
            insuredValue: result.effectiveInsuredValue,
            eligibilityVersion: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
            rateCount: combinedRates.length,
            matchType: result.cached ? 'cache' : 'live',
          }
        : null;
    bestRateOut = {
      ...finalized.bestRate,
      secondBestRate: secondBestRateOut,
      isComplete: bestRateComplete,
      requestFingerprint: combinedRequestKey,
      cacheKey: combinedRequestKey,
      cacheCreatedAt: result.fetchedAt,
      cacheExpiresAt: browseCacheExpiresAt,
      effectiveInsuranceProvider: result.effectiveInsuranceProvider,
      effectiveInsuredValue: result.effectiveInsuredValue,
      effectiveInsuranceSource: result.effectiveInsuranceSource,
      insuranceProvider: result.effectiveInsuranceProvider,
      insuredValue: result.effectiveInsuredValue,
      eligibilityVersion: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
      rateCount: combinedRates.length,
      matchType: result.cached ? 'cache' : 'live',
    } as typeof cheapest;
  }
  if (bestRateOut && cheapest) {
    bestRateOut = await stampHouseTuple(bestRateOut as Record<string, unknown>, {
      cheapest,
      combinedRates,
      clientId: (rest as { clientId?: unknown }).clientId,
      storeId: (rest as { storeId?: unknown }).storeId,
      insuranceProvider: result.effectiveInsuranceProvider ?? null,
      insuredValue: result.effectiveInsuredValue ?? null,
    }) as typeof cheapest;
  }
  const hugrabCoverageDisplayContext = {
    isHugrab: isHugrabShippingContext({
      clientId: orderForBrowse?.clientId ?? rest.clientId ?? null,
      storeId: orderForBrowse?.storeId ?? rest.storeId ?? null,
    }),
    insuranceProvider: result.effectiveInsuranceProvider ?? null,
    insuredValue: result.effectiveInsuredValue ?? null,
    shippCustomsValueProofEnabled: hugrabShippCustomsValueProofEnabled(),
  };
  responseRates = responseRates.map((rate) =>
    stampHugrabCoverageDisplayFields(rate as Record<string, unknown>, hugrabCoverageDisplayContext),
  );
  responseRates = stampRateBrowserDisplayAliases(responseRates);
  if (bestRateOut) {
    bestRateOut = stampHugrabCoverageDisplayFields(
      bestRateOut as Record<string, unknown>,
      hugrabCoverageDisplayContext,
    ) as typeof cheapest;
  }
  if (secondBestRateOut) {
    secondBestRateOut = stampHugrabCoverageDisplayFields(
      secondBestRateOut,
      hugrabCoverageDisplayContext,
    );
    secondBestRateOut = stampRateBrowserDisplayAliases(secondBestRateOut);
    if (bestRateOut) {
      bestRateOut = {
        ...(bestRateOut as Record<string, unknown>),
        secondBestRate: secondBestRateOut,
      } as typeof cheapest;
    }
  }
  if (bestRateOut) {
    bestRateOut = stampRateBrowserDisplayAliases(bestRateOut) as typeof cheapest;
  }
  let manualEstimate: { rates: unknown[]; fetchedAt: string; cached: boolean } | null = null;
  if (body.manualEstimate === true) {
    try {
      const manual = await getRates(
        browseRateInput,
        {
          rawManualEstimate: true,
          forceRefresh: forceRefresh || forceLive,
          cachedOnly: Boolean(cachedOnly && !forceRefresh && !forceLive),
          priority: 'interactive',
        },
      );
      const manualFiltered = requestedSet
        ? manual.rates.filter((r) => requestedSet.has(r.carrier_id))
        : manual.rates;
      manualEstimate = {
        rates: canViewFinancials
          ? stampRateBrowserDisplayAliases(manualFiltered)
          : (redactRateBrowserMoney(stampRateBrowserDisplayAliases(manualFiltered)) as unknown[]),
        fetchedAt: manual.fetchedAt,
        cached: manual.cached,
      };
    } catch (err) {
      console.warn('[rates/browse] manual-estimate baseline failed (reference only):', err instanceof Error ? err.message : err);
    }
  }
  let strictRecalculation: Record<string, unknown> | null = null;
  if (body.strictRecalculate === true) {
    const bestProviderMatch = cheapest ? /^se-(\d+)$/i.exec(String(cheapest.carrier_id ?? '')) : null;
    const bestProviderId = bestProviderMatch ? Number.parseInt(bestProviderMatch[1]!, 10) : null;
    const strictDecision = planStrictRecalculateDecision({
      liveBestAmount: cheapest ? rateTotal(cheapest) : null,
      providerAccountId: bestProviderId != null && Number.isFinite(bestProviderId) ? bestProviderId : null,
      serviceCode: cheapest ? (String(cheapest.service_code ?? '').trim() || null) : null,
      carrierStatuses: combinedCarrierStatuses,
    });
    let persist: { persisted: boolean; reason?: string } = { persisted: false, reason: 'no orderId on request' };
    if (typeof body.orderId === 'number' && body.orderId > 0) {
      try {
        persist = await persistStrictRecalculateOutcome({
          orderId: body.orderId,
          decision: strictDecision,
          bestRate: (bestRateOut as Record<string, unknown> | null) ?? null,
          dimsL: body.dimsL ?? null,
          dimsW: body.dimsW ?? null,
          dimsH: body.dimsH ?? null,
          weightOz: body.weightOz ?? null,
          rateCount: combinedRates.length,
          fetchedAt: result.fetchedAt,
          requestFingerprint: combinedRequestKey,
          bestRateComplete,
        });
      } catch (err) {
        persist = { persisted: false, reason: err instanceof Error ? err.message.slice(0, 200) : 'persist failed' };
      }
    }
    strictRecalculation = {
      ...finalizeStrictRecalculationForResponse(strictDecision, persist),
      requestKey: combinedRequestKey,
    };
  } else if (
    browseSotWritebackEnabled() &&
    typeof body.orderId === 'number' && body.orderId > 0 &&
    bestRateOut != null && bestRateComplete && !result.cached
  ) {
    const reconcileMatch = cheapest ? /^se-(\d+)$/i.exec(String(cheapest.carrier_id ?? '')) : null;
    const reconcileProviderId = reconcileMatch ? Number.parseInt(reconcileMatch[1]!, 10) : null;
    const reconcileDecision = planStrictRecalculateDecision({
      liveBestAmount: cheapest ? rateTotal(cheapest) : null,
      providerAccountId: reconcileProviderId != null && Number.isFinite(reconcileProviderId) ? reconcileProviderId : null,
      serviceCode: cheapest ? (String(cheapest.service_code ?? '').trim() || null) : null,
      carrierStatuses: combinedCarrierStatuses,
    });
    if (reconcileDecision.action === 'apply') {
      try {
        await persistStrictRecalculateOutcome({
          orderId: body.orderId,
          decision: reconcileDecision,
          bestRate: (bestRateOut as Record<string, unknown> | null) ?? null,
          dimsL: body.dimsL ?? null,
          dimsW: body.dimsW ?? null,
          dimsH: body.dimsH ?? null,
          weightOz: body.weightOz ?? null,
          rateCount: combinedRates.length,
          fetchedAt: result.fetchedAt,
          requestFingerprint: combinedRequestKey,
          bestRateComplete,
        });
      } catch (err) {
        console.warn('[rates/browse] SOT reconcile write failed (best-effort):', err instanceof Error ? err.message : err);
      }
    }
  }
  const rateBrowseTiming = buildRateBrowseTimingDiagnostics({
    startedAtMs: browseStartedAt,
    completedAtMs: Date.now(),
    shipStationDurationMs,
    directCarrierDurationMs,
    carrierDiagnostics: combinedCarrierDiagnostics,
    rateEngineLimiter: {
      limiterBefore,
      limiterAfter,
    },
  });
  const rateBrowseFailure = buildRateBrowseFailureDiagnostic({
    ratesCount: responseRates.length,
    carriers: rateBrowseTiming.carriers,
  });
  return {
    ...result,
    ...(strictRecalculation ? { strictRecalculation } : {}),
    ...(manualEstimate ? { manualEstimate } : {}),
    requestKey: combinedRequestKey,
    cacheKey: combinedRequestKey,
    cacheExpiresAt: browseCacheExpiresAt,
    effectiveInsuranceProvider: result.effectiveInsuranceProvider,
    effectiveInsuredValue: result.effectiveInsuredValue,
    effectiveInsuranceSource: result.effectiveInsuranceSource,
    rateQuoteId,
    carrierEligibility,
    source: result.cached
      ? (!isCachedOnlyLookup && directRates.rates.length > 0 ? 'mixed' : 'cache')
      : 'live',
    cacheAgeMs: result.cacheAgeMs,
    rates: responseRates,
    bestRate: bestRateOut,
    secondBestRate: secondBestRateOut,
    carrierStatuses: combinedCarrierStatuses,
    carrierDiagnostics: combinedCarrierDiagnostics,
    rateBrowseTiming,
    rateBrowseFailure,
    bestRateWorkflow: buildBestRateWorkflowDto({
      currentRequestFingerprint: combinedRequestKey,
      backendRequestKey: combinedRequestKey,
      savedBestRate: bestRateMetadata,
      source: cheapest ? (result.cached ? 'cache' : 'live') : 'none',
      carrierStatuses: combinedCarrierStatuses,
    }),
    directCarrierErrors: directRates.errors,
    directCarrierMetas: directRates.metas,
    directCarrierDiagnostics,
  };
}
