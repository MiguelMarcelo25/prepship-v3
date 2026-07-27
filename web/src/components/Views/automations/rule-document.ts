/**
 * Reads a stored automation rule document back into builder form state.
 *
 * The backend owns the canonical document shape, validation, and compilation.
 * This module only reverses the serialisation the builder already performs
 * (buildConditionDocument / actionConfig in AutomationsView) so an existing
 * draft can be reopened for editing instead of being stranded.
 *
 * Anything this parser cannot recognise is dropped rather than guessed at --
 * a silently mangled condition would be worse than an obviously missing one,
 * and the backend rejects malformed documents on save regardless.
 */

export type ParsedCondition = {
  id: string;
  field: string;
  operator: string;
  value: string;
};

/**
 * Mirrors BuilderAction in AutomationsView: the contact fields are always
 * present (empty string when unused) so the parsed result drops straight into
 * builder state without widening its types.
 */
export type ParsedAction = {
  id: string;
  type: string;
  value: string;
  provider?: "parcelguard" | "carrier";
  contactName: string;
  contactPhone: string;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function newId(): string {
  return crypto.randomUUID();
}

/** Scalars arrive typed (number/boolean/string); the builder edits them as text. */
function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function parsePredicate(node: UnknownRecord): ParsedCondition | null {
  const field = node.field;
  const operator = node.operator;
  if (typeof field !== "string" || typeof operator !== "string") return null;
  return { id: newId(), field, operator, value: asText(node.value) };
}

/**
 * Flattens the group/line_any tree the builder emits back into the flat
 * condition list it edits. Line predicates are hoisted out of their
 * line_any wrapper; the builder re-wraps them on save by field prefix.
 */
export function parseConditionDocument(document: unknown): ParsedCondition[] {
  const out: ParsedCondition[] = [];
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (node.kind === "predicate") {
      const parsed = parsePredicate(node);
      if (parsed) out.push(parsed);
      return;
    }
    if (node.kind === "line_any" || node.kind === "line_all" || node.kind === "line_none") {
      visit(node.condition);
      return;
    }
    if (node.kind === "group" && Array.isArray(node.children)) {
      node.children.forEach(visit);
    }
  };
  visit(document);
  return out;
}

/** Inverse of actionConfig() -- turns a stored config back into builder fields. */
export function parseActionDocument(actions: unknown): ParsedAction[] {
  if (!Array.isArray(actions)) return [];
  const out: ParsedAction[] = [];
  for (const entry of actions) {
    if (!isRecord(entry) || typeof entry.type !== "string") continue;
    const type = entry.type;
    const config = isRecord(entry.config) ? entry.config : {};
    const base: ParsedAction = {
      id: newId(),
      type,
      value: "",
      contactName: "",
      contactPhone: "",
    };

    if (type === "tag.add") base.value = asText(config.tag);
    else if (type === "hold.for_review") base.value = asText(config.reason);
    else if (type === "insurance.require") {
      base.value = asText(config.minimumValue);
      base.provider = config.provider === "carrier" ? "carrier" : "parcelguard";
    } else if (type === "package.set") base.value = asText(config.packagePresetId);
    else if (type === "confirmation.set") base.value = asText(config.confirmation);
    else if (type === "carrier.exclude" || type === "service.exclude") {
      base.value = asText(config.ids);
    } else if (type === "carrier.prefer" || type === "service.prefer") {
      base.value = asText(config.id);
    } else if (type === "hazmat.add_declaration") {
      base.contactName = asText(config.contactName);
      base.contactPhone = asText(config.contactPhone);
    }
    out.push(base);
  }
  return out;
}

export type ParsedRuleDraft = {
  name: string;
  description: string;
  trigger: string;
  priority: string;
  clientId: string;
  storeId: string;
  unknownPolicy: "no_match" | "block";
  conditions: ParsedCondition[];
  actions: ParsedAction[];
};

/**
 * Scope is stored as id arrays (see AutomationRuleDocument.scope in
 * src/services/automations/contracts.ts). The builder edits a single
 * client/store pair, so take the first entry of each.
 */
function firstScopeId(scope: unknown, key: "clientIds" | "storeIds"): string {
  if (!isRecord(scope)) return "";
  const ids = scope[key];
  if (!Array.isArray(ids) || ids.length === 0) return "";
  return asText(ids[0]);
}

/** Hydrates the full builder form from a stored draft document. */
export function parseRuleDocument(document: unknown): ParsedRuleDraft | null {
  if (!isRecord(document)) return null;
  return {
    name: typeof document.name === "string" ? document.name : "",
    description: typeof document.description === "string" ? document.description : "",
    trigger: typeof document.trigger === "string" ? document.trigger : "order_imported",
    priority: asText(document.priority ?? 100),
    clientId: firstScopeId(document.scope, "clientIds"),
    storeId: firstScopeId(document.scope, "storeIds"),
    unknownPolicy: document.unknownPolicy === "block" ? "block" : "no_match",
    conditions: parseConditionDocument(document.condition),
    actions: parseActionDocument(document.actions),
  };
}
