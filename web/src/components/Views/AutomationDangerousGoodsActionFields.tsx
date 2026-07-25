type AutomationDangerousGoodsActionFieldsProps = {
  contactName: string;
  contactPhone: string;
  onChange: (value: { contactName: string; contactPhone: string }) => void;
};

export function AutomationDangerousGoodsActionFields({
  contactName,
  contactPhone,
  onChange,
}: AutomationDangerousGoodsActionFieldsProps) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <input
        type="text"
        aria-label="Dangerous-goods contact name"
        value={contactName}
        onChange={(event) => onChange({ contactName: event.target.value, contactPhone })}
        placeholder="Contact name"
        className="h-10 rounded-lg px-3 ring-1 ring-line"
      />
      <input
        type="tel"
        aria-label="Dangerous-goods contact phone"
        value={contactPhone}
        onChange={(event) => onChange({ contactName, contactPhone: event.target.value })}
        placeholder="Contact phone"
        className="h-10 rounded-lg px-3 ring-1 ring-line"
      />
    </div>
  );
}
