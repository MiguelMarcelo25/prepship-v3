// PS-317: the recipient-editor state + handlers, pulled out of OrdersView. The backend owns the
// editable gate (a shipped/cancelled order is rejected server-side); this hook only collects the edit
// and sends it. Decoupled from the order types — the caller passes the orderId + the current ship-to.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../../../api/client';

export type RecipientDraft = {
  name: string;
  company: string;
  street1: string;
  street2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
};

// The fields we read off the order's current ship-to to seed the form.
type RecipientShipTo = {
  name?: string | null;
  company?: string | null;
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
};

const EMPTY_DRAFT: RecipientDraft = {
  name: '',
  company: '',
  street1: '',
  street2: '',
  city: '',
  state: '',
  postalCode: '',
  country: 'US',
  phone: '',
};

export function useRecipientEditor(deps: {
  orderId: number | null;
  initialShipTo: RecipientShipTo | null;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  refetchOrders: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const [recipientEditorOpen, setRecipientEditorOpen] = useState(false);
  const [recipientEditorSaving, setRecipientEditorSaving] = useState(false);
  const [recipientDraft, setRecipientDraft] = useState<RecipientDraft>(EMPTY_DRAFT);

  // Open the form, seeded from the order's current ship-to.
  const openRecipientEditor = () => {
    if (deps.orderId == null || !deps.initialShipTo) return;
    const shipTo = deps.initialShipTo;
    setRecipientDraft({
      name: shipTo.name ?? '',
      company: shipTo.company ?? '',
      street1: shipTo.street1 ?? '',
      street2: shipTo.street2 ?? '',
      city: shipTo.city ?? '',
      state: shipTo.state ?? '',
      postalCode: shipTo.postalCode ?? '',
      country: shipTo.country ?? 'US',
      phone: shipTo.phone ?? '',
    });
    setRecipientEditorOpen(true);
  };

  const updateRecipientDraft = (key: keyof RecipientDraft, value: string) => {
    setRecipientDraft((current) => ({ ...current, [key]: value }));
  };

  // Save the edited recipient (required fields checked first; backend owns the editable gate).
  async function saveRecipientOverride() {
    if (deps.orderId == null || recipientEditorSaving) return;
    const missing = [
      ['name', recipientDraft.name],
      ['street', recipientDraft.street1],
      ['city', recipientDraft.city],
      ['state', recipientDraft.state],
      ['postal code', recipientDraft.postalCode],
    ].filter(([, value]) => !String(value ?? '').trim());
    if (missing.length > 0) {
      deps.showToast(`Recipient missing ${missing.map(([label]) => label).join(', ')}`, 'error');
      return;
    }

    setRecipientEditorSaving(true);
    try {
      await apiClient.saveOrderRecipientOverride(deps.orderId, {
        name: recipientDraft.name,
        company: recipientDraft.company,
        street1: recipientDraft.street1,
        street2: recipientDraft.street2,
        city: recipientDraft.city,
        state: recipientDraft.state,
        postalCode: recipientDraft.postalCode,
        country: recipientDraft.country || 'US',
        phone: recipientDraft.phone,
      });
      setRecipientEditorOpen(false);
      deps.showToast('Recipient saved', 'success');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['v2-hooks:order-detail', deps.orderId] }),
        deps.refetchOrders(),
      ]);
    } catch (error) {
      deps.showToast(error instanceof Error ? error.message : 'Failed to save recipient', 'error');
    } finally {
      setRecipientEditorSaving(false);
    }
  }

  return {
    recipientEditorOpen,
    setRecipientEditorOpen,
    recipientEditorSaving,
    recipientDraft,
    openRecipientEditor,
    updateRecipientDraft,
    saveRecipientOverride,
  };
}
