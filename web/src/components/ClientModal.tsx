import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

type Client = {
  id: number;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  active: boolean;
  storeIds: number[];
  hasShipStationV1Credentials?: boolean;
  hasShipStationV2Credentials?: boolean;
  rateSourceClientId?: number | null;
};

type Body = {
  name: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  active?: boolean;
  storeIds?: number[];
  ssApiKey?: string | null;
  ssApiSecret?: string | null;
  ssApiKeyV2?: string | null;
  rateSourceClientId?: number | null;
};

function parseStoreIds(input: string): number[] {
  return input
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export default function ClientModal({
  onClose,
  existing,
}: {
  onClose: () => void;
  existing: Client | null;
}) {
  const queryClient = useQueryClient();
  const isEdit = !!existing;

  const [name, setName] = useState(existing?.name ?? '');
  const [contactName, setContactName] = useState(existing?.contactName ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [phone, setPhone] = useState(existing?.phone ?? '');
  const [storeIds, setStoreIds] = useState(
    (existing?.storeIds ?? []).join(', ')
  );
  // Carrier credentials. Optional, advanced. Setting any of these scopes
  // this client's Rate Browser to a specific ShipStation account; leaving
  // them blank falls through to the env-default (DR PREPPER main).
  const [ssApiKey, setSsApiKey] = useState('');
  const [ssApiSecret, setSsApiSecret] = useState('');
  const [ssApiKeyV2, setSsApiKeyV2] = useState('');
  const [rateSourceClientId, setRateSourceClientId] = useState(
    existing?.rateSourceClientId != null ? String(existing.rateSourceClientId) : ''
  );
  const [carrierOpen, setCarrierOpen] = useState(false);
  // Pull other clients for the rate-source dropdown so admins can borrow
  // another client's v2 key (e.g. Walmart-DJC → KF Goods).
  const [allClients, setAllClients] = useState<Array<{ id: number; name: string; hasV2: boolean }>>([]);
  useEffect(() => {
    let cancelled = false;
    void api.get<Client[]>('/clients?activeOnly=true').then((rows) => {
      if (cancelled) return;
      setAllClients(
        rows
          .filter((r) => !existing || r.id !== existing.id)
          .map((r) => ({
            id: r.id,
            name: r.name,
            hasV2: Boolean(r.hasShipStationV2Credentials),
          }))
      );
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [existing]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: (body: Body) =>
      isEdit
        ? api.patch<Client>(`/clients/${existing!.id}`, body)
        : api.post<Client>('/clients', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['clients', 'admin'] });
      queryClient.invalidateQueries({ queryKey: ['v2-hooks:clients'] });
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const parsedRateSource = rateSourceClientId.trim()
      ? Number.parseInt(rateSourceClientId, 10)
      : null;
    const payload: Body = {
      name: name.trim(),
      contactName: contactName.trim() || null,
      email: email.trim() || null,
      phone: phone.trim() || null,
      storeIds: parseStoreIds(storeIds),
      rateSourceClientId:
        parsedRateSource != null && Number.isFinite(parsedRateSource) && parsedRateSource > 0
          ? parsedRateSource
          : null,
    };
    // Credentials are redacted by the API on reads. Only send credential
    // fields when an operator has typed a replacement value; otherwise edits
    // to names/store IDs must not erase existing ShipStation credentials.
    if (ssApiKey.trim()) payload.ssApiKey = ssApiKey.trim();
    if (ssApiSecret.trim()) payload.ssApiSecret = ssApiSecret.trim();
    if (ssApiKeyV2.trim()) payload.ssApiKeyV2 = ssApiKeyV2.trim();
    if (!isEdit) payload.active = true;
    mutation.mutate(payload);
  };

  // 2026-05-13: backdrop + panel are motion.div so AnimatePresence
  // at the consumer (pages/Clients.tsx) can animate enter/exit. Same
  // animation contract as the ConfirmModal: backdrop fades 0→1 over
  // 180ms; panel scales 0.96→1 + slides up 8px on a spring. Exit
  // reverses both. The blur on the backdrop adds a soft "depth" cue
  // so the modal reads as floating above the page.
  return (
    <motion.div
      key="client-modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 bg-ink/55 backdrop-blur-sm sm:items-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <motion.div
        key="client-modal-panel"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 4 }}
        transition={{ type: 'spring', stiffness: 380, damping: 28 }}
        className="w-[460px] max-w-full bg-white rounded-modal shadow-[0_20px_60px_-12px_rgba(15,23,42,0.4),0_8px_24px_-8px_rgba(15,23,42,0.18)] overflow-hidden ring-1 ring-line"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-line">
          <div className="flex-1 text-[14px] font-bold text-ink">
            {isEdit ? `Edit ${existing!.name}` : 'New client'}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-3 hover:text-ink"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <form onSubmit={submit} className="px-5 py-4 space-y-3">
          <div>
            <label className="section-label block mb-1">
              Name <span className="text-danger">*</span>
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
              required
              autoFocus
            />
          </div>

          <div>
            <label className="section-label block mb-1">Contact name</label>
            <Input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label className="section-label block mb-1">Email</label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="section-label block mb-1">Phone</label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>

          <div>
            <label className="section-label block mb-1">
              ShipStation store IDs
            </label>
            <Input
              value={storeIds}
              onChange={(e) => setStoreIds(e.target.value)}
              placeholder="12345, 67890"
            />
            <div className="text-tiny text-ink-3 mt-1 leading-relaxed">
              Comma-separated. Orders synced from these stores get auto-assigned
              to this client. Use the <strong>Backfill</strong> button on the
              client card after saving to re-assign existing orders.
            </div>
          </div>

          {/* HIDDEN PER USER REQUEST (2026-05-09): "Carrier credentials
              (advanced)" section is commented out of the UI. The state
              variables (ssApiKey, ssApiSecret, ssApiKeyV2,
              rateSourceClientId) are intentionally KEPT so that the save
              handler at the bottom of this file still passes the existing
              credentials through unchanged when an operator edits other
              fields — nulling them out would silently wipe creds on every
              save. Re-enable this section by deleting the two comment
              markers wrapping the <div>.
          <div className="border border-line rounded-md">
            <button
              type="button"
              onClick={() => setCarrierOpen((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-left text-sm2 font-bold text-ink hover:bg-bg-2"
            >
              <span>🚚 Carrier credentials (advanced)</span>
              <span className="text-ink-3">{carrierOpen ? '▾' : '▸'}</span>
            </button>
            {carrierOpen ? (
              <div className="px-3 py-3 border-t border-line space-y-3">
                <div className="text-tiny text-ink-3 leading-relaxed">
                  Leave blank to inherit the default ShipStation account
                  (DR PREPPER main). Set a v2 key below to scope this client's
                  Rate Browser to a different account, or pick a "Rate source"
                  client to borrow another client's v2 key.
                </div>
                <div>
                  <label className="section-label block mb-1">
                    ShipStation v2 API key
                  </label>
                  <Input
                    type="password"
                    value={ssApiKeyV2}
                    onChange={(e) => setSsApiKeyV2(e.target.value)}
                    placeholder={existing?.hasShipStationV2Credentials ? '•••••• (set)' : 'TEST_xxxxxxx'}
                  />
                  <div className="text-tiny text-ink-3 mt-1">
                    Used by the Rate Browser, /v2/carriers, and /v2/rates/estimate.
                  </div>
                </div>
                <div>
                  <label className="section-label block mb-1">
                    Rate source client (fallback v2 key)
                  </label>
                  <select
                    value={rateSourceClientId}
                    onChange={(e) => setRateSourceClientId(e.target.value)}
                    className="w-full border border-line rounded-md px-2 py-1.5 text-sm2 bg-white"
                  >
                    <option value="">— None (use env default) —</option>
                    {allClients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}{c.hasV2 ? ' (has v2 key)' : ' (no v2 key)'}
                      </option>
                    ))}
                  </select>
                  <div className="text-tiny text-ink-3 mt-1">
                    If this client has no v2 key of its own, borrows the
                    selected client's key for rate-browser/carrier scoping.
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div>
                    <label className="section-label block mb-1">
                      v1 API key
                    </label>
                    <Input
                      type="password"
                      value={ssApiKey}
                      onChange={(e) => setSsApiKey(e.target.value)}
                      placeholder={existing?.hasShipStationV1Credentials ? '•••••• (set)' : '—'}
                    />
                  </div>
                  <div>
                    <label className="section-label block mb-1">
                      v1 API secret
                    </label>
                    <Input
                      type="password"
                      value={ssApiSecret}
                      onChange={(e) => setSsApiSecret(e.target.value)}
                      placeholder={existing?.hasShipStationV1Credentials ? '•••••• (set)' : '—'}
                    />
                  </div>
                </div>
                <div className="text-tiny text-ink-3 leading-relaxed">
                  v1 key+secret are used by legacy ShipStation v1 endpoints
                  (e.g. product sync, mark-as-shipped). Most carrier work uses
                  the v2 key only.
                </div>
              </div>
            ) : null}
          </div>
          */}

          {mutation.isError && (
            <div className="text-danger text-tiny py-1">
              {(mutation.error as Error).message}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <div className="flex-1" />
            <Button
              type="button"
              variant="ghost"
              size="md"
              onClick={onClose}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={mutation.isPending || !name.trim()}
            >
              {mutation.isPending ? 'Saving…' : isEdit ? 'Save' : 'Create'}
            </Button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}
