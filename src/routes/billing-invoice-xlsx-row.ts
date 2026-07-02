const CARRIER_DISPLAY_NAMES: Record<string, string> = {
  stamps_com: 'USPS',
  endicia: 'USPS',
  usps: 'USPS',
  ups: 'UPS',
  ups_walleted: 'UPS',
  fedex: 'FedEx',
  fed_ex: 'FedEx',
  dhl_express: 'DHL',
  dhl: 'DHL',
  shipp: 'Shipp',
  easypost: 'EasyPost',
  walmart: 'Walmart',
};

function normalizeCarrierKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
}

export function invoiceCarrierCell(value: unknown): string {
  const key = normalizeCarrierKey(value);
  if (!key) return '';
  if (CARRIER_DISPLAY_NAMES[key]) return CARRIER_DISPLAY_NAMES[key];
  if (key.includes('usps') || key.includes('stamps')) return 'USPS';
  if (key.includes('ups')) return 'UPS';
  if (key.includes('fedex') || key.includes('fed_ex')) return 'FedEx';
  if (key.includes('dhl')) return 'DHL';
  return String(value ?? '').trim().toUpperCase();
}
