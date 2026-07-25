import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Archive,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock3,
  History,
  Loader2,
  Lock,
  Pause,
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
import { api } from "../../lib/api";
import { AutomationDangerousGoodsActionFields } from "./AutomationDangerousGoodsActionFields";

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

function RulesPanel({
  rules,
  loading,
  query,
  setQuery,
  selected,
  setSelected,
  onNew,
  onRefresh,
  onStatus,
  busy,
}: {
  rules: RuleRow[];
  loading: boolean;
  query: string;
  setQuery: (value: string) => void;
  selected: RuleRow | null;
  setSelected: (rule: RuleRow) => void;
  onNew: () => void;
  onRefresh: () => void;
  onStatus: (rule: RuleRow, status: "pause" | "archive") => void;
  busy: string | null;
}) {
  const filtered = rules.filter((rule) =>
    `${rule.name} ${rule.description ?? ""} ${rule.trigger}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
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
              placeholder="Search rules, triggers, or actions"
              className="h-9 w-full rounded-lg bg-surface-2 pl-9 pr-3 text-small text-ink ring-1 ring-line outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>
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
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-small">
            <thead className="bg-surface-2 text-[11px] uppercase tracking-wide text-ink-3">
              <tr>
                <th className="px-4 py-3">Priority</th>
                <th className="px-4 py-3">Rule</th>
                <th className="px-4 py-3">Scope</th>
                <th className="px-4 py-3">Trigger</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Version</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-ink-3">
                    <Loader2 className="mx-auto mb-2 animate-spin" /> Loading
                    rules
                  </td>
                </tr>
              ) : null}
              {!loading && filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-ink-3">
                    No automations match this view.
                  </td>
                </tr>
              ) : null}
              {filtered.map((rule) => (
                <tr
                  key={rule.id}
                  onClick={() => setSelected(rule)}
                  className={`cursor-pointer hover:bg-brand-bg/40 ${selected?.id === rule.id ? "bg-brand-bg/60" : ""}`}
                >
                  <td className="px-4 py-3 font-mono font-bold text-ink">
                    {rule.priority}
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
                  <td className="px-4 py-3 text-ink-2">
                    {rule.activeVersion
                      ? `v${rule.activeVersion.versionNumber}`
                      : "Draft"}
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
            {!selected.systemLocked && selected.status === "active" ? (
              <button
                type="button"
                disabled={busy != null}
                onClick={() => onStatus(selected, "pause")}
                className="mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg text-small font-bold text-amber-700 ring-1 ring-amber-200 hover:bg-amber-50"
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
  onClose,
  onCreated,
}: {
  catalog: AutomationCatalog;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [trigger, setTrigger] = useState("order_imported");
  const [priority, setPriority] = useState("100");
  const [clientId, setClientId] = useState("");
  const [storeId, setStoreId] = useState("");
  const firstField = catalog.fields[0];
  const [conditions, setConditions] = useState<BuilderCondition[]>([
    {
      id: crypto.randomUUID(),
      field: firstField?.key ?? "order.client_id",
      operator: firstField?.operators[0] ?? "eq",
      value: "",
    },
  ]);
  const firstAction = catalog.actions.find((action) => action.available);
  const [actions, setActions] = useState<BuilderAction[]>([
    {
      id: crypto.randomUUID(),
      type: firstAction?.type ?? "tag.add",
      value: actionDefault(firstAction?.type ?? "tag.add"),
      provider: "parcelguard",
      contactName: "",
      contactPhone: "",
    },
  ]);
  const [unknownPolicy, setUnknownPolicy] = useState<"no_match" | "block">(
    "no_match",
  );
  const [draft, setDraft] = useState<{
    ruleId: number;
    revision: number;
  } | null>(null);
  const [simulationOrderId, setSimulationOrderId] = useState("");
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const saveDraft = async () => {
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
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Draft save failed");
    } finally {
      setBusy(null);
    }
  };

  const simulate = async () => {
    if (!draft) {
      setError("Save the draft before simulation.");
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

  return (
    <div className="fixed inset-0 z-[10000] flex items-stretch justify-end bg-black/30 backdrop-blur-sm">
      <div className="flex h-full w-full max-w-[980px] flex-col bg-page shadow-2xl">
        <header className="flex items-center gap-4 border-b border-line bg-surface px-5 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-bg text-brand ring-1 ring-brand-border">
            <Workflow size={20} />
          </div>
          <div className="flex-1">
            <div className="text-lg font-extrabold text-ink">
              Guided Builder
            </div>
            <div className="text-tiny text-ink-3">
              Draft → simulate exact hash → review & publish
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close builder"
            className="rounded-lg p-2 text-ink-3 hover:bg-surface-2"
          >
            <X size={20} />
          </button>
        </header>
        <div className="flex border-b border-line bg-surface px-5 py-3">
          {["Basics", "Conditions", "Actions", "Review"].map((item, index) => (
            <button
              type="button"
              key={item}
              onClick={() => setStep(index + 1)}
              className={`flex flex-1 items-center gap-2 text-left text-small font-bold ${step === index + 1 ? "text-brand" : "text-ink-3"}`}
            >
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] ring-1 ${step === index + 1 ? "bg-brand text-white ring-brand" : "bg-surface-2 ring-line"}`}
              >
                {index + 1}
              </span>
              <span className="hidden sm:inline">{item}</span>
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-7">
          <div className="mx-auto max-w-3xl">
            {step === 1 ? (
              <div className="space-y-5">
                <div>
                  <h2 className="text-xl font-extrabold text-ink">
                    Name the automation
                  </h2>
                  <p className="mt-1 text-small text-ink-3">
                    Use a clear outcome-oriented name and immutable client/store
                    IDs.
                  </p>
                </div>
                <label className="block text-small font-bold text-ink">
                  Name
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="mt-2 h-10 w-full rounded-lg bg-surface px-3 ring-1 ring-line outline-none focus:ring-2 focus:ring-brand/30"
                  />
                </label>
                <label className="block text-small font-bold text-ink">
                  Description
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={3}
                    className="mt-2 w-full rounded-lg bg-surface p-3 ring-1 ring-line outline-none focus:ring-2 focus:ring-brand/30"
                  />
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="text-small font-bold text-ink">
                    Trigger
                    <select
                      value={trigger}
                      onChange={(event) => setTrigger(event.target.value)}
                      className="mt-2 h-10 w-full rounded-lg bg-surface px-3 ring-1 ring-line"
                    >
                      {catalog.triggers.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
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
                </div>
              </div>
            ) : null}
            {step === 2 ? (
              <div className="space-y-4">
                <div>
                  <h2 className="text-xl font-extrabold text-ink">
                    When all conditions match
                  </h2>
                  <p className="mt-1 text-small text-ink-3">
                    Line fields are automatically grouped into one same-line{" "}
                    <code>line_any</code> predicate.
                  </p>
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
                            {item.label}
                          </option>
                        ))}
                      </select>
                      <select
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
                            {label(operator)}
                          </option>
                        ))}
                      </select>
                      {field?.type === "boolean" ? (
                        <select
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
                <label className="block rounded-xl bg-amber-50 p-4 text-small text-amber-900 ring-1 ring-amber-200">
                  <span className="font-extrabold">Incomplete facts</span>
                  <select
                    value={unknownPolicy}
                    onChange={(event) =>
                      setUnknownPolicy(
                        event.target.value as "no_match" | "block",
                      )
                    }
                    className="mt-2 h-10 w-full rounded-lg bg-white px-3 text-ink ring-1 ring-amber-200"
                  >
                    <option value="no_match">Treat unknown as no match</option>
                    <option value="block">
                      Block rate/purchase until complete
                    </option>
                  </select>
                </label>
              </div>
            ) : null}
            {step === 3 ? (
              <div className="space-y-4">
                <div>
                  <h2 className="text-xl font-extrabold text-ink">
                    Then plan approved actions
                  </h2>
                  <p className="mt-1 text-small text-ink-3">
                    Only backend-allowlisted actions appear. The engine never
                    purchases labels or calls providers.
                  </p>
                </div>
                {actions.map((action, index) => {
                  const definition = catalog.actions.find(
                    (item) => item.type === action.type,
                  );
                  return (
                    <div
                      key={action.id}
                      className="grid gap-3 rounded-xl bg-surface p-4 ring-1 ring-line sm:grid-cols-[220px_1fr_auto]"
                    >
                      <select
                        value={action.type}
                        onChange={(event) =>
                          setActions((current) =>
                            current.map((item) =>
                              item.id === action.id
                                ? {
                                    ...item,
                                    type: event.target.value,
                                    value: actionDefault(event.target.value),
                                    provider: "parcelguard",
                                    contactName: "",
                                    contactPhone: "",
                                  }
                                : item,
                            ),
                          )
                        }
                        className="h-10 rounded-lg px-3 ring-1 ring-line"
                      >
                        {catalog.actions.map((item) => (
                          <option
                            key={item.type}
                            value={item.type}
                            disabled={!item.available}
                          >
                            {item.label}
                            {item.available ? "" : " — unavailable"}
                          </option>
                        ))}
                      </select>
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
                          className="h-10 rounded-lg px-3 ring-1 ring-line"
                        >
                          <option value="none">None</option>
                          <option value="delivery">Delivery</option>
                          <option value="signature">Signature</option>
                          <option value="adult_signature">
                            Adult signature
                          </option>
                        </select>
                      ) : action.type === "insurance.require" ? (
                        <div className="grid gap-2 sm:grid-cols-[1fr_150px]">
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
                            placeholder="Minimum value"
                            className="h-10 rounded-lg px-3 ring-1 ring-line"
                          />
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
                            className="h-10 rounded-lg px-3 ring-1 ring-line"
                          >
                            <option value="parcelguard">ParcelGuard</option>
                            <option value="carrier">Carrier</option>
                          </select>
                        </div>
                      ) : (
                        <input
                          type="text"
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
                          className="h-10 rounded-lg px-3 ring-1 ring-line"
                        />
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
                          {definition?.risk} risk
                        </span>
                        {definition?.invalidatesRateProof ? (
                          <span className="rounded-full bg-brand-bg px-2 py-1 text-brand ring-1 ring-brand-border">
                            invalidates rate proof
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
            ) : null}
            {step === 4 ? (
              <div className="space-y-5">
                <div>
                  <h2 className="text-xl font-extrabold text-ink">
                    Review, simulate, publish
                  </h2>
                  <p className="mt-1 text-small text-ink-3">
                    Simulation evaluates canonical backend facts with zero
                    writes and zero provider calls.
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
                    Simulation order ID
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
                        disabled={busy != null || !draft}
                        onClick={simulate}
                        className="inline-flex h-10 items-center gap-2 rounded-lg bg-ink px-4 text-small font-bold text-white disabled:opacity-50"
                      >
                        {busy === "simulate" ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Play size={14} />
                        )}{" "}
                        Simulate
                      </button>
                    </div>
                  </label>
                  {!draft ? (
                    <p className="mt-2 text-tiny text-amber-700">
                      Save the draft before simulation.
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
                      Simulation result
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
                      Zero writes: {String(simulation.zeroWrites)} · Zero
                      provider calls: {String(simulation.zeroProviderCalls)}
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
              </div>
            ) : null}
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
          <div className="flex gap-2">
            <button
              type="button"
              disabled={step === 1}
              onClick={() => setStep((value) => Math.max(1, value - 1))}
              className="h-10 rounded-lg px-4 text-small font-bold text-ink-2 ring-1 ring-line disabled:opacity-40"
            >
              Back
            </button>
            {step < 4 ? (
              <button
                type="button"
                onClick={() => setStep((value) => Math.min(4, value + 1))}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand px-4 text-small font-bold text-white"
              >
                Continue <ChevronRight size={15} />
              </button>
            ) : (
              <button
                type="button"
                disabled={
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
                Review & publish
              </button>
            )}
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
          {rows.map((row) => (
            <div
              key={row.store.storeId}
              className="overflow-hidden rounded-xl ring-1 ring-line"
            >
              <div className="bg-surface-2 px-4 py-3">
                <div className="font-extrabold text-ink">
                  {row.store.clientName}
                </div>
                <div className="text-tiny text-ink-3">
                  Client {row.store.clientId} · Store {row.store.storeId}
                </div>
              </div>
              <div className="divide-y divide-line">
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
            </div>
          ))}
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
  const [busy, setBusy] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const catalogQuery = useQuery({
    queryKey: ["automations", "catalog"],
    queryFn: async () =>
      (await api.get<{ data: AutomationCatalog }>("/automations/catalog")).data,
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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-page p-4 sm:p-6">
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
      <div className="mb-4 flex gap-1 overflow-x-auto rounded-xl bg-surface p-1 ring-1 ring-line">
        {TABS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              type="button"
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
      {tab === "rules" ? (
        <RulesPanel
          rules={rulesQuery.data ?? []}
          loading={rulesQuery.isPending}
          query={query}
          setQuery={setQuery}
          selected={selected}
          setSelected={setSelected}
          onNew={() => setBuilderOpen(true)}
          onRefresh={() => void rulesQuery.refetch()}
          onStatus={(rule, action) => void changeStatus(rule, action)}
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
      {builderOpen && catalogQuery.data ? (
        <Builder
          catalog={catalogQuery.data}
          onClose={() => setBuilderOpen(false)}
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
