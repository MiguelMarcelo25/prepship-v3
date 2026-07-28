import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  automationRuleActions,
  automationRuleConditions,
  automationRules,
} from '../../db/schema/automations.js';

/**
 * Whether a client is targeted by any live hazmat automation.
 *
 * This widens VISIBILITY only. If an operator wrote a rule that declares
 * dangerous goods for a client, the hazmat block and badge should appear on
 * that client's orders without anyone editing an env var -- otherwise the rule
 * silently does something the order screen never shows.
 *
 * It deliberately does NOT grant authority. Rating and purchasing hazmat stay
 * gated on HAZMAT_RATE_ENABLED / HAZMAT_PURCHASE_ENABLED and the canary list,
 * which only an operator with Render access can change. A rule edit can change
 * what is displayed; it can never authorise postage. That split is the point:
 * automations:write is a far wider permission than "may enable a money path".
 *
 * Scope is read from two places because a rule can be scoped either way:
 *  - the rule row (client_id set when the rule targets one client), or
 *  - an order.client_id condition inside the published version, which is how
 *    the HUGRAB HU-10 rule is written -- its rule row is global.
 */
export async function clientHasHazmatAutomation(
  clientId: number | null | undefined,
): Promise<boolean> {
  if (clientId == null || !Number.isFinite(clientId)) return false;

  const rows = await db
    .select({ ruleId: automationRules.id })
    .from(automationRules)
    .innerJoin(
      automationRuleActions,
      and(
        eq(automationRuleActions.ruleVersionId, automationRules.activeVersionId),
        eq(automationRuleActions.actionType, 'hazmat.add_declaration'),
      ),
    )
    .leftJoin(
      automationRuleConditions,
      and(
        eq(automationRuleConditions.ruleVersionId, automationRules.activeVersionId),
        eq(automationRuleConditions.fieldKey, 'order.client_id'),
      ),
    )
    .where(
      and(
        eq(automationRules.status, 'active'),
        or(
          // Scoped on the rule row.
          eq(automationRules.clientId, clientId),
          // Scoped by an order.client_id condition inside the document.
          sql`${automationRuleConditions.typedValue}::text = ${String(clientId)}`,
          // Genuinely unscoped: no rule-row client and no client condition.
          and(isNull(automationRules.clientId), isNull(automationRuleConditions.id)),
        ),
      ),
    )
    .limit(1);

  return rows.length > 0;
}
