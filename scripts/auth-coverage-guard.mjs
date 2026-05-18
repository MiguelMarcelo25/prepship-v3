import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mainSource = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

function protectedPrefixBlock() {
  const start = mainSource.indexOf('const protectedPrefixes = [');
  const end = mainSource.indexOf('];', start);
  if (start === -1 || end === -1) return '';
  return mainSource.slice(start, end);
}

const prefixes = [
  '/orders',
  '/shipments',
  '/packages',
  '/clients',
  '/rates',
  '/labels',
  '/sync',
  '/inventory',
  '/locations',
  '/settings',
  '/billing',
  '/manifests',
  '/analysis',
  '/dashboard',
  '/print-queue',
  '/parent-skus',
  '/products',
  '/init',
  '/admin',
  '/carrier-accounts',
  '/carriers',
  '/users',
  '/worker',
];

const block = protectedPrefixBlock();
assert(block.length > 0, 'main.ts declares protectedPrefixes');

for (const prefix of prefixes) {
  assert(block.includes(`'${prefix}'`), `${prefix} is covered by protectedPrefixes`);
}

assert(
  mainSource.includes('app.use(prefix, requireAuth);') &&
    mainSource.includes('app.use(`${prefix}/*`, requireAuth);'),
  'protectedPrefixes apply root and wildcard requireAuth gates',
);

assert(
  mainSource.includes("app.use('/admin', requireAdmin);") &&
    mainSource.includes("app.use('/admin/*', requireAdmin);"),
  'admin root and wildcard routes require requireAdmin',
);

const healthIndex = mainSource.indexOf("app.route('/health', health);");
const cronIndex = mainSource.indexOf("app.route('/cron', cronRoute);");
const authIndex = mainSource.indexOf('const protectedPrefixes = [');

assert(healthIndex !== -1 && healthIndex < authIndex, '/health is routed before app auth gates');
assert(cronIndex !== -1 && cronIndex < authIndex, '/cron is routed before app auth gates');

if (process.exitCode) {
  process.exit(process.exitCode);
}
