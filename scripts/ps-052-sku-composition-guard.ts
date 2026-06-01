import { groupOrdersBySku } from '../web/src/components/Views/orders-grouping';

type FixtureItem = {
  sku?: string | null;
  quantity?: number | null;
};

type FixtureOrder = {
  orderId: number;
  items: FixtureItem[];
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function groupIds(group: { orders: FixtureOrder[] } | undefined) {
  return group?.orders.map((order) => order.orderId).sort((a, b) => a - b) ?? [];
}

const orders: FixtureOrder[] = [
  { orderId: 1, items: [{ sku: 'Booster-gel-001', quantity: 2 }] },
  { orderId: 2, items: [{ sku: 'HU-10', quantity: 2 }] },
  {
    orderId: 3,
    items: [
      { sku: 'Booster-gel-001', quantity: 1 },
      { sku: 'HU-10', quantity: 1 },
    ],
  },
  {
    orderId: 4,
    items: [
      { sku: 'HU-10', quantity: 1 },
      { sku: 'Booster-gel-001', quantity: 2 },
    ],
  },
  {
    orderId: 5,
    items: [
      { sku: 'Booster-gel-001', quantity: 1 },
      { sku: 'Booster-gel-001', quantity: 1 },
    ],
  },
  {
    orderId: 6,
    items: [
      { sku: '', quantity: 2 },
    ],
  },
];

const groups = groupOrdersBySku(
  orders,
  (order) => order.items.find((item) => item.sku)?.sku,
  (order) => order.items.reduce((sum, item) => sum + (item.quantity ?? 1), 0),
  (order) => order.items,
);

const byKey = new Map(groups.map((group) => [group.key, group]));

const boosterX2 = byKey.get('booster-gel-001:2');
const huX2 = byKey.get('hu-10:2');
const boosterHu = byKey.get('booster-gel-001:1|hu-10:1');
const booster2Hu1 = byKey.get('booster-gel-001:2|hu-10:1');
const missingSku = groups.find((group) => group.composition?.some((part) => part.missingSku));

assert(boosterX2, 'Expected exact Booster-gel-001:2 group to exist.');
assert(huX2, 'Expected exact HU-10:2 group to exist.');
assert(boosterHu, 'Expected exact Booster-gel-001:1|HU-10:1 group to exist.');
assert(booster2Hu1, 'Expected exact Booster-gel-001:2|HU-10:1 group to exist regardless of item order.');
assert(missingSku, 'Expected blank/missing SKU items to stay in a distinct group.');

assert(
  JSON.stringify(groupIds(boosterX2)) === JSON.stringify([1, 5]),
  `Expected Booster-gel-001:2 to contain only duplicate-equivalent Booster x2 orders; got ${groupIds(boosterX2).join(', ')}`,
);
assert(
  JSON.stringify(groupIds(huX2)) === JSON.stringify([2]),
  `Expected HU-10:2 to contain only HU x2 orders; got ${groupIds(huX2).join(', ')}`,
);
assert(
  JSON.stringify(groupIds(boosterHu)) === JSON.stringify([3]),
  `Expected Booster x1 + HU x1 to be separate; got ${groupIds(boosterHu).join(', ')}`,
);
assert(
  JSON.stringify(groupIds(booster2Hu1)) === JSON.stringify([4]),
  `Expected Booster x2 + HU x1 to be separate; got ${groupIds(booster2Hu1).join(', ')}`,
);

assert(
  boosterX2.label === 'Booster-gel-001 x2',
  `Expected single-SKU header label to show exact quantity; got ${boosterX2.label}`,
);
assert(
  booster2Hu1.label === 'Booster-gel-001 x2 + HU-10 x1',
  `Expected mixed-SKU header to show full composition; got ${booster2Hu1.label}`,
);

console.log('PASS PS-052 exact SKU composition grouping guard');
