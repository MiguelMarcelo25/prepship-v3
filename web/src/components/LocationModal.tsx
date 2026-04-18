import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

type Location = {
  id: number;
  name: string;
  company: string | null;
  street1: string | null;
  street2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  isDefault: boolean;
  active: boolean;
};

type Body = {
  name: string;
  company?: string | null;
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country: string;
  phone?: string | null;
};

export default function LocationModal({
  onClose,
  existing,
}: {
  onClose: () => void;
  existing: Location | null;
}) {
  const queryClient = useQueryClient();
  const isEdit = !!existing;

  const [name, setName] = useState(existing?.name ?? '');
  const [company, setCompany] = useState(existing?.company ?? '');
  const [street1, setStreet1] = useState(existing?.street1 ?? '');
  const [street2, setStreet2] = useState(existing?.street2 ?? '');
  const [city, setCity] = useState(existing?.city ?? '');
  const [state, setState] = useState(existing?.state ?? '');
  const [postalCode, setPostalCode] = useState(existing?.postalCode ?? '');
  const [country, setCountry] = useState(existing?.country ?? 'US');
  const [phone, setPhone] = useState(existing?.phone ?? '');

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
        ? api.patch<Location>(`/locations/${existing!.id}`, body)
        : api.post<Location>('/locations', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['locations'] });
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    mutation.mutate({
      name: name.trim(),
      company: company.trim() || null,
      street1: street1.trim() || null,
      street2: street2.trim() || null,
      city: city.trim() || null,
      state: state.trim() || null,
      postalCode: postalCode.trim() || null,
      country: country.trim() || 'US',
      phone: phone.trim() || null,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/45 overflow-y-auto"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-[500px] max-w-full bg-white rounded-modal shadow-lg overflow-hidden my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-line">
          <div className="flex-1 text-[14px] font-bold text-ink">
            {isEdit ? `Edit ${existing!.name}` : 'New location'}
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
              placeholder="Main warehouse"
              required
              autoFocus
            />
          </div>

          <div>
            <label className="section-label block mb-1">Company</label>
            <Input value={company} onChange={(e) => setCompany(e.target.value)} />
          </div>

          <div>
            <label className="section-label block mb-1">Street</label>
            <Input
              value={street1}
              onChange={(e) => setStreet1(e.target.value)}
              placeholder="123 Warehouse Way"
            />
          </div>

          <div>
            <label className="section-label block mb-1">Street 2</label>
            <Input
              value={street2}
              onChange={(e) => setStreet2(e.target.value)}
              placeholder="Suite, unit, etc."
            />
          </div>

          <div className="grid grid-cols-[1fr_90px_110px] gap-2">
            <div>
              <label className="section-label block mb-1">City</label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div>
              <label className="section-label block mb-1">State</label>
              <Input
                value={state}
                onChange={(e) => setState(e.target.value.toUpperCase())}
                maxLength={3}
              />
            </div>
            <div>
              <label className="section-label block mb-1">Postal code</label>
              <Input
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="section-label block mb-1">Country</label>
              <Input
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                maxLength={2}
              />
            </div>
            <div>
              <label className="section-label block mb-1">Phone</label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>

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
              {mutation.isPending
                ? 'Saving…'
                : isEdit
                  ? 'Save'
                  : 'Create'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
