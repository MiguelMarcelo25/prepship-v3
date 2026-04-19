import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Check, X, RefreshCw } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Card } from '../components/ui/Card';
import { api } from '../lib/api';

type Setting = { key: string; value: string | null };

type Carrier = {
  carrier_id: string;
  carrier_code: string;
  nickname: string;
  friendly_name: string;
  account_number: string;
  disabled_by_billing_plan: boolean;
};
type CarriersResponse = { carriers: Carrier[] };

type Markup = { type: 'amount' | 'percent'; value: number };

const MARKUP_PREFIX = 'markup.';

function parseMarkup(value: string | null): Markup {
  if (!value) return { type: 'amount', value: 0 };
  try {
    const p = JSON.parse(value);
    if (
      (p.type === 'amount' || p.type === 'percent') &&
      typeof p.value === 'number'
    ) {
      return p as Markup;
    }
  } catch {
    // ignore
  }
  return { type: 'amount', value: 0 };
}

function formatMarkup(m: Markup) {
  if (m.value === 0) return '+$0.00';
  return m.type === 'percent'
    ? `+${m.value}%`
    : `+$${m.value.toFixed(2)}`;
}

export default function Settings() {
  const queryClient = useQueryClient();

  const carriers = useQuery({
    queryKey: ['carriers'],
    queryFn: () => api.get<CarriersResponse>('/rates/carriers'),
    staleTime: 60_000,
  });

  const settingsQ = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ data: Setting[] }>('/settings'),
  });

  const upsert = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      api.put<Setting>(`/settings/${encodeURIComponent(key)}`, { value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });

  const remove = useMutation({
    mutationFn: (key: string) => api.delete(`/settings/${encodeURIComponent(key)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });

  const markups = useMemo(() => {
    const m = new Map<string, Markup>();
    for (const s of settingsQ.data?.data ?? []) {
      if (s.key.startsWith(MARKUP_PREFIX)) {
        const id = s.key.slice(MARKUP_PREFIX.length);
        m.set(id, parseMarkup(s.value));
      }
    }
    return m;
  }, [settingsQ.data]);

  const saveMarkup = (carrierId: string, m: Markup) => {
    upsert.mutate({
      key: MARKUP_PREFIX + carrierId,
      value: JSON.stringify(m),
    });
  };

  return (
    <>
      <Topbar title="Settings" />

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
        {/* Markup Settings */}
        <Card
          title="⚙️ Markup Settings"
          actions={
            <button
              type="button"
              onClick={() => carriers.refetch()}
              disabled={carriers.isFetching}
              className="text-ink-3 hover:text-ink"
              title="Refresh carriers"
            >
              <RefreshCw
                size={12}
                className={carriers.isFetching ? 'animate-spin' : ''}
              />
            </button>
          }
        >
          <div className="text-tiny text-ink-3 mb-3 leading-relaxed">
            $ or % markup added per carrier account — applied to displayed rates
            in the Rate Browser.
          </div>

          <div className="-mx-3.5">
            <div className="px-3.5 py-2 bg-surface-2 border-y border-line">
              <div className="text-[11.5px] font-bold uppercase tracking-[0.4px] text-ink-3">
                Rate browser — account markups
              </div>
              <div className="text-tiny text-ink-3 mt-0.5">
                $ or % added to displayed rates per carrier account. Useful for
                billing clients above cost.
              </div>
            </div>

            {carriers.isLoading && (
              <div className="px-3.5 py-6 text-center text-ink-3 text-sm2">
                Loading carriers…
              </div>
            )}

            {carriers.isError && (
              <div className="px-3.5 py-6 text-center text-danger text-sm2">
                Couldn't load carriers: {(carriers.error as Error).message}
              </div>
            )}

            {carriers.data && carriers.data.carriers.length === 0 && (
              <div className="px-3.5 py-6 text-center text-ink-3 text-sm2">
                No carrier accounts found in ShipStation.
              </div>
            )}

            {(carriers.data?.carriers ?? [])
              .filter((c) => !c.disabled_by_billing_plan)
              .map((c) => (
                <CarrierRow
                  key={c.carrier_id}
                  carrier={c}
                  current={markups.get(c.carrier_id) ?? { type: 'amount', value: 0 }}
                  onSave={(m) => saveMarkup(c.carrier_id, m)}
                  saving={upsert.isPending}
                />
              ))}
          </div>
        </Card>

        {/* Other settings (raw key-value editor) */}
        <OtherSettings
          settings={(settingsQ.data?.data ?? []).filter(
            (s) => !s.key.startsWith(MARKUP_PREFIX)
          )}
          loading={settingsQ.isLoading}
          onUpsert={(key, value) => upsert.mutate({ key, value })}
          onDelete={(key) => remove.mutate(key)}
          upserting={upsert.isPending}
        />
      </div>
    </>
  );
}

function CarrierRow({
  carrier,
  current,
  onSave,
  saving,
}: {
  carrier: Carrier;
  current: Markup;
  onSave: (m: Markup) => void;
  saving: boolean;
}) {
  const [type, setType] = useState<Markup['type']>(current.type);
  const [value, setValue] = useState<string>(String(current.value));

  // Sync local state when server value changes (e.g. after save)
  const currentKey = `${current.type}:${current.value}`;
  const localKey = `${type}:${value}`;
  const dirty = currentKey !== localKey;

  const commit = () => {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    if (n === current.value && type === current.type) return;
    onSave({ type, value: n });
  };

  const display = formatMarkup({
    type,
    value: Number.isFinite(Number(value)) ? Number(value) : 0,
  });

  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5 border-b border-line hover:bg-surface-2 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="text-sm2 font-semibold text-brand truncate">
          {carrier.nickname || carrier.friendly_name}
        </div>
        <div className="text-tiny text-ink-3 truncate">
          {carrier.carrier_code.toUpperCase()}
          {carrier.account_number && (
            <> · {carrier.account_number.slice(-6)}</>
          )}
        </div>
      </div>
      <Select
        value={type}
        onChange={(e) => setType(e.target.value as Markup['type'])}
        onBlur={commit}
        className="!w-14 !py-1 !text-[11px]"
      >
        <option value="amount">$</option>
        <option value="percent">%</option>
      </Select>
      <Input
        type="number"
        step="0.01"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        className="!w-20 !py-1 !text-[11px] text-right"
      />
      <span
        className={`w-16 text-right text-tiny font-mono ${
          dirty ? 'text-warn' : 'text-ok-dark'
        }`}
        title={dirty ? 'Unsaved' : 'Saved'}
      >
        {saving && dirty ? '…' : display}
      </span>
    </div>
  );
}

function OtherSettings({
  settings,
  loading,
  onUpsert,
  onDelete,
  upserting,
}: {
  settings: Setting[];
  loading: boolean;
  onUpsert: (key: string, value: string) => void;
  onDelete: (key: string) => void;
  upserting: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const submitNew = (e: FormEvent) => {
    e.preventDefault();
    if (!newKey.trim()) return;
    onUpsert(newKey.trim(), newValue);
    setAdding(false);
    setNewKey('');
    setNewValue('');
  };

  return (
    <Card
      title="Other settings"
      actions={
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="text-ink-3 hover:text-ink"
          title="Add setting"
        >
          <Plus size={12} />
        </button>
      }
    >
      <div className="text-tiny text-ink-3 mb-2">
        Raw key/value entries. SYSTEM rows are managed by the app.
      </div>

      {adding && (
        <form
          onSubmit={submitNew}
          className="flex items-end gap-2 mb-2 p-2.5 bg-brand-bg rounded-btn"
        >
          <div className="flex-1">
            <Input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="key"
              required
              autoFocus
            />
          </div>
          <div className="flex-[2]">
            <Input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="value"
            />
          </div>
          <Button type="submit" variant="primary" size="sm" disabled={upserting}>
            Save
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setAdding(false)}
          >
            Cancel
          </Button>
        </form>
      )}

      <div className="-mx-3.5">
        {loading && (
          <div className="px-3.5 py-4 text-center text-ink-3 text-sm2">
            Loading…
          </div>
        )}
        {!loading && settings.length === 0 && (
          <div className="px-3.5 py-4 text-ink-3 text-sm2">
            No other settings yet.
          </div>
        )}
        {settings.map((row) => {
          const isEditing = editingKey === row.key;
          const isSystem =
            row.key.includes('.') || row.key.startsWith('order_sync');
          return (
            <div
              key={row.key}
              className="flex items-center gap-3 px-3.5 py-2 border-b border-line"
            >
              <div className="font-mono text-[12px] text-ink truncate flex-1 min-w-0">
                {row.key}
                {isSystem && (
                  <span className="ml-2 text-2xs font-bold text-ink-3 uppercase">
                    system
                  </span>
                )}
              </div>
              <div className="flex-[2] min-w-0">
                {isEditing ? (
                  <Input
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        onUpsert(row.key, editValue);
                        setEditingKey(null);
                      }
                      if (e.key === 'Escape') setEditingKey(null);
                    }}
                  />
                ) : (
                  <span className="font-mono text-[12px] text-ink-2 break-all">
                    {row.value ?? <span className="text-ink-3">(empty)</span>}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {isEditing ? (
                  <>
                    <Button
                      variant="primary"
                      size="xs"
                      onClick={() => {
                        onUpsert(row.key, editValue);
                        setEditingKey(null);
                      }}
                    >
                      <Check size={11} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setEditingKey(null)}
                    >
                      <X size={11} />
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        setEditingKey(row.key);
                        setEditValue(row.value ?? '');
                      }}
                    >
                      <Pencil size={11} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        if (confirm(`Delete setting "${row.key}"?`)) {
                          onDelete(row.key);
                        }
                      }}
                      className="text-ink-3 hover:!text-danger"
                    >
                      <Trash2 size={11} />
                    </Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
