import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertShippingServiceEligible,
  evaluateShippingServiceEligibility,
} from '../src/lib/shipping-service-eligibility';

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');

function assertOrdersViewUsesNextPanelFormForOptionRefresh() {
  assert(
    ordersView.includes('function buildPanelShippingOptionsPayload(form: PanelFormState = panelForm)'),
    'OrdersView must allow shipping options to be built from an explicit next panel form',
  );
  assert(
    ordersView.includes('panelForm?: PanelFormState') &&
      ordersView.includes('const effectivePanelForm = options.panelForm ?? panelForm') &&
      ordersView.includes('buildPanelShippingOptionsPayload(effectivePanelForm)'),
    'refreshPanelBestRate must accept the next panel form and not read stale panelForm after setPanelForm',
  );
  assert(
    ordersView.includes('const nextForm = { ...panelForm, confirmation }') &&
      ordersView.includes('panelForm: nextForm'),
    'confirmation changes must refresh with the newly selected confirmation form',
  );
  assert(
    ordersView.includes('const nextForm = { ...panelForm, insurance }') &&
      ordersView.includes('panelForm: nextForm'),
    'insurance provider changes must refresh with the newly selected insurance provider form',
  );
  assert(
    ordersView.includes('const nextForm = { ...panelForm, insuranceValue }') &&
      ordersView.includes('panelForm: nextForm'),
    'insured value changes must refresh with the newly entered value form',
  );
}

function assertGroundSaverInsuranceEligibility() {
  const services = [
    { serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver' },
    { serviceCode: 'ups_surepost', serviceName: 'UPS SurePost' },
    { serviceCode: 'ups_surepost_1_lb_or_greater', serviceName: 'UPS Ground Saver 1 lb or Greater' },
    { serviceCode: 'ups_surepost_less_than_1_lb', serviceName: 'UPS Ground Saver Less Than 1 lb' },
    { serviceCode: '92', serviceName: 'UPS Ground Saver' },
    { serviceCode: '93', serviceName: 'UPS SurePost 1 lb or Greater' },
  ];

  for (const service of services) {
    assert.equal(
      evaluateShippingServiceEligibility(
        { clientId: 999, clientName: 'Other Client', storeId: 111 },
        service,
        { insuranceProvider: 'carrier', insuredValue: 100 },
      ).allowed,
      false,
      `${service.serviceCode} must be insurance-ineligible for every client`,
    );
    assert.throws(
      () => assertShippingServiceEligible(
        { clientId: 999, clientName: 'Other Client', storeId: 111 },
        service,
        { insuranceProvider: 'carrier', insuredValue: 100 },
      ),
      /Insurance is not available for UPS Ground Saver\/SurePost\. Choose UPS Ground or higher\./,
      `${service.serviceCode} must throw the operator-facing Ground Saver/SurePost insurance message`,
    );
  }

  assert.equal(
    evaluateShippingServiceEligibility(
      { clientId: 999, clientName: 'Other Client', storeId: 111 },
      { serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver' },
      { insuranceProvider: 'none', insuredValue: null },
    ).allowed,
    true,
    'Ground Saver/SurePost with no insurance must remain allowed for non-HUGRAB clients',
  );
  assert.equal(
    evaluateShippingServiceEligibility(
      { clientId: 4, clientName: 'HUGRAB', storeId: 378060 },
      { serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver' },
      { insuranceProvider: 'none', insuredValue: null },
    ).allowed,
    false,
    'PS-057 HUGRAB Ground Saver/SurePost ban must remain active even without insurance',
  );
}

assertOrdersViewUsesNextPanelFormForOptionRefresh();
assertGroundSaverInsuranceEligibility();

console.log('PS-051 shipping option rework guard passed');
