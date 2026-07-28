import { HazmatContactPicker } from "./automations/HazmatContactPicker";

type AutomationDangerousGoodsActionFieldsProps = {
  contactName: string;
  contactPhone: string;
  /** Client the rule is scoped to; decides which saved contacts are offered. */
  clientId: number | null;
  onChange: (value: { contactName: string; contactPhone: string }) => void;
};

export function AutomationDangerousGoodsActionFields({
  contactName,
  contactPhone,
  clientId,
  onChange,
}: AutomationDangerousGoodsActionFieldsProps) {
  return (
    <div className="space-y-2">
      {/* Picking copies the values into the two fields below, which stay fully
          editable -- the copy is a starting point, not a lock. */}
      <div className="flex justify-end">
        <HazmatContactPicker
          clientId={clientId}
          onPick={(contact) =>
            onChange({ contactName: contact.name, contactPhone: contact.phone })
          }
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
      <label className="text-tiny font-bold text-ink-2">
        Name Contact
        <input
          type="text"
          aria-label="Dangerous-goods contact name"
          value={contactName}
          onChange={(event) =>
            onChange({ contactName: event.target.value, contactPhone })
          }
          placeholder="Enter contact name"
          className="mt-1.5 h-10 w-full rounded-lg px-3 ring-1 ring-line"
        />
      </label>
      <label className="text-tiny font-bold text-ink-2">
        Phone Contact
        <input
          type="tel"
          aria-label="Dangerous-goods contact phone"
          value={contactPhone}
          onChange={(event) =>
            onChange({ contactName, contactPhone: event.target.value })
          }
          placeholder="Enter contact phone"
          className="mt-1.5 h-10 w-full rounded-lg px-3 ring-1 ring-line"
        />
      </label>
      </div>
    </div>
  );
}
