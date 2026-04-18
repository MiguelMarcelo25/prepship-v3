export type Address = {
  name?: string;
  company_name?: string;
  phone?: string;
  address_line1?: string;
  address_line2?: string;
  address_line3?: string;
  city_locality?: string;
  state_province?: string;
  postal_code: string;
  country_code: string;
  address_residential_indicator?: 'yes' | 'no' | 'unknown';
};

export type Weight = { value: number; unit: 'ounce' | 'pound' | 'gram' | 'kilogram' };
export type Dimensions = {
  unit: 'inch' | 'centimeter';
  length: number;
  width: number;
  height: number;
};

export type Parcel = {
  weight: Weight;
  dimensions?: Dimensions;
  package_code?: string;
};

export type Shipment = {
  validate_address?: 'no_validation' | 'validate_only' | 'validate_and_clean';
  ship_to: Address;
  ship_from: Address;
  packages: Parcel[];
};

export type Rate = {
  rate_id: string;
  rate_type: string;
  carrier_id: string;
  carrier_code: string;
  carrier_nickname?: string;
  service_type: string;
  service_code: string;
  shipping_amount: { currency: string; amount: number };
  insurance_amount?: { currency: string; amount: number };
  confirmation_amount?: { currency: string; amount: number };
  other_amount?: { currency: string; amount: number };
  delivery_days?: number | null;
  estimated_delivery_date?: string | null;
  warning_messages?: string[];
  error_messages?: string[];
  package_type?: string;
};

export type RatesResponse = {
  rate_response: {
    rates: Rate[];
    invalid_rates?: Rate[];
    errors?: { error_source: string; error_type: string; message: string }[];
    rate_request_id?: string;
    shipment_id?: string;
    created_at?: string;
    status: 'working' | 'completed' | 'partial' | 'error';
  };
};

export type Label = {
  label_id: string;
  status: string;
  shipment_id: string;
  ship_date: string;
  created_at: string;
  shipment_cost: { currency: string; amount: number };
  insurance_cost?: { currency: string; amount: number };
  tracking_number: string;
  is_return_label?: boolean;
  rma_number?: string | null;
  is_international?: boolean;
  batch_id?: string;
  carrier_id: string;
  charge_event?: string;
  service_code: string;
  package_code?: string;
  voided?: boolean;
  voided_at?: string | null;
  label_format?: string;
  display_scheme?: string;
  label_layout?: string;
  trackable?: boolean;
  label_image_id?: string | null;
  carrier_code: string;
  tracking_status?: string;
  label_download: {
    href: string;
    pdf?: string;
    png?: string;
    zpl?: string;
  };
};

export type Carrier = {
  carrier_id: string;
  carrier_code: string;
  account_number: string;
  requires_funded_amount: boolean;
  balance: number;
  nickname: string;
  friendly_name: string;
  primary: boolean;
  has_multi_package_supporting_services: boolean;
  supports_label_messages: boolean;
  services: {
    carrier_id: string;
    carrier_code: string;
    service_code: string;
    name: string;
    domestic: boolean;
    international: boolean;
    is_multi_package_supported: boolean;
  }[];
  packages: {
    package_id: string;
    package_code: string;
    name: string;
  }[];
  disabled_by_billing_plan: boolean;
};

export type CarriersResponse = { carriers: Carrier[] };
