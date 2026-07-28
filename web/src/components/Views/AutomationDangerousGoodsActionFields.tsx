import { HazmatContactPicker } from "./automations/HazmatContactPicker";

type AutomationDangerousGoodsActionFieldsProps = {
  contactName: string;
  contactPhone: string;
  /** Client the rule is scoped to; decides which saved contacts are offered. */
  clientId: number | null;
  onChange: (value: { contactName: string; contactPhone: string }) => void;
};

/**
 * Contact fields for the dangerous-goods action.
 *
 * Sits in the action row's middle grid column, beside Action Type and the
 * delete button. Both labels use the same h-5 line box as Action Type's, so
 * the three labels share one baseline and the three inputs line up -- putting
 * the contact picker above them instead pushed this column's labels down and
 * left the row looking broken.
 *
 * The picker therefore goes BELOW the inputs, where growing this column cannot
 * disturb the alignment of the row it sits in.
 */
export function AutomationDangerousGoodsActionFields({
  contactName,
  contactPhone,
  clientId,
  onChange,
}: AutomationDangerousGoodsActionFieldsProps) {
  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="flex h-5 items-center text-tiny font-bold text-ink-2">
            Name Contact
          </span>
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
        <label className="block">
          <span className="flex h-5 items-center text-tiny font-bold text-ink-2">
            Phone Contact
          </span>
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
      {/* Picking copies the values into the fields above, which stay fully
          editable -- the copy is a starting point, not a lock. */}
      <div className="mt-2 flex justify-end">
        <HazmatContactPicker
          clientId={clientId}
          onPick={(contact) =>
            onChange({ contactName: contact.name, contactPhone: contact.phone })
          }
        />
      </div>
    </div>
  );
}
