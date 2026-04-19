import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
};

type Body = {
  name: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  active?: boolean;
  storeIds?: number[];
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
  const [active, setActive] = useState(existing?.active ?? true);
  const [storeIds, setStoreIds] = useState(
    (existing?.storeIds ?? []).join(', ')
  );

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
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    mutation.mutate({
      name: name.trim(),
      contactName: contactName.trim() || null,
      email: email.trim() || null,
      phone: phone.trim() || null,
      active,
      storeIds: parseStoreIds(storeIds),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/45"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-[460px] max-w-full bg-white rounded-modal shadow-lg overflow-hidden"
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

          <div className="grid grid-cols-2 gap-2">
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

          <label className="flex items-center gap-2 text-sm2 text-ink-2 cursor-pointer select-none pt-1">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="accent-brand"
            />
            Active
          </label>

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
      </div>
    </div>
  );
}
