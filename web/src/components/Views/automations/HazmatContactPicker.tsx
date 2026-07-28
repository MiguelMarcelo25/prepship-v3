import { useEffect, useRef, useState } from "react";
import { BookUser, Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "../../../lib/api";

/**
 * Saved dangerous-goods emergency contacts, as a pick list with create / edit /
 * delete.
 *
 * Choosing a contact COPIES its name and phone into the action. It does not
 * link to it. The action config stores literal strings and published rule
 * versions are immutable, so a link would let editing a contact silently change
 * what an already-published rule declares on a real shipment. The upside is
 * that editing or deleting a contact here can never disturb a live rule.
 *
 * Backend-owned: services/hazmat/contacts.ts decides what is visible for a
 * client, what counts as a duplicate, and what a delete does. This sends
 * intent and renders the DTO.
 */

export interface HazmatContact {
  id: number;
  clientId: number | null;
  name: string;
  phone: string;
  shared: boolean;
}

type Draft = { id: number | null; name: string; phone: string };

const EMPTY_DRAFT: Draft = { id: null, name: "", phone: "" };

export function HazmatContactPicker({
  clientId,
  onPick,
}: {
  /** Client the rule is scoped to, or null for an unscoped rule. */
  clientId: number | null;
  onPick: (contact: { name: string; phone: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<HazmatContact[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    setError(null);
    try {
      const query = clientId ? `?clientId=${clientId}` : "";
      setContacts((await api.get<{ data: HazmatContact[] }>(`/hazmat/contacts${query}`)).data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load contacts");
      setContacts([]);
    }
  };

  useEffect(() => {
    if (!open) return;
    void load();
    // Reloads when the rule's client changes, because visibility depends on it.
  }, [open, clientId]);

  // Close on outside click and on Escape, the same way the rest of the builder's
  // popovers behave.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const save = async () => {
    if (!draft) return;
    setBusy("save");
    setError(null);
    try {
      const body = {
        name: draft.name.trim(),
        phone: draft.phone.trim(),
        // A contact created while a rule is scoped to a client belongs to that
        // client. Created from an unscoped rule it is shared, which is what the
        // unscoped rule can actually use.
        clientId: clientId ?? null,
      };
      if (draft.id === null) await api.post("/hazmat/contacts", body);
      else await api.patch(`/hazmat/contacts/${draft.id}`, body);
      setDraft(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the contact");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (contact: HazmatContact) => {
    if (!globalThis.confirm(
      `Delete "${contact.name}"? Rules that already use these details keep them.`,
    )) return;
    setBusy(`delete:${contact.id}`);
    setError(null);
    try {
      await api.delete(`/hazmat/contacts/${contact.id}`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the contact");
    } finally {
      setBusy(null);
    }
  };

  const canSave = (draft?.name.trim().length ?? 0) > 0 && (draft?.phone.trim().length ?? 0) >= 7;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-tiny font-bold text-brand ring-1 ring-brand-border hover:bg-brand-bg"
      >
        <BookUser size={14} /> Saved contacts
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Saved dangerous-goods contacts"
          className="absolute right-0 z-50 mt-1.5 w-[320px] rounded-xl bg-surface p-2 shadow-lg ring-1 ring-line"
        >
          {error ? (
            <div className="mb-2 rounded-lg bg-rose-50 p-2 text-tiny font-bold text-rose-700 ring-1 ring-rose-200">
              {error}
            </div>
          ) : null}

          {contacts === null ? (
            <div className="p-4 text-center text-tiny text-ink-3">
              <Loader2 size={14} className="mx-auto mb-1 animate-spin" /> Loading
            </div>
          ) : null}

          {contacts?.length === 0 && !draft ? (
            <div className="p-3 text-center text-tiny text-ink-3">
              No saved contacts yet.
            </div>
          ) : null}

          <div className="max-h-56 space-y-1 overflow-y-auto">
            {contacts?.map((contact) => (
              <div
                key={contact.id}
                className="flex items-center gap-1 rounded-lg p-1 hover:bg-surface-2"
              >
                {/* The card itself is the pick action. Edit and delete are
                    siblings, never nested inside it -- a button inside a button
                    is invalid and makes both unaddressable by name. */}
                <button
                  type="button"
                  onClick={() => {
                    onPick({ name: contact.name, phone: contact.phone });
                    setOpen(false);
                  }}
                  className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-small font-bold text-ink">{contact.name}</span>
                    {contact.shared ? (
                      <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-[10px] font-bold text-ink-3 ring-1 ring-line">
                        shared
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate text-tiny text-ink-3">{contact.phone}</div>
                </button>
                <button
                  type="button"
                  aria-label={`Edit ${contact.name}`}
                  disabled={busy != null}
                  onClick={() => setDraft({ id: contact.id, name: contact.name, phone: contact.phone })}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-brand hover:bg-brand-bg disabled:opacity-40"
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${contact.name}`}
                  disabled={busy != null}
                  onClick={() => void remove(contact)}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-rose-600 hover:bg-rose-50 disabled:opacity-40"
                >
                  {busy === `delete:${contact.id}` ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Trash2 size={13} />
                  )}
                </button>
              </div>
            ))}
          </div>

          {draft ? (
            <div className="mt-2 space-y-1.5 border-t border-line pt-2">
              <input
                aria-label="Contact name"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Contact name"
                className="h-8 w-full rounded-lg px-2 text-small ring-1 ring-line"
              />
              <input
                aria-label="Contact phone"
                value={draft.phone}
                onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
                placeholder="Contact phone"
                className="h-8 w-full rounded-lg px-2 text-small ring-1 ring-line"
              />
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={!canSave || busy != null}
                  onClick={() => void save()}
                  className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand text-tiny font-bold text-white disabled:opacity-40"
                >
                  {busy === "save" ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Check size={13} />
                  )}
                  {draft.id === null ? "Create" : "Save"}
                </button>
                <button
                  type="button"
                  aria-label="Cancel"
                  onClick={() => setDraft(null)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 ring-1 ring-line hover:bg-surface-2"
                >
                  <X size={13} />
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setDraft(EMPTY_DRAFT)}
              className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border-t border-line text-tiny font-bold text-brand hover:bg-brand-bg"
            >
              <Plus size={13} /> New contact
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default HazmatContactPicker;
