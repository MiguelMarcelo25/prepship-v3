import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Archive,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  History,
  Loader2,
  Lock,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { api, qs, type Paginated } from "../../lib/api";
import Autosuggest, { type AutosuggestOption } from "../Autosuggest";
import { AutomationDangerousGoodsActionFields } from "./AutomationDangerousGoodsActionFields";
import { AutomationRowActions } from "./automations/AutomationRowActions";
import { filterRules } from "./automations/rule-search";
import {
  buildClientOptions,
  buildSkuOptions,
} from "./automations/suggestion-options";
import { parseRuleDocument } from "./automations/rule-document";
import {
  hasAmbiguousOrder,
  planRuleMove,
  sortRulesForDisplay,
} from "./automations/rule-ordering";

type AutomationTab = "rules" | "controls" | "runs" | "templates";

type CatalogField = {
  key: string;
  label: string;
  type: "number" | "boolean" | "string" | "string_array";
  operators: readonly string[];
};

type CatalogAction = {
  type: string;
  label: string;
  actionClass: string;
  risk: "low" | "medium" | "high";
  available: boolean;
  unavailableReason?: string;
  invalidatesRateProof: boolean;
};

type AutomationCatalog = {
  engineVersion: string;
  limits: { maxDepth: number; maxNodes: number; maxActions: number };
  triggers: Array<{ value: string; label: string }>;
  fields: CatalogField[];
  actions: CatalogAction[];
  prohibitedCapabilities: string[];
};

type RuleRow = {
  id: number;
  name: string;
  description: string | null;
  clientId: number | null;
  storeId: number | null;
  priority: number;
  position: number;
  trigger: string;
  status: "draft" | "active" | "paused" | "archived";
  draftRevision: number;
  systemLocked: boolean;
  provenance: string;
  updatedAt: string;
  activeVersion: null | {
    id: number;
    versionNumber: number;
    documentHash: string;
    publishedAt: string | null;
  };
};

type RunRow = {
  id: number;
  orderId: number | null;
  ruleId: number | null;
  trigger: string;
  mode: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  errorSummary: string | null;
};

type AvailabilityService = {
  serviceCode: string | null;
  name: string;
  allowed: boolean;
  disabled: boolean;
  locked: boolean;
  reason: string | null;
};

type AvailabilityCarrier = {
  carrierId: string | null;
  carrierCode: string | null;
  nickname: string | null;
  friendlyName: string | null;
  disabled: boolean;
  disabledReason: string | null;
  services: AvailabilityService[];
};

type AvailabilityRow = {
  store: { storeId: number; clientId: number; clientName: string };
  carriers: AvailabilityCarrier[];
};

type AutomationStoreOption = {
  storeId: number;
  clientId: number;
  clientName: string;
  active: boolean;
};

type AutomationSkuRow = {
  sku: string | null;
  name: string | null;
  clientId: number | null;
  /** Product thumbnail from the inventory read model, shown in suggestions. */
  imageUrl: string | null;
};

type BuilderCondition = {
  id: string;
  field: string;
  operator: string;
  value: string;
};
type BuilderAction = {
  id: string;
  type: string;
  value: string;
  provider?: "parcelguard" | "carrier";
  contactName: string;
  contactPhone: string;
};

type SimulationResult = {
  zeroWrites: boolean;
  zeroProviderCalls: boolean;
  draftHash: string;
  terminalAuditOnly: boolean;
  evaluation: {
    blocked: boolean;
    matches: Array<{
      ruleName: string;
      result: string;
      trace: { summary: string };
    }>;
    intents: Array<{ intentId: string; action: { type: string } }>;
  };
  reduction: {
    conflicts: Array<{ reason: string }>;
    plan: Record<string, unknown>;
  };
};

const TABS: Array<{ id: AutomationTab; label: string; icon: typeof Workflow }> =
  [
    { id: "rules", label: "Rules", icon: Workflow },
    { id: "controls", label: "Carrier & Service Controls", icon: Settings2 },
    { id: "runs", label: "Run History", icon: History },
    { id: "templates", label: "Templates & Actions", icon: Sparkles },
  ];

function statusTone(status: string): string {
  if (status === "active" || status === "completed")
    return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (status === "paused" || status === "blocked" || status === "conflict")
    return "bg-amber-50 text-amber-700 ring-amber-200";
  if (status === "archived" || status === "failed")
    return "bg-rose-50 text-rose-700 ring-rose-200";
  return "bg-surface-2 text-ink-2 ring-line";
}

function label(value: string): string {
  return value.replaceAll("_", " ").replaceAll(".", " ");
}

function operatorLabel(value: string): string {
  return (
    {
      eq: "Is equal to",
      neq: "Is not equal to",
      normalized_eq: "Is exactly",
      contains: "Contains",
      not_contains: "Does not contain",
      starts_with: "Starts with",
      in: "Is one of",
      gt: "Is greater than",
      gte: "Is at least",
      lt: "Is less than",
      lte: "Is at most",
    }[value] ?? label(value)
  );
}

function fieldLabel(field: CatalogField): string {
  return field.key === "line.sku" ? "Item SKU" : field.label;
}

function actionDefault(type: string): string {
  if (type === "tag.add") return "AUTOMATED";
  if (type === "hold.for_review") return "Automation requires operator review";
  if (type === "insurance.require") return "100";
  if (type === "confirmation.set") return "signature";
  return "";
}

function actionConfig(action: BuilderAction): Record<string, unknown> {
  const { type, value, provider } = action;
  if (type === "tag.add") return { tag: value };
  if (type === "hold.for_review") return { reason: value };
  if (type === "insurance.require")
    return {
      minimumValue: Number(value),
      provider: provider ?? "parcelguard",
      profileId: null,
    };
  if (type === "package.set") return { packagePresetId: value };
  if (type === "confirmation.set") return { confirmation: value };
  if (type === "carrier.exclude" || type === "service.exclude") {
    return {
      ids: value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    };
  }
  if (type === "carrier.prefer" || type === "service.prefer")
    return { id: value };
  if (type === "hazmat.add_declaration") {
    return {
      contactName: action.contactName,
      contactPhone: action.contactPhone,
    };
  }
  return {};
}

function typedConditionValue(
  field: CatalogField | undefined,
  value: string,
): unknown {
  if (field?.type === "number") return Number(value);
  if (field?.type === "boolean") return value === "true";
  return value;
}

function buildConditionDocument(
  conditions: BuilderCondition[],
  fields: CatalogField[],
) {
  const ordinary = conditions.filter(
    (condition) => !condition.field.startsWith("line."),
  );
  const line = conditions.filter((condition) =>
    condition.field.startsWith("line."),
  );
  const predicate = (condition: BuilderCondition) => ({
    kind: "predicate",
    field: condition.field,
    operator: condition.operator,
    value: typedConditionValue(
      fields.find((field) => field.key === condition.field),
      condition.value,
    ),
  });
  const children: unknown[] = ordinary.map(predicate);
  if (line.length > 0) {
    children.push({
      kind: "line_any",
      condition: { kind: "group", op: "all", children: line.map(predicate) },
    });
  }
  return { kind: "group", op: "all", children };
}

function ActionTypePicker({
  value,
  actions,
  index,
  onChange,
}: {
  value: string;
  actions: CatalogAction[];
  index: number;
  onChange: (value: string) => void;
}) {
  const selected = actions.find((action) => action.type === value);
  const [query, setQuery] = useState(selected?.label ?? "");
  const [open, setOpen] = useState(false);
  const listboxId = `automation-action-options-${index}`;
  const filtered = actions.filter((action) =>
    `${action.label} ${action.type}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const choose = (action: CatalogAction) => {
    if (!action.available) return;
    setQuery(action.label);
    setOpen(false);
    onChange(action.type);
  };

  return (
    <div className="relative">
      <label className="block text-tiny font-bold text-ink-2">
        Action Type
        <div className="relative mt-1.5">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            type="text"
            role="combobox"
            aria-label={`Action type ${index + 1}`}
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            value={query}
            onFocus={(event) => {
              setOpen(true);
              event.currentTarget.select();
            }}
            onBlur={() => setOpen(false)}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
              if (event.key === "Enter") {
                const firstAvailable = filtered.find((action) => action.available);
                if (firstAvailable) {
                  event.preventDefault();
                  choose(firstAvailable);
                }
              }
            }}
            className="h-10 w-full rounded-lg bg-surface pl-9 pr-3 text-small ring-1 ring-line outline-none focus:ring-2 focus:ring-brand/30"
          />
        </div>
      </label>
      {open ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-lg bg-surface p-1 shadow-xl ring-1 ring-line"
        >
          {filtered.length ? (
            filtered.map((action) => (
              <button
                type="button"
                role="option"
                aria-selected={action.type === value}
                key={action.type}
                disabled={!action.available}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(action)}
                className="flex w-full items-start justify-between gap-3 rounded-md px-3 py-2 text-left text-small text-ink hover:bg-brand-bg disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span>{action.label}</span>
                {!action.available ? (
                  <span className="text-[10px] font-bold uppercase text-ink-3">
                    Unavailable
                  </span>
                ) : null}
              </button>
            ))
          ) : (
            <div className="px-3 py-4 text-center text-small text-ink-3">
              No matching action
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function RulesPanel({
  rules,
  loading,
  query,
  setQuery,
  selected,
  setSelected,
  onNew,
  onEdit,
  onCopy,
  onDelete,
  onToggleActive,
  onRefresh,
  onStatus,
  onMove,
  showInactive,
  setShowInactive,
  busy,
}: {
  rules: RuleRow[];
  loading: boolean;
  query: string;
  setQuery: (value: string) => void;
  selected: RuleRow | null;
  setSelected: (rule: RuleRow) => void;
  onNew: () => void;
  onEdit: (rule: RuleRow) => void;
  onCopy: (rule: RuleRow) => void;
  onDelete: (rule: RuleRow) => void;
  onToggleActive: (rule: RuleRow) => void;
  onRefresh: () => void;
  onStatus: (rule: RuleRow, status: "pause" | "archive") => void;
  onMove: (rule: RuleRow, direction: "up" | "down") => void;
  showInactive: boolean;
  setShowInactive: (value: boolean) => void;
  busy: string | null;
}) {
  // Display order mirrors the backend ORDER BY, so what the operator sees is
  // the order the engine evaluates in.
  const ordered = sortRulesForDisplay(rules);
  // Archived rules are hidden by default, the way ShipStation hides inactive
  // rules until you ask for them.
  const visible = showInactive
    ? ordered
    : ordered.filter((rule) => rule.status !== "archived");
  const filtered = filterRules(visible, query);
  const ambiguousOrder = hasAmbiguousOrder(visible);
  const hiddenCount = ordered.length - visible.length;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section className="min-w-0 overflow-hidden rounded-xl bg-surface ring-1 ring-line shadow-sm">
        <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search rules by name, trigger, status, or scope"
              className="h-9 w-full rounded-lg bg-surface-2 pl-9 pr-3 text-small text-ink ring-1 ring-line outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>
          <label className="inline-flex shrink-0 items-center gap-2 text-small text-ink-2">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(event) => setShowInactive(event.target.checked)}
              className="h-4 w-4 rounded ring-1 ring-line"
            />
            Show inactive
            {!showInactive && hiddenCount > 0 ? (
              <span className="text-ink-3">({hiddenCount})</span>
            ) : null}
          </label>
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh rules"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-small font-bold text-ink-2 ring-1 ring-line hover:bg-surface-2"
          >
            <RefreshCcw size={14} /> Refresh
          </button>
          <button
            type="button"
            onClick={onNew}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-small font-bold text-white shadow-sm hover:bg-brand-dark"
          >
            <Plus size={15} /> New automation
          </button>
        </div>
        {ambiguousOrder ? (
          <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-3 text-tiny leading-5 text-amber-800">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              Two or more rules share the same priority, so their relative order
              is decided by creation order rather than by you. Use the arrows to
              set an explicit sequence.
            </span>
          </div>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-small">
            <thead className="bg-surface-2 text-[11px] uppercase tracking-wide text-ink-3">
              <tr>
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">Rule</th>
                <th className="px-4 py-3">Scope</th>
                <th className="px-4 py-3">Trigger</th>
                <th className="px-4 py-3">Last modified</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Active</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-ink-3">
                    <Loader2 className="mx-auto mb-2 animate-spin" /> Loading
                    rules
                  </td>
                </tr>
              ) : null}
              {!loading && filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-ink-3">
                    No automations match this view.
                  </td>
                </tr>
              ) : null}
              {filtered.map((rule, index) => (
                <tr
                  key={rule.id}
                  tabIndex={0}
                  aria-selected={selected?.id === rule.id}
                  onClick={() => setSelected(rule)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelected(rule);
                    }
                  }}
                  className={`cursor-pointer hover:bg-brand-bg/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${selected?.id === rule.id ? "bg-brand-bg/60" : ""}`}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="w-5 font-mono font-bold text-ink">
                        {index + 1}
                      </span>
                      <div className="flex flex-col">
                        <button
                          type="button"
                          aria-label={`Move ${rule.name} earlier`}
                          disabled={
                            index === 0 || rule.systemLocked || busy != null
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            onMove(rule, "up");
                          }}
                          className="text-ink-3 hover:text-ink disabled:opacity-30"
                        >
                          <ChevronUp size={14} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${rule.name} later`}
                          disabled={
                            index === filtered.length - 1 ||
                            rule.systemLocked ||
                            busy != null
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            onMove(rule, "down");
                          }}
                          className="text-ink-3 hover:text-ink disabled:opacity-30"
                        >
                          <ChevronDown size={14} />
                        </button>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-bold text-ink">{rule.name}</div>
                    <div className="mt-0.5 max-w-[360px] truncate text-tiny text-ink-3">
                      {rule.description || "No description"}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-ink-2">
                    {rule.clientId ? `Client ${rule.clientId}` : "Global"}
                    {rule.storeId ? ` · Store ${rule.storeId}` : ""}
                  </td>
                  <td className="px-4 py-3 text-ink-2">
                    {label(rule.trigger)}
                  </td>
                  <td className="px-4 py-3 text-ink-2">
                    {new Date(rule.updatedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-[11px] font-bold ring-1 ${statusTone(rule.status)}`}
                    >
                      {rule.systemLocked ? (
                        <Lock size={10} className="mr-1" />
                      ) : null}
                      {rule.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={rule.status === "active"}
                      aria-label={`${rule.status === "active" ? "Pause" : "Activate"} ${rule.name}`}
                      title={
                        rule.status === "draft"
                          ? "Publish this draft to activate it"
                          : rule.status === "archived"
                            ? "Archived rules cannot be reactivated"
                            : undefined
                      }
                      disabled={
                        rule.systemLocked ||
                        busy != null ||
                        rule.status === "draft" ||
                        rule.status === "archived"
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleActive(rule);
                      }}
                      className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${rule.status === "active" ? "bg-brand" : "bg-surface-3 ring-1 ring-line"}`}
                    >
                      <span
                        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${rule.status === "active" ? "left-[18px]" : "left-0.5"}`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <AutomationRowActions
                        ruleName={rule.name}
                        canEdit={!rule.systemLocked && rule.status === "draft"}
                        editDisabledReason={
                          rule.systemLocked
                            ? "System-locked rules cannot be edited"
                            : "Published versions are immutable. Copy this rule to change it."
                        }
                        canDelete={!rule.systemLocked}
                        deleteDisabledReason="System-locked rules cannot be deleted"
                        disabled={busy != null}
                        onEdit={() => onEdit(rule)}
                        onCopy={() => onCopy(rule)}
                        onDelete={() => onDelete(rule)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <aside className="rounded-xl bg-surface p-5 ring-1 ring-line shadow-sm">
        {selected ? (
          <div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-ink-3">
                  Selected rule
                </div>
                <h2 className="mt-1 text-lg font-extrabold text-ink">
                  {selected.name}
                </h2>
              </div>
              <ChevronRight className="text-ink-3" />
            </div>
            <p className="mt-3 text-small leading-6 text-ink-2">
              {selected.description || "No description provided."}
            </p>
            <dl className="mt-5 space-y-3 text-small">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-3">Priority</dt>
                <dd className="font-bold text-ink">{selected.priority}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-3">Trigger</dt>
                <dd className="font-bold text-ink">
                  {label(selected.trigger)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-3">Draft revision</dt>
                <dd className="font-bold text-ink">{selected.draftRevision}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-3">Provenance</dt>
                <dd className="font-bold text-ink">
                  {label(selected.provenance)}
                </dd>
              </div>
            </dl>
            <div className="mt-5 rounded-lg bg-amber-50 p-3 text-tiny leading-5 text-amber-800 ring-1 ring-amber-200">
              <div className="flex items-center gap-2 font-extrabold">
                <AlertTriangle size={14} /> Shipping safety
              </div>
              Published versions are immutable. Activation defaults to future
              orders only; reprocessing awaiting orders is a separate reviewed
              workflow.
            </div>
            {!selected.systemLocked && selected.status === "draft" ? (
              <button
                type="button"
                disabled={busy != null}
                onClick={() => onEdit(selected)}
                className="mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-brand text-small font-bold text-white shadow-sm hover:bg-brand-dark"
              >
                <Pencil size={14} /> Edit &amp; publish draft
              </button>
            ) : null}
            {!selected.systemLocked && selected.status !== "draft" ? (
              <div className="mt-4 rounded-lg bg-surface-2 p-3 text-tiny leading-5 text-ink-3 ring-1 ring-line">
                Published versions are immutable and the backend exposes no
                endpoint to reopen one as a draft, so this rule can only be
                paused or archived.
              </div>
            ) : null}
            {!selected.systemLocked && selected.status === "active" ? (
              <button
                type="button"
                disabled={busy != null}
                onClick={() => onStatus(selected, "pause")}
                className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg text-small font-bold text-amber-700 ring-1 ring-amber-200 hover:bg-amber-50"
              >
                <Pause size={14} /> Pause rule
              </button>
            ) : null}
            {!selected.systemLocked && selected.status !== "archived" ? (
              <button
                type="button"
                disabled={busy != null}
                onClick={() => onStatus(selected, "archive")}
                className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg text-small font-bold text-rose-700 ring-1 ring-rose-200 hover:bg-rose-50"
              >
                <Archive size={14} /> Archive rule
              </button>
            ) : null}
          </div>
        ) : (
          <div className="flex h-full min-h-[320px] flex-col items-center justify-center text-center text-ink-3">
            <Workflow size={32} className="mb-3" />
            <div className="font-bold text-ink">Select a rule</div>
            <p className="mt-1 max-w-[230px] text-small">
              Inspect its immutable version, scope, and safety status.
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

function Builder({
  catalog,
  stores,
  editRule,
  onClose,
  onCreated,
}: {
  catalog: AutomationCatalog;
  stores: AutomationStoreOption[];
  /** When set, the builder edits this rule's existing draft instead of creating one. */
  editRule: RuleRow | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const firstField = catalog.fields[0];
  const firstAvailableAction = catalog.actions.find((action) => action.available);
  // A new rule starts blank, the way ShipStation's rule builder does. Seeding a
  // specific customer's hazmat rule here made every new automation start as a
  // copy of HUGRAB's.
  const [activeRule, setActiveRule] = useState(true);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [trigger, setTrigger] = useState("order_imported");
  const [priority, setPriority] = useState("100");
  const [clientId, setClientId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [conditions, setConditions] = useState<BuilderCondition[]>([
    {
      id: crypto.randomUUID(),
      field: firstField?.key ?? "order.store_id",
      operator: firstField?.operators[0] ?? "eq",
      value: "",
    },
  ]);
  const [actions, setActions] = useState<BuilderAction[]>([
    {
      id: crypto.randomUUID(),
      type: firstAvailableAction?.type ?? "tag.add",
      value: actionDefault(firstAvailableAction?.type ?? "tag.add"),
      provider: "parcelguard",
      contactName: "",
      contactPhone: "",
    },
  ]);
  const [unknownPolicy, setUnknownPolicy] = useState<"no_match" | "block">(
    "no_match",
  );
  const selectedStoreCondition = conditions.find(
    (condition) => condition.field === "order.store_id" && condition.value,
  );
  const selectedSuggestionStore = stores.find(
    (store) => String(store.storeId) === selectedStoreCondition?.value,
  );
  // A Client condition narrows the SKU list just as much as a Store condition
  // does. Without this, setting "Client is equal to HUGRAB" still offered every
  // client's SKUs, so the operator could pick an item HUGRAB does not sell.
  const selectedClientCondition = conditions.find(
    (condition) => condition.field === "order.client_id" && condition.value,
  );
  const conditionClientId = Number(selectedClientCondition?.value);
  // Most specific signal wins: store condition, then client condition, then
  // the rule's own scope.
  const suggestionClientId =
    selectedSuggestionStore?.clientId ??
    (Number.isFinite(conditionClientId) && conditionClientId > 0
      ? conditionClientId
      : null) ??
    (clientId && Number.isFinite(Number(clientId)) ? Number(clientId) : null);
  /** Name of the client the SKU list is currently narrowed to, if any. */
  const suggestionClientName =
    selectedSuggestionStore?.clientName ??
    stores.find((store) => store.clientId === suggestionClientId)?.clientName ??
    null;
  const skuRowsQuery = useQuery({
    queryKey: ["automations", "sku-suggestions", suggestionClientId ?? "all"],
    queryFn: async () =>
      (
        await api.get<Paginated<AutomationSkuRow>>(
          `/inventory${qs({
            clientId: suggestionClientId ?? undefined,
            pageSize: 2000,
            active: true,
          })}`,
        )
      ).data,
    staleTime: 5 * 60_000,
  });
  const skuOptions = useMemo<AutosuggestOption[]>(
    () =>
      buildSkuOptions(
        skuRowsQuery.data ?? [],
        selectedSuggestionStore?.clientName,
      ),
    [selectedSuggestionStore?.clientName, skuRowsQuery.data],
  );
  const clientOptions = useMemo<AutosuggestOption[]>(
    () => buildClientOptions(stores),
    [stores],
  );
  const [draft, setDraft] = useState<{
    ruleId: number;
    revision: number;
  } | null>(null);
  const [simulationOrderId, setSimulationOrderId] = useState("");
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** JSON of the document as last saved; null means nothing saved yet. */
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  /** Seeds the clean-state baseline: true on first render and after hydration. */
  const seedSnapshotRef = useRef(true);

  // Editing an existing rule: pull its open draft version and refill the form.
  // Without this the builder could only ever create, so any draft that survived
  // its creation session was unreachable and could never be published.
  const editRuleQuery = useQuery({
    queryKey: ["automations", "rule", editRule?.id ?? 0],
    enabled: editRule != null,
    queryFn: async () =>
      (
        await api.get<{
          data: {
            rule: RuleRow;
            versions: Array<{
              id: number;
              lifecycle: string;
              draftRevision: number;
              document: unknown;
            }>;
          };
        }>(`/automations/${editRule?.id}`)
      ).data,
  });

  const hydratedRef = useRef<number | null>(null);
  useEffect(() => {
    const loaded = editRuleQuery.data;
    if (!editRule || !loaded) return;
    if (hydratedRef.current === editRule.id) return;
    const draftVersion = loaded.versions.find(
      (version) => version.lifecycle === "draft",
    );
    if (!draftVersion) {
      setError(
        "This rule has no open draft. Published versions are immutable, and the backend has no endpoint to reopen one.",
      );
      hydratedRef.current = editRule.id;
      return;
    }
    const parsed = parseRuleDocument(draftVersion.document);
    if (!parsed) {
      setError("Could not read this rule's draft document.");
      hydratedRef.current = editRule.id;
      return;
    }
    setName(parsed.name);
    setDescription(parsed.description);
    setTrigger(parsed.trigger);
    setPriority(parsed.priority);
    setClientId(parsed.clientId);
    setStoreId(parsed.storeId);
    setUnknownPolicy(parsed.unknownPolicy);
    if (parsed.conditions.length > 0) setConditions(parsed.conditions);
    if (parsed.actions.length > 0) setActions(parsed.actions);
    setDraft({ ruleId: editRule.id, revision: draftVersion.draftRevision });
    // Freshly loaded state is unmodified by definition. `document` is a memo
    // of the state set above, so it is still stale here -- flag it and let the
    // effect below snapshot once the recomputed document is available.
    seedSnapshotRef.current = true;
    hydratedRef.current = editRule.id;
  }, [editRule, editRuleQuery.data]);

  const document = useMemo(
    () => ({
      schemaVersion: 1 as const,
      name,
      description: description || null,
      trigger,
      priority: Number(priority),
      position: 0,
      unknownPolicy,
      scope: {
        clientIds: clientId ? [Number(clientId)] : [],
        storeIds: storeId ? [Number(storeId)] : [],
      },
      condition: buildConditionDocument(conditions, catalog.fields),
      actions: actions.map((action) => ({
        type: action.type,
        schemaVersion: 1,
        config: actionConfig(action),
      })),
    }),
    [
      actions,
      catalog.fields,
      clientId,
      conditions,
      description,
      name,
      priority,
      storeId,
      trigger,
      unknownPolicy,
    ],
  );

  /**
   * Client-side pre-checks for the few required fields, so the operator gets
   * a pointed message instead of a backend validation rejection. The backend
   * still validates everything -- this only avoids a round trip that ends in
   * a message written for a schema rather than a person.
   */
  const draftBlockReason = (): string | null => {
    if (!name.trim()) return "Give the automation a name before saving.";
    if (conditions.length === 0) return "Add at least one condition.";
    const emptyCondition = conditions.findIndex((item) => !item.value.trim());
    if (emptyCondition !== -1) {
      return `Condition ${emptyCondition + 1} needs a value.`;
    }
    if (actions.length === 0) return "Add at least one action.";
    return null;
  };

  const saveDraft = async () => {
    const blocked = draftBlockReason();
    if (blocked) {
      setError(blocked);
      return;
    }
    setBusy("save");
    setError(null);
    try {
      if (!draft) {
        const response = await api.post<{
          data: { rule: { id: number }; version: { draftRevision: number } };
        }>("/automations", { document });
        setDraft({
          ruleId: response.data.rule.id,
          revision: response.data.version.draftRevision,
        });
      } else {
        const response = await api.put<{
          data: { version: { draftRevision: number } };
        }>(
          `/automations/${draft.ruleId}/draft`,
          { document },
          { headers: { "If-Match": String(draft.revision) } },
        );
        setDraft({
          ruleId: draft.ruleId,
          revision: response.data.version.draftRevision,
        });
      }
      setSimulation(null);
      setSavedSnapshot(JSON.stringify(document));
      onCreated();
      // Saving is a natural stopping point, so the panel gets out of the way.
      // Publishing needs a Test run against the saved draft, so reopen with
      // the Edit action on the row when you are ready to publish.
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Draft save failed");
    } finally {
      setBusy(null);
    }
  };

  const simulate = async () => {
    if (!draft) {
      setError("Save the draft before testing the rule.");
      return;
    }
    const orderId = Number(simulationOrderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      setError("Enter a valid order ID.");
      return;
    }
    setBusy("simulate");
    setError(null);
    try {
      const response = await api.post<{ data: SimulationResult }>(
        `/automations/${draft.ruleId}/simulate`,
        { orderId },
        { headers: { "If-Match": String(draft.revision) } },
      );
      setSimulation(response.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Simulation failed");
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    if (!draft || !simulation) return;
    setBusy("publish");
    setError(null);
    try {
      await api.post(
        `/automations/${draft.ruleId}/publish`,
        { simulationHash: simulation.draftHash },
        { headers: { "If-Match": String(draft.revision) } },
      );
      onCreated();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Publish failed");
    } finally {
      setBusy(null);
    }
  };

  // Escape closes the panel, matching the backdrop click and the X button.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestCloseRef.current();
    };
    globalThis.document.addEventListener("keydown", onKeyDown);
    return () => globalThis.document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Establish the clean baseline once the derived document is current -- on
  // first open for a new rule, and again after an existing draft hydrates.
  useEffect(() => {
    if (seedSnapshotRef.current) {
      seedSnapshotRef.current = false;
      setSavedSnapshot(JSON.stringify(document));
    }
  }, [document]);

  /**
   * Snapshot of the document as last persisted. Anything different means the
   * operator has edits that closing would throw away.
   */
  const isDirty =
    savedSnapshot != null && JSON.stringify(document) !== savedSnapshot;

  /**
   * Closing routes through here so a stray backdrop click or Escape cannot
   * silently discard work. A clean panel just closes.
   */
  const requestClose = () => {
    if (busy != null) return;
    if (
      isDirty &&
      !globalThis.confirm(
        "Close the builder? Unsaved changes to this automation will be lost.",
      )
    ) {
      return;
    }
    onClose();
  };

  // Keeps the Escape listener (registered once) pointed at the latest closure,
  // so it always sees current dirty/busy state instead of first-render values.
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  const publishBlockReason = !activeRule
    ? "Turn on Active Rule to publish."
    : !draft
      ? "Save the draft, enter a test order ID, then run Test rule."
      : !simulation
        ? "Enter a test order ID and run Test rule before publishing."
        : simulation.evaluation.blocked
          ? "The test is blocked. Review the test result before publishing."
          : simulation.reduction.conflicts.length > 0
            ? "Resolve the test conflicts before publishing."
            : null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-stretch justify-end bg-black/30 backdrop-blur-sm"
      // Clicking the dimmed backdrop closes the panel. The check keeps this
      // from firing when a click inside the panel bubbles up here.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Automation guided builder"
        className="flex h-full w-full max-w-[980px] flex-col bg-page shadow-2xl"
      >
        <header className="flex items-center gap-4 border-b border-line bg-surface px-5 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-bg text-brand ring-1 ring-brand-border">
            <Workflow size={20} />
          </div>
          <div className="flex-1">
            <div className="text-lg font-extrabold text-ink">
              Guided Builder
            </div>
            <div className="text-tiny text-ink-3">
              Build the rule in one screen, then test and publish.
            </div>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close builder"
            className="rounded-lg p-2 text-ink-3 hover:bg-surface-2"
          >
            <X size={20} />
          </button>
        </header>
        <div className="border-b border-line bg-surface px-5 py-3">
          <div className="mx-auto flex max-w-xl items-center gap-3 rounded-lg bg-surface px-4 py-3 ring-1 ring-line">
            <span className="rounded-full px-2 py-0.5 text-[10px] font-bold text-ink-2 ring-1 ring-line">
              When
            </span>
            <select
              aria-label="Automation trigger"
              value={trigger}
              onChange={(event) => setTrigger(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-small font-bold text-ink outline-none"
            >
              {catalog.triggers.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <CheckCircle2 size={17} className="shrink-0 text-emerald-600" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-7">
          <div className="mx-auto max-w-4xl">
            <section className="overflow-visible rounded-xl bg-surface shadow-sm ring-2 ring-brand/30">
              <div className="grid gap-4 border-b border-line p-4 sm:grid-cols-[minmax(0,1fr)_180px]">
                <label className="block text-small font-bold text-ink">
                  Summary
                  <input
                    aria-label="Summary"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Name this automation"
                    className="mt-2 h-10 w-full rounded-lg bg-surface px-3 ring-1 ring-line outline-none focus:ring-2 focus:ring-brand/30"
                  />
                </label>
                <div>
                  <div className="text-small font-bold text-ink">
                    Active Rule
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-label="Active rule"
                    aria-checked={activeRule}
                    onClick={() => setActiveRule((value) => !value)}
                    className={`mt-3 flex h-6 w-11 items-center rounded-full p-0.5 transition-colors ${activeRule ? "bg-brand" : "bg-ink-3/40"}`}
                  >
                    <span
                      className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${activeRule ? "translate-x-5" : "translate-x-0"}`}
                    />
                  </button>
                  <p className="mt-2 text-tiny text-ink-3">
                    {activeRule
                      ? "Publishes after the required test passes."
                      : "Save as draft without publishing."}
                  </p>
                </div>
              </div>

              <details className="border-b border-line px-4 py-3">
                <summary className="cursor-pointer text-small font-bold text-ink-2">
                  Advanced options
                </summary>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label className="text-small font-bold text-ink sm:col-span-2">
                    Description
                    <textarea
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      rows={2}
                      className="mt-2 w-full rounded-lg bg-surface p-3 ring-1 ring-line outline-none focus:ring-2 focus:ring-brand/30"
                    />
                  </label>
                  <label className="text-small font-bold text-ink">
                    Priority
                    <input
                      type="number"
                      min="0"
                      value={priority}
                      onChange={(event) => setPriority(event.target.value)}
                      className="mt-2 h-10 w-full rounded-lg bg-surface px-3 ring-1 ring-line"
                    />
                  </label>
                  <label className="text-small font-bold text-ink">
                    Client ID (blank = global)
                    <input
                      type="number"
                      value={clientId}
                      onChange={(event) => setClientId(event.target.value)}
                      className="mt-2 h-10 w-full rounded-lg bg-surface px-3 ring-1 ring-line"
                    />
                  </label>
                  <label className="text-small font-bold text-ink">
                    Store ID (optional)
                    <input
                      type="number"
                      value={storeId}
                      onChange={(event) => setStoreId(event.target.value)}
                      className="mt-2 h-10 w-full rounded-lg bg-surface px-3 ring-1 ring-line"
                    />
                  </label>
                  <label className="text-small font-bold text-ink">
                    Incomplete facts
                    <select
                      value={unknownPolicy}
                      onChange={(event) =>
                        setUnknownPolicy(
                          event.target.value as "no_match" | "block",
                        )
                      }
                      className="mt-2 h-10 w-full rounded-lg bg-surface px-3 ring-1 ring-line"
                    >
                      <option value="no_match">Treat unknown as no match</option>
                      <option value="block">
                        Block rate/purchase until complete
                      </option>
                    </select>
                  </label>
                </div>
              </details>

              <div className="space-y-4 border-b border-line p-4">
                <div className="flex items-center gap-2">
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-bold text-ink-2 ring-1 ring-line">
                    If
                  </span>
                  <span className="text-small font-bold text-ink">
                    Orders match all of these specific criteria
                  </span>
                </div>
                {conditions.map((condition, index) => {
                  const field = catalog.fields.find(
                    (item) => item.key === condition.field,
                  );
                  return (
                    <div
                      key={condition.id}
                      className="grid gap-3 rounded-xl bg-surface p-4 ring-1 ring-line sm:grid-cols-[1fr_160px_1fr_auto]"
                    >
                      <select
                        aria-label={`Condition ${index + 1} field`}
                        value={condition.field}
                        onChange={(event) => {
                          const next = catalog.fields.find(
                            (item) => item.key === event.target.value,
                          );
                          setConditions((current) =>
                            current.map((item) =>
                              item.id === condition.id
                                ? {
                                    ...item,
                                    field: event.target.value,
                                    operator: next?.operators[0] ?? "eq",
                                    value: "",
                                  }
                                : item,
                            ),
                          );
                        }}
                        className="h-10 rounded-lg px-3 ring-1 ring-line"
                      >
                        {catalog.fields.map((item) => (
                          <option key={item.key} value={item.key}>
                            {fieldLabel(item)}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={`Condition ${index + 1} operator`}
                        value={condition.operator}
                        onChange={(event) =>
                          setConditions((current) =>
                            current.map((item) =>
                              item.id === condition.id
                                ? { ...item, operator: event.target.value }
                                : item,
                            ),
                          )
                        }
                        className="h-10 rounded-lg px-3 ring-1 ring-line"
                      >
                        {field?.operators.map((operator) => (
                          <option key={operator} value={operator}>
                            {operatorLabel(operator)}
                          </option>
                        ))}
                      </select>
                      {field?.key === "order.store_id" ? (
                        <select
                          aria-label={`Condition ${index + 1} value`}
                          value={condition.value}
                          onChange={(event) =>
                            setConditions((current) =>
                              current.map((item) =>
                                item.id === condition.id
                                  ? { ...item, value: event.target.value }
                                  : item,
                              ),
                            )
                          }
                          className="h-10 rounded-lg px-3 ring-1 ring-line"
                        >
                          <option value="">Choose a store…</option>
                          {stores.map((store) => (
                            <option key={store.storeId} value={store.storeId}>
                              {store.clientName}
                            </option>
                          ))}
                        </select>
                      ) : field?.key === "order.client_id" ? (
                        // The rule stores a numeric client id, but the operator
                        // should never have to read or recognise one. A select
                        // shows the name while the id stays the stored value --
                        // same pattern as the Store field above.
                        <select
                          aria-label={`Condition ${index + 1} value`}
                          value={condition.value}
                          onChange={(event) =>
                            setConditions((current) =>
                              current.map((item) =>
                                item.id === condition.id
                                  ? { ...item, value: event.target.value }
                                  : item,
                              ),
                            )
                          }
                          className="h-10 rounded-lg px-3 ring-1 ring-line"
                        >
                          <option value="">Choose a client…</option>
                          {clientOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.primaryText ?? option.label}
                            </option>
                          ))}
                          {/* An id saved before this list loaded (or from a
                              client no longer listed) must stay selectable, or
                              reopening the draft would silently clear it. */}
                          {condition.value &&
                          !clientOptions.some(
                            (option) => option.value === condition.value,
                          ) ? (
                            <option value={condition.value}>
                              Client {condition.value}
                            </option>
                          ) : null}
                        </select>
                      ) : field?.key === "line.sku" ? (
                        <Autosuggest
                          value={condition.value}
                          options={skuOptions}
                          ariaLabel={`Condition ${index + 1} value`}
                          placeholder={
                            suggestionClientName
                              ? `Search ${suggestionClientName} SKUs`
                              : "Search SKU or product name"
                          }
                          inputClassName="h-10 w-full rounded-lg bg-surface px-3 text-small ring-1 ring-line outline-none focus:ring-2 focus:ring-brand/30"
                          popoverClassName="left-0 right-0"
                          maxResults={10}
                          emptyMessage={
                            skuRowsQuery.isError
                              ? "SKU suggestions could not be loaded. You can still type the SKU."
                              : condition.value.trim()
                                ? `No ${suggestionClientName ?? ""} SKU matches "${condition.value.trim()}"`.replace(
                                    /\s+/g,
                                    " ",
                                  )
                                : suggestionClientName
                                  ? `Showing ${suggestionClientName} SKUs only`
                                  : "Type to search by SKU or product name"
                          }
                          onChange={(value) =>
                            setConditions((current) =>
                              current.map((item) =>
                                item.id === condition.id
                                  ? { ...item, value }
                                  : item,
                              ),
                            )
                          }
                        />
                      ) : field?.type === "boolean" ? (
                        <select
                          aria-label={`Condition ${index + 1} value`}
                          value={condition.value}
                          onChange={(event) =>
                            setConditions((current) =>
                              current.map((item) =>
                                item.id === condition.id
                                  ? { ...item, value: event.target.value }
                                  : item,
                              ),
                            )
                          }
                          className="h-10 rounded-lg px-3 ring-1 ring-line"
                        >
                          <option value="">Choose…</option>
                          <option value="true">True</option>
                          <option value="false">False</option>
                        </select>
                      ) : (
                        <input
                          aria-label={`Condition ${index + 1} value`}
                          type={field?.type === "number" ? "number" : "text"}
                          value={condition.value}
                          onChange={(event) =>
                            setConditions((current) =>
                              current.map((item) =>
                                item.id === condition.id
                                  ? { ...item, value: event.target.value }
                                  : item,
                              ),
                            )
                          }
                          placeholder="Value"
                          className="h-10 rounded-lg px-3 ring-1 ring-line"
                        />
                      )}
                      <button
                        type="button"
                        aria-label={`Remove condition ${index + 1}`}
                        onClick={() =>
                          setConditions((current) =>
                            current.filter((item) => item.id !== condition.id),
                          )
                        }
                        className="rounded-lg p-2 text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={() =>
                    setConditions((current) => [
                      ...current,
                      {
                        id: crypto.randomUUID(),
                        field: firstField?.key ?? "order.client_id",
                        operator: firstField?.operators[0] ?? "eq",
                        value: "",
                      },
                    ])
                  }
                  className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-small font-bold text-brand ring-1 ring-brand-border hover:bg-brand-bg"
                >
                  <Plus size={14} /> Add condition
                </button>
              </div>
              <div className="space-y-4 p-4">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 rounded-full px-2 py-0.5 text-[10px] font-bold text-ink-2 ring-1 ring-line">
                    Then
                  </span>
                  <div>
                    <div className="text-small font-bold text-ink">
                      Apply the following actions
                    </div>
                    <p className="mt-1 text-tiny text-ink-3">
                      Choose what should happen when the order matches. No
                      postage is purchased here.
                    </p>
                  </div>
                </div>
                {actions.map((action, index) => {
                  const definition = catalog.actions.find(
                    (item) => item.type === action.type,
                  );
                  return (
                    <div
                      key={action.id}
                      className="grid gap-3 rounded-lg bg-surface-2/60 p-3 ring-1 ring-line sm:grid-cols-[minmax(220px,1fr)_minmax(0,2fr)_auto]"
                    >
                      <ActionTypePicker
                        value={action.type}
                        actions={catalog.actions}
                        index={index}
                        onChange={(type) =>
                          setActions((current) =>
                            current.map((item) =>
                              item.id === action.id
                                ? {
                                    ...item,
                                    type,
                                    value: actionDefault(type),
                                    provider: "parcelguard",
                                    contactName: "",
                                    contactPhone: "",
                                  }
                                : item,
                            ),
                          )
                        }
                      />
                      {action.type === "hazmat.add_declaration" ? (
                        <AutomationDangerousGoodsActionFields
                          contactName={action.contactName}
                          contactPhone={action.contactPhone}
                          onChange={(value) =>
                            setActions((current) =>
                              current.map((item) =>
                                item.id === action.id ? { ...item, ...value } : item,
                              ),
                            )
                          }
                        />
                      ) : action.type === "confirmation.set" ? (
                        <label className="text-tiny font-bold text-ink-2">
                          Confirmation
                          <select
                            value={action.value}
                            onChange={(event) =>
                              setActions((current) =>
                                current.map((item) =>
                                  item.id === action.id
                                    ? { ...item, value: event.target.value }
                                    : item,
                                ),
                              )
                            }
                            className="mt-1.5 h-10 w-full rounded-lg px-3 ring-1 ring-line"
                          >
                            <option value="none">None</option>
                            <option value="delivery">Delivery</option>
                            <option value="signature">Signature</option>
                            <option value="adult_signature">
                              Adult signature
                            </option>
                          </select>
                        </label>
                      ) : action.type === "insurance.require" ? (
                        <div className="grid gap-2 sm:grid-cols-[1fr_150px]">
                          <label className="text-tiny font-bold text-ink-2">
                            Minimum value
                            <input
                              type="number"
                              min="0"
                              value={action.value}
                              onChange={(event) =>
                                setActions((current) =>
                                  current.map((item) =>
                                    item.id === action.id
                                      ? { ...item, value: event.target.value }
                                      : item,
                                  ),
                                )
                              }
                              className="mt-1.5 h-10 w-full rounded-lg px-3 ring-1 ring-line"
                            />
                          </label>
                          <label className="text-tiny font-bold text-ink-2">
                            Provider
                            <select
                              aria-label="Insurance provider"
                              value={action.provider ?? "parcelguard"}
                              onChange={(event) =>
                                setActions((current) =>
                                  current.map((item) =>
                                    item.id === action.id
                                      ? {
                                          ...item,
                                          provider: event.target.value as
                                            | "parcelguard"
                                            | "carrier",
                                        }
                                      : item,
                                  ),
                                )
                              }
                              className="mt-1.5 h-10 w-full rounded-lg px-3 ring-1 ring-line"
                            >
                              <option value="parcelguard">ParcelGuard</option>
                              <option value="carrier">Carrier</option>
                            </select>
                          </label>
                        </div>
                      ) : (
                        <label className="text-tiny font-bold text-ink-2">
                          Value
                          <input
                            type="text"
                            aria-label={`Action value ${index + 1}`}
                            value={action.value}
                            onChange={(event) =>
                              setActions((current) =>
                                current.map((item) =>
                                  item.id === action.id
                                    ? { ...item, value: event.target.value }
                                    : item,
                                ),
                              )
                            }
                            placeholder="Action value"
                            className="mt-1.5 h-10 w-full rounded-lg px-3 ring-1 ring-line"
                          />
                        </label>
                      )}
                      <button
                        type="button"
                        aria-label={`Remove action ${index + 1}`}
                        onClick={() =>
                          setActions((current) =>
                            current.filter((item) => item.id !== action.id),
                          )
                        }
                        className="rounded-lg p-2 text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 size={16} />
                      </button>
                      <div className="sm:col-span-3 flex flex-wrap gap-2 text-[11px]">
                        <span
                          className={`rounded-full px-2 py-1 ring-1 ${definition?.risk === "high" ? "bg-amber-50 text-amber-700 ring-amber-200" : "bg-surface-2 text-ink-2 ring-line"}`}
                        >
                          {definition?.risk === "high"
                            ? "Safety-sensitive action"
                            : `${definition?.risk} risk`}
                        </span>
                        {definition?.invalidatesRateProof ? (
                          <span className="rounded-full bg-brand-bg px-2 py-1 text-brand ring-1 ring-brand-border">
                            Shipping rate will be rechecked
                          </span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    const next = catalog.actions.find((item) => item.available);
                    if (next)
                      setActions((current) => [
                        ...current,
                        {
                          id: crypto.randomUUID(),
                          type: next.type,
                          value: actionDefault(next.type),
                          provider: "parcelguard",
                          contactName: "",
                          contactPhone: "",
                        },
                      ]);
                  }}
                  className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-small font-bold text-brand ring-1 ring-brand-border hover:bg-brand-bg"
                >
                  <Plus size={14} /> Add action
                </button>
              </div>
            </section>

            <div className="mx-auto h-7 w-px bg-line" />

            <section className="space-y-5 rounded-xl bg-surface p-5 shadow-sm ring-1 ring-line">
                <div>
                  <h2 className="text-xl font-extrabold text-ink">
                    Test before publishing
                  </h2>
                  <p className="mt-1 text-small text-ink-3">
                    Use a test order. This checks the rule without buying
                    postage or changing the order.
                  </p>
                </div>
                <div className="rounded-xl bg-surface p-5 ring-1 ring-line">
                  <div className="font-extrabold text-ink">
                    {name || "Untitled automation"}
                  </div>
                  <div className="mt-2 text-small text-ink-2">
                    When {conditions.length} condition
                    {conditions.length === 1 ? "" : "s"} match on{" "}
                    {label(trigger)}, plan {actions.length} action
                    {actions.length === 1 ? "" : "s"}.
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {actions.map((action) => (
                      <span
                        key={action.id}
                        className="rounded-full bg-brand-bg px-2.5 py-1 text-[11px] font-bold text-brand ring-1 ring-brand-border"
                      >
                        {label(action.type)}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl bg-surface p-5 ring-1 ring-line">
                  <label className="text-small font-bold text-ink">
                    Test order ID
                    <div className="mt-2 flex gap-2">
                      <input
                        type="number"
                        value={simulationOrderId}
                        onChange={(event) =>
                          setSimulationOrderId(event.target.value)
                        }
                        className="h-10 min-w-0 flex-1 rounded-lg px-3 ring-1 ring-line"
                      />
                      <button
                        type="button"
                        disabled={busy != null || !draft || !simulationOrderId}
                        onClick={simulate}
                        className="inline-flex h-10 items-center gap-2 rounded-lg bg-ink px-4 text-small font-bold text-white disabled:opacity-50"
                      >
                        {busy === "simulate" ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Play size={14} />
                        )}{" "}
                        Test rule
                      </button>
                    </div>
                  </label>
                  {!draft ? (
                    <p className="mt-2 text-tiny text-amber-700">
                      Save the draft before testing the rule.
                    </p>
                  ) : null}
                </div>
                {simulation ? (
                  <div
                    className={`rounded-xl p-5 ring-1 ${simulation.evaluation.blocked || simulation.reduction.conflicts.length ? "bg-amber-50 text-amber-900 ring-amber-200" : "bg-emerald-50 text-emerald-900 ring-emerald-200"}`}
                  >
                    <div className="flex items-center gap-2 font-extrabold">
                      {simulation.evaluation.blocked ? (
                        <AlertTriangle size={17} />
                      ) : (
                        <CheckCircle2 size={17} />
                      )}{" "}
                      Test result
                    </div>
                    <div className="mt-2 text-small">
                      {simulation.evaluation.matches
                        .map((match) => `${match.ruleName}: ${match.result}`)
                        .join(" · ") || "No matching rule"}{" "}
                      · {simulation.evaluation.intents.length} planned actions ·{" "}
                      {simulation.reduction.conflicts.length} conflicts.
                    </div>
                    <div className="mt-2 font-mono text-[10px]">
                      Draft hash {simulation.draftHash}
                    </div>
                    <div className="mt-2 text-[11px] font-bold">
                      {simulation.zeroWrites
                        ? "Order unchanged"
                        : "Order changes detected"}{" "}
                      ·{" "}
                      {simulation.zeroProviderCalls
                        ? "No provider calls"
                        : "Provider calls detected"}
                      {simulation.terminalAuditOnly
                        ? " · terminal audit-only"
                        : ""}
                    </div>
                  </div>
                ) : null}
                <div className="rounded-xl bg-amber-50 p-4 text-small leading-6 text-amber-900 ring-1 ring-amber-200">
                  <div className="font-extrabold">Future orders only</div>
                  Publishing does not reprocess current awaiting orders. That
                  requires a separate preview, confirmation, and bounded worker
                  job. Shipped/cancelled orders remain audit-only.
                </div>
            </section>

            <div className="mx-auto h-7 w-px bg-line" />
            <div className="mx-auto flex max-w-xl items-center justify-between rounded-lg bg-surface px-4 py-3 text-small font-bold text-ink-2 ring-1 ring-line">
              <span>Automation Complete</span>
              <CheckCircle2 size={17} className="text-emerald-600" />
            </div>
            {error ? (
              <div className="mt-5 rounded-lg bg-rose-50 p-3 text-small font-bold text-rose-700 ring-1 ring-rose-200">
                {error}
              </div>
            ) : null}
          </div>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface px-5 py-4">
          <button
            type="button"
            onClick={saveDraft}
            disabled={busy != null}
            className="inline-flex h-10 items-center gap-2 rounded-lg px-4 text-small font-bold text-ink ring-1 ring-line hover:bg-surface-2 disabled:opacity-50"
          >
            {busy === "save" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : null}
            Save draft
          </button>
          <div className="ml-auto flex max-w-md flex-col items-end gap-1.5">
            <div
              id="publish-rule-status"
              className={`text-right text-tiny font-bold ${publishBlockReason ? "text-amber-700" : "text-emerald-700"}`}
            >
              {publishBlockReason ?? "Test passed. Ready to publish."}
            </div>
            <button
              type="button"
              aria-describedby="publish-rule-status"
              disabled={
                !activeRule ||
                !simulation ||
                simulation.evaluation.blocked ||
                simulation.reduction.conflicts.length > 0 ||
                busy != null
              }
              onClick={publish}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand px-4 text-small font-bold text-white disabled:opacity-40"
            >
              {busy === "publish" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ShieldCheck size={15} />
              )}{" "}
              Publish rule
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function ControlsPanel({
  rows,
  loading,
  refresh,
}: {
  rows: AvailabilityRow[];
  loading: boolean;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [expandedStoreId, setExpandedStoreId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const toggle = async (
    row: AvailabilityRow,
    carrier: AvailabilityCarrier,
    service?: AvailabilityService,
  ) => {
    const key = service
      ? `${row.store.storeId}:${carrier.carrierId}:${service.serviceCode}`
      : `${row.store.storeId}:${carrier.carrierId}`;
    setBusy(key);
    try {
      if (service)
        await api.patch("/automations/controls/service", {
          clientId: row.store.clientId,
          storeId: row.store.storeId,
          carrierId: carrier.carrierId,
          carrierCode: carrier.carrierCode,
          serviceCode: service.serviceCode,
          serviceName: service.name,
          disabled: !service.disabled,
          reason: service.disabled
            ? null
            : "Service disabled by Automations workspace.",
        });
      else
        await api.patch("/automations/controls/carrier", {
          clientId: row.store.clientId,
          storeId: row.store.storeId,
          carrierId: carrier.carrierId,
          carrierCode: carrier.carrierCode,
          disabled: !carrier.disabled,
          reason: carrier.disabled
            ? null
            : "Carrier disabled by Automations workspace.",
        });
      await queryClient.invalidateQueries({
        queryKey: ["automations", "availability"],
      });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="rounded-xl bg-surface p-5 ring-1 ring-line shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-extrabold text-ink">
            Carrier & Service Controls
          </h2>
          <p className="mt-1 text-small text-ink-3">
            Typed backend controls are authoritative here. HUGRAB protected
            controls remain locked, and legacy settings are no longer read.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="rounded-lg p-2 text-ink-2 ring-1 ring-line hover:bg-surface-2"
        >
          <RefreshCcw size={15} />
        </button>
      </div>
      {loading ? (
        <div className="py-12 text-center text-ink-3">
          <Loader2 className="mx-auto animate-spin" />
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <p className="text-small text-ink-3">
            {rows.length} client store{rows.length === 1 ? "" : "s"}. Choose a
            client to view its carriers and services.
          </p>
          {rows.map((row) => {
            const expanded = expandedStoreId === row.store.storeId;
            return (
            <div
              key={row.store.storeId}
              className="overflow-hidden rounded-xl ring-1 ring-line"
            >
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={`automation-store-controls-${row.store.storeId}`}
                onClick={() =>
                  setExpandedStoreId((current) =>
                    current === row.store.storeId ? null : row.store.storeId,
                  )
                }
                className="flex w-full items-center justify-between gap-4 bg-surface-2 px-4 py-3 text-left hover:bg-brand-bg"
              >
                <span>
                  <span className="block font-extrabold text-ink">
                    {row.store.clientName}
                  </span>
                  <span className="block text-tiny text-ink-3">
                    Client {row.store.clientId} · Store {row.store.storeId} ·{" "}
                    {row.carriers.length} carrier
                    {row.carriers.length === 1 ? "" : "s"}
                  </span>
                </span>
                <ChevronRight
                  size={17}
                  className={`shrink-0 text-ink-3 transition-transform ${expanded ? "rotate-90" : ""}`}
                />
              </button>
              {expanded ? (
              <div
                id={`automation-store-controls-${row.store.storeId}`}
                className="divide-y divide-line"
              >
                {row.carriers.map((carrier) => {
                  const carrierKey = `${row.store.storeId}:${carrier.carrierId}`;
                  return (
                    <div
                      key={
                        carrier.carrierId ??
                        carrier.carrierCode ??
                        carrier.nickname
                      }
                      className="p-4"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-bold text-ink">
                            {carrier.nickname ||
                              carrier.friendlyName ||
                              carrier.carrierCode}
                          </div>
                          <div className="text-tiny text-ink-3">
                            {carrier.carrierCode} · {carrier.carrierId}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={busy != null}
                          onClick={() => toggle(row, carrier)}
                          className={`rounded-full px-3 py-1 text-[11px] font-bold ring-1 ${carrier.disabled ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200"}`}
                        >
                          {busy === carrierKey
                            ? "Saving…"
                            : carrier.disabled
                              ? "Disabled"
                              : "Enabled"}
                        </button>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                        {carrier.services.map((service) => {
                          const serviceKey = `${row.store.storeId}:${carrier.carrierId}:${service.serviceCode}`;
                          return (
                            <button
                              type="button"
                              key={service.serviceCode ?? service.name}
                              disabled={service.locked || busy != null}
                              onClick={() => toggle(row, carrier, service)}
                              title={service.reason ?? undefined}
                              className={`flex min-h-10 items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-tiny font-bold ring-1 ${service.locked ? "cursor-not-allowed bg-brand-bg text-brand ring-brand-border" : service.disabled ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-surface text-ink-2 ring-line hover:bg-surface-2"}`}
                            >
                              <span>{service.name}</span>
                              {service.locked ? (
                                <Lock size={12} />
                              ) : busy === serviceKey ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : service.disabled ? (
                                <X size={12} />
                              ) : (
                                <CheckCircle2 size={12} />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              ) : null}
            </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function AutomationsView() {
  const [tab, setTab] = useState<AutomationTab>("rules");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<RuleRow | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editRule, setEditRule] = useState<RuleRow | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const catalogQuery = useQuery({
    queryKey: ["automations", "catalog"],
    queryFn: async () =>
      (await api.get<{ data: AutomationCatalog }>("/automations/catalog")).data,
  });
  const storesQuery = useQuery({
    queryKey: ["automations", "stores"],
    queryFn: async () =>
      (await api.get<{ data: AutomationStoreOption[] }>("/init/stores")).data,
  });
  const rulesQuery = useQuery({
    queryKey: ["automations", "rules"],
    queryFn: async () =>
      (await api.get<{ data: RuleRow[] }>("/automations")).data,
  });
  const runsQuery = useQuery({
    queryKey: ["automations", "runs"],
    enabled: tab === "runs",
    queryFn: async () =>
      (await api.get<{ data: RunRow[] }>("/automations/runs?limit=100")).data,
  });
  const availabilityQuery = useQuery({
    queryKey: ["automations", "availability"],
    enabled: tab === "controls",
    queryFn: async () =>
      (
        await api.get<{ data: AvailabilityRow[] }>("/automations/controls", {
          timeoutMs: 20_000,
        })
      ).data,
  });

  const changeStatus = async (rule: RuleRow, action: "pause" | "archive") => {
    setBusy(`${action}:${rule.id}`);
    try {
      await api.post(`/automations/${rule.id}/${action}`, {});
      setSelected(null);
      await queryClient.invalidateQueries({
        queryKey: ["automations", "rules"],
      });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Duplicate a rule as a fresh draft. Built from the existing read + create
   * endpoints -- the copy is a new draft document, so it inherits none of the
   * original's published state or history.
   */
  const copyRule = async (rule: RuleRow) => {
    setBusy(`copy:${rule.id}`);
    setOrderError(null);
    try {
      const detail = (
        await api.get<{
          data: {
            versions: Array<{
              lifecycle: string;
              versionNumber: number;
              document: Record<string, unknown>;
            }>;
          };
        }>(`/automations/${rule.id}`)
      ).data;
      // Prefer the live published version; fall back to the open draft.
      const source =
        detail.versions.find((version) => version.lifecycle === "published") ??
        detail.versions.find((version) => version.lifecycle === "draft");
      if (!source) {
        setOrderError("This rule has no version to copy.");
        return;
      }
      await api.post("/automations", {
        document: { ...source.document, name: `${rule.name} (copy)` },
      });
      await queryClient.invalidateQueries({
        queryKey: ["automations", "rules"],
      });
    } catch (caught) {
      setOrderError(caught instanceof Error ? caught.message : "Copy failed");
    } finally {
      setBusy(null);
    }
  };

  /**
   * Delete is refused by the backend for any rule that already took effect --
   * published versions, run history, and reprocess jobs are protected by
   * onDelete: 'restrict'. Surface that reason rather than a bare failure.
   */
  const deleteRule = async (rule: RuleRow) => {
    if (
      !globalThis.confirm(
        `Delete "${rule.name}"? This cannot be undone. Rules that have already run must be archived instead.`,
      )
    ) {
      return;
    }
    setBusy(`delete:${rule.id}`);
    setOrderError(null);
    try {
      await api.delete(`/automations/${rule.id}`);
      setSelected(null);
      await queryClient.invalidateQueries({
        queryKey: ["automations", "rules"],
      });
    } catch (caught) {
      setOrderError(caught instanceof Error ? caught.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  };

  /** Active toggle maps to pause; reactivating a paused rule republishes it. */
  const toggleActive = async (rule: RuleRow) => {
    if (rule.status === "active") {
      await changeStatus(rule, "pause");
      return;
    }
    setOrderError(
      `"${rule.name}" is paused. Reactivating needs a republish, which the backend only exposes through the draft publish flow.`,
    );
  };

  /**
   * Reorder by rewriting each affected rule's draft priority. The backend only
   * accepts priority through a draft document (PUT /:id/draft requires an open
   * draft), so published rules cannot currently be resequenced -- surfaced to
   * the operator rather than silently skipped.
   */
  const moveRule = async (rule: RuleRow, direction: "up" | "down") => {
    const changes = planRuleMove(rulesQuery.data ?? [], rule.id, direction);
    if (changes.length === 0) return;
    const rulesById = new Map((rulesQuery.data ?? []).map((row) => [row.id, row]));
    setBusy(`move:${rule.id}`);
    setOrderError(null);
    try {
      for (const change of changes) {
        const target = rulesById.get(change.ruleId);
        if (!target || target.systemLocked) continue;
        if (target.status !== "draft") {
          setOrderError(
            `"${target.name}" is published, and published versions are immutable. Reordering it needs a backend endpoint to reopen a draft.`,
          );
          continue;
        }
        const detail = (
          await api.get<{
            data: {
              versions: Array<{
                lifecycle: string;
                draftRevision: number;
                document: Record<string, unknown>;
              }>;
            };
          }>(`/automations/${change.ruleId}`)
        ).data;
        const draftVersion = detail.versions.find(
          (version) => version.lifecycle === "draft",
        );
        if (!draftVersion) continue;
        await api.put(
          `/automations/${change.ruleId}/draft`,
          {
            document: {
              ...draftVersion.document,
              priority: change.priority,
              position: change.position,
            },
          },
          { headers: { "If-Match": String(draftVersion.draftRevision) } },
        );
      }
      await queryClient.invalidateQueries({
        queryKey: ["automations", "rules"],
      });
    } catch (caught) {
      setOrderError(
        caught instanceof Error ? caught.message : "Reordering failed",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-testid="automations-scroll"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-page p-4 sm:p-6"
    >
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.14em] text-brand">
            <Bot size={14} /> Backend-owned workflow policy
          </div>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">
            Automations
          </h1>
          <p className="mt-1 max-w-3xl text-small text-ink-3">
            Versioned declarative rules with deterministic simulation, explicit
            conflicts, immutable publishing, and explainable history.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-tiny text-ink-2 ring-1 ring-line">
          <Activity size={14} className="text-emerald-600" />
          <span>{catalogQuery.data?.engineVersion ?? "Loading engine…"}</span>
        </div>
      </div>
      <div
        role="tablist"
        aria-label="Automation workspace sections"
        className="mb-4 flex shrink-0 gap-1 overflow-x-auto rounded-xl bg-surface p-1 ring-1 ring-line"
      >
        {TABS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-small font-bold transition-colors ${tab === item.id ? "bg-brand text-white shadow-sm" : "text-ink-2 hover:bg-surface-2"}`}
            >
              <Icon size={14} />
              {item.label}
            </button>
          );
        })}
      </div>
      {orderError ? (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-lg bg-rose-50 p-3 text-small text-rose-800 ring-1 ring-rose-200"
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{orderError}</span>
        </div>
      ) : null}
      {tab === "rules" ? (
        <RulesPanel
          rules={rulesQuery.data ?? []}
          loading={rulesQuery.isPending}
          query={query}
          setQuery={setQuery}
          selected={selected}
          setSelected={setSelected}
          onNew={() => {
            setEditRule(null);
            setBuilderOpen(true);
          }}
          onEdit={(rule) => {
            setEditRule(rule);
            setBuilderOpen(true);
          }}
          onCopy={(rule) => void copyRule(rule)}
          onDelete={(rule) => void deleteRule(rule)}
          onToggleActive={(rule) => void toggleActive(rule)}
          onRefresh={() => void rulesQuery.refetch()}
          onStatus={(rule, action) => void changeStatus(rule, action)}
          onMove={(rule, direction) => void moveRule(rule, direction)}
          showInactive={showInactive}
          setShowInactive={setShowInactive}
          busy={busy}
        />
      ) : null}
      {tab === "controls" ? (
        <ControlsPanel
          rows={availabilityQuery.data ?? []}
          loading={availabilityQuery.isPending}
          refresh={() => void availabilityQuery.refetch()}
        />
      ) : null}
      {tab === "runs" ? (
        <section className="overflow-hidden rounded-xl bg-surface ring-1 ring-line shadow-sm">
          <div className="border-b border-line p-5">
            <h2 className="text-lg font-extrabold text-ink">Run History</h2>
            <p className="mt-1 text-small text-ink-3">
              Simulation, apply, conflict, and terminal audit-only traces.
            </p>
          </div>
          <div className="divide-y divide-line">
            {runsQuery.isPending ? (
              <div className="p-10 text-center text-ink-3">
                <Loader2 className="mx-auto animate-spin" />
              </div>
            ) : null}
            {(runsQuery.data ?? []).map((run) => (
              <div
                key={run.id}
                className="grid gap-2 p-4 text-small sm:grid-cols-[100px_1fr_160px_160px]"
              >
                <span
                  className={`w-fit rounded-full px-2 py-1 text-[11px] font-bold ring-1 ${statusTone(run.status)}`}
                >
                  {run.status}
                </span>
                <div>
                  <div className="font-bold text-ink">
                    Run #{run.id} · {label(run.trigger)}
                  </div>
                  <div className="text-tiny text-ink-3">
                    Order {run.orderId ?? "simulation"} · Rule{" "}
                    {run.ruleId ?? "bundle"}
                  </div>
                </div>
                <div className="text-ink-2">{run.mode}</div>
                <div className="text-ink-3">
                  <Clock3 size={12} className="mr-1 inline" />
                  {new Date(run.startedAt).toLocaleString()}
                </div>
              </div>
            ))}
            {!runsQuery.isPending && (runsQuery.data ?? []).length === 0 ? (
              <div className="p-12 text-center text-ink-3">
                No persisted runs yet. Pure simulations intentionally write no
                run rows.
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      {tab === "templates" ? (
        <section className="rounded-xl bg-surface p-5 ring-1 ring-line shadow-sm">
          <h2 className="text-lg font-extrabold text-ink">Action Registry</h2>
          <p className="mt-1 text-small text-ink-3">
            The backend catalog is authoritative. Unavailable dependencies
            cannot be selected or published.
          </p>
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(catalogQuery.data?.actions ?? []).map((action) => (
              <div
                key={action.type}
                className={`rounded-xl p-4 ring-1 ${action.available ? "bg-surface ring-line" : "bg-surface-2 ring-line"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-extrabold text-ink">{action.label}</div>
                  {action.available ? (
                    <CheckCircle2 size={16} className="text-emerald-600" />
                  ) : (
                    <Lock size={16} className="text-amber-600" />
                  )}
                </div>
                <div className="mt-2 text-tiny text-ink-3">
                  {action.type} · {action.actionClass} · {action.risk} risk
                </div>
                {action.unavailableReason ? (
                  <div className="mt-3 rounded-lg bg-amber-50 p-2 text-tiny text-amber-800 ring-1 ring-amber-200">
                    {action.unavailableReason}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <div className="mt-5 rounded-xl bg-rose-50 p-4 text-small text-rose-800 ring-1 ring-rose-200">
            <div className="font-extrabold">
              Never available to generic automation
            </div>
            <div className="mt-2">
              {catalogQuery.data?.prohibitedCapabilities.join(" · ")}
            </div>
          </div>
        </section>
      ) : null}
      {builderOpen && catalogQuery.data && storesQuery.data ? (
        <Builder
          key={editRule?.id ?? "new"}
          catalog={catalogQuery.data}
          stores={storesQuery.data}
          editRule={editRule}
          onClose={() => {
            setBuilderOpen(false);
            setEditRule(null);
          }}
          onCreated={() =>
            void queryClient.invalidateQueries({
              queryKey: ["automations", "rules"],
            })
          }
        />
      ) : null}
    </div>
  );
}
