import { readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, pass: boolean) {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
  if (!pass) failures += 1;
}

const orderCells = readFileSync('web/src/components/Views/orders/cells/order-cells.tsx', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');

check(
  'OrdersView delegates Shipping Account rendering to the extracted cell module',
  ordersView.includes('renderShippingAccountCellLeaf') &&
    /case 'custcarrier':[\s\S]*return renderShippingAccountCell\(order\)/.test(ordersView),
);

check(
  'Shipping Account cell derives destination country from existing order fields',
  /function getDestinationCountry\(order: OrderSummaryDto\): string \{[\s\S]*recipient\?\.country[\s\S]*shipTo\?\.country[\s\S]*rawShipTo\?\.country[\s\S]*rawShipTo\?\.countryCode[\s\S]*rawShipTo\?\.country_code/.test(orderCells),
);

check(
  'domestic countries are explicitly suppressed',
  /function isDomesticDestination\(country: string\): boolean \{[\s\S]*normalized === 'US'[\s\S]*normalized === 'USA'[\s\S]*UNITED STATES/.test(orderCells),
);

check(
  'international marker is accessible and country-specific',
  orderCells.includes('aria-label={`International destination ${country}`}') &&
    orderCells.includes('title={`International destination: ${country}`}') &&
    orderCells.includes('const displayCountry = country.length <= 3 ? country :') &&
    orderCells.includes('<Flag size={9}'),
);

check(
  'Shipping Account cell renders marker below service/account content for shipped and awaiting rows',
  (orderCells.match(/renderServiceLabelWithDestination\(displayOrder/g) ?? []).length >= 2 &&
    /<div[^>]*>\{accountDisplay\}<\/div>[\s\S]*renderServiceLabelWithDestination\(displayOrder/.test(orderCells) &&
    /getShipAccountDisplay\(displayOrder, shippingAccounts\)[\s\S]*renderServiceLabelWithDestination\(displayOrder/.test(orderCells),
);

check(
  'frontend remains display-only and does not add a parallel isInternational source of truth',
  !/\bisInternational\b/.test(orderCells) &&
    !/\bis_international\b/.test(orderCells),
);

if (failures > 0) {
  console.error(`FAIL PS-404 international order indicator guard: ${failures} failure(s)`);
  process.exit(1);
}

console.log('PASS PS-404 international order indicator guard');
