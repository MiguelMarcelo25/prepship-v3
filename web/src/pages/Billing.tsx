import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator, RefreshCw } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Card, Field } from '../components/ui/Card';
import { api, qs } from '../lib/api';

type Client = { id: number; name: string; active: boolean };

type Config = {
  clientId: number;
  pickPackFee: string;
  additionalUnitFee: string;
  packageCostMarkup: string;
  shippingMarkupPct: string;
  shippingMarkupFlat: string;
  billingMode: string;
  active: boolean;
};

type Summary = {
  clients: {
    clientId: number;
    total: number;
    byType: Record<string, number>;
    count: number;
  }[];
  grandTotal: number;
};

type GenerateResult = {
  generated: number;
  skipped: number;
  message: string;
};

function startOfMonthIso(d = new Date()) {
  const s = new Date(d.getFullYear(), d.getMonth(), 1);
  return s.toISOString();
}
function endOfMonthIso(d = new Date()) {
  const e = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
  return e.toISOString();
}
function toDateInput(iso: string) {
  return iso.slice(0, 10);
}
function fromDateInputStart(ymd: string) {
  return new Date(ymd + 'T00:00:00').toISOString();
}
function fromDateInputEnd(ymd: string) {
  return new Date(ymd + 'T23:59:59').toISOString();
}

export default function Billing() {
  const queryClient = useQueryClient();
  const [dateFrom, setDateFrom] = useState(toDateInput(startOfMonthIso()));
  const [dateTo, setDateTo] = useState(toDateInput(endOfMonthIso()));

  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<Client[]>('/clients'),
  });

  const configsQ = useQuery({
    queryKey: ['billing-config'],
    queryFn: () => api.get<{ data: Config[] }>('/billing/config'),
  });

  const summaryQueryString = useMemo(
    () =>
      qs({
        dateFrom: fromDateInputStart(dateFrom),
        dateTo: fromDateInputEnd(dateTo),
      }),
    [dateFrom, dateTo]
  );

  const summary = useQuery({
    queryKey: ['billing-summary', summaryQueryString],
    queryFn: () => api.get<Summary>(`/billing/summary${summaryQueryString}`),
  });

  const generate = useMutation({
    mutationFn: () =>
      api.post<GenerateResult>('/billing/generate', {
        dateFrom: fromDateInputStart(dateFrom),
        dateTo: fromDateInputEnd(dateTo),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['billing-summary'] });
    },
  });

  const configByClient = useMemo(() => {
    const m = new Map<number, Config>();
    for (const c of configsQ.data?.data ?? []) m.set(c.clientId, c);
    return m;
  }, [configsQ.data]);

  const clientById = useMemo(() => {
    const m = new Map<number, Client>();
    for (const c of clients.data ?? []) m.set(c.id, c);
    return m;
  }, [clients.data]);

  return (
    <>
      <Topbar title="Billing" />
      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
        <Card title="Generate line items">
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              generate.mutate();
            }}
            className="flex items-end gap-3 flex-wrap"
          >
            <div>
              <label className="section-label block mb-1">From</label>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="section-label block mb-1">To</label>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                required
              />
            </div>
            <Button type="submit" variant="primary" size="md" disabled={generate.isPending}>
              {generate.isPending ? (
                <>
                  <RefreshCw size={12} className="animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <Calculator size={12} />
                  Generate
                </>
              )}
            </Button>
            {generate.data && (
              <span className="text-tiny text-ok-dark font-semibold">
                {generate.data.message}
                {generate.data.skipped > 0 ? ` (${generate.data.skipped} skipped)` : ''}
              </span>
            )}
            {generate.isError && (
              <span className="text-tiny text-danger">
                {(generate.error as Error).message}
              </span>
            )}
          </form>
          <div className="mt-2 text-tiny text-ink-3">
            Uses each client's billing config. Only non-voided shipments with a
            client + ship date in range are counted. Duplicates are skipped.
          </div>
        </Card>

        <Card
          title="Summary"
          actions={
            <span className="text-tiny text-ink-2 font-bold font-mono">
              ${(summary.data?.grandTotal ?? 0).toFixed(2)}
            </span>
          }
          bodyClassName=""
        >
          {summary.isLoading ? (
            <div className="p-6 text-center text-ink-3 text-sm2">Loading…</div>
          ) : !summary.data?.clients.length ? (
            <div className="p-6 text-center text-ink-3 text-sm2">
              No line items in this range yet. Hit Generate above.
            </div>
          ) : (
            <table className="w-full text-sm2 border-collapse">
              <thead className="bg-surface-2">
                <tr>
                  <Th>Client</Th>
                  <Th className="text-right">Lines</Th>
                  <Th className="text-right">Pick/pack</Th>
                  <Th className="text-right">Shipping</Th>
                  <Th className="text-right">Total</Th>
                </tr>
              </thead>
              <tbody>
                {summary.data.clients.map((c) => (
                  <tr key={c.clientId} className="border-b border-line">
                    <Td>
                      <span className="font-semibold">
                        {clientById.get(c.clientId)?.name ??
                          `Client #${c.clientId}`}
                      </span>
                    </Td>
                    <Td className="text-right font-mono text-ink-2">
                      {c.count}
                    </Td>
                    <Td className="text-right font-mono">
                      ${(c.byType.pick_pack ?? 0).toFixed(2)}
                    </Td>
                    <Td className="text-right font-mono">
                      ${(c.byType.shipping ?? 0).toFixed(2)}
                    </Td>
                    <Td className="text-right font-mono font-bold">
                      ${c.total.toFixed(2)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Per-client config">
          {clients.isLoading ? (
            <div className="text-center text-ink-3 py-4">Loading…</div>
          ) : !clients.data?.length ? (
            <div className="text-ink-3 text-sm2">
              Create clients first (Sidebar → Clients — not yet wired to the
              sidebar, use POST /clients). Configs attach per client.
            </div>
          ) : (
            <div className="space-y-3">
              {clients.data.map((c) => (
                <ClientConfigRow
                  key={c.id}
                  client={c}
                  config={configByClient.get(c.id) ?? null}
                  onSaved={() =>
                    queryClient.invalidateQueries({
                      queryKey: ['billing-config'],
                    })
                  }
                />
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function ClientConfigRow({
  client,
  config,
  onSaved,
}: {
  client: Client;
  config: Config | null;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pickPackFee, setPickPackFee] = useState(config?.pickPackFee ?? '0');
  const [shippingMarkupPct, setShippingMarkupPct] = useState(
    config?.shippingMarkupPct ?? '0'
  );
  const [shippingMarkupFlat, setShippingMarkupFlat] = useState(
    config?.shippingMarkupFlat ?? '0'
  );

  const save = useMutation({
    mutationFn: () =>
      api.put<Config>(`/billing/config/${client.id}`, {
        pickPackFee: Number(pickPackFee) || 0,
        shippingMarkupPct: Number(shippingMarkupPct) || 0,
        shippingMarkupFlat: Number(shippingMarkupFlat) || 0,
      }),
    onSuccess: () => {
      setEditing(false);
      onSaved();
    },
  });

  return (
    <div className="border border-line rounded-card p-3 bg-white">
      <div className="flex items-center gap-2 mb-2">
        <div className="flex-1 font-bold text-ink">{client.name}</div>
        {!editing ? (
          <Button variant="outline" size="xs" onClick={() => setEditing(true)}>
            {config ? 'Edit' : 'Set up'}
          </Button>
        ) : (
          <>
            <Button
              variant="primary"
              size="xs"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setEditing(false);
                setPickPackFee(config?.pickPackFee ?? '0');
                setShippingMarkupPct(config?.shippingMarkupPct ?? '0');
                setShippingMarkupFlat(config?.shippingMarkupFlat ?? '0');
              }}
            >
              Cancel
            </Button>
          </>
        )}
      </div>
      {!editing ? (
        <div className="grid grid-cols-3 gap-3">
          <Field
            label="Pick/pack fee"
            value={config ? `$${Number(config.pickPackFee).toFixed(2)}` : null}
            mono
          />
          <Field
            label="Shipping markup %"
            value={config ? `${Number(config.shippingMarkupPct).toFixed(2)}%` : null}
            mono
          />
          <Field
            label="Shipping markup flat"
            value={config ? `$${Number(config.shippingMarkupFlat).toFixed(2)}` : null}
            mono
          />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="section-label block mb-1">Pick/pack fee ($)</label>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={pickPackFee}
              onChange={(e) => setPickPackFee(e.target.value)}
            />
          </div>
          <div>
            <label className="section-label block mb-1">Shipping markup (%)</label>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={shippingMarkupPct}
              onChange={(e) => setShippingMarkupPct(e.target.value)}
            />
          </div>
          <div>
            <label className="section-label block mb-1">Shipping markup ($)</label>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={shippingMarkupFlat}
              onChange={(e) => setShippingMarkupFlat(e.target.value)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Th({
  children,
  className = '',
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`text-left px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap ${className}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 align-middle ${className}`}>{children}</td>;
}
