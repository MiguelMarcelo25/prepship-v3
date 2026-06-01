import { readFileSync } from 'node:fs';

function assert(condition, message) {
  if (!condition) throw new Error(`UPS direct accessorial guard failed: ${message}`);
}

const upsConnector = readFileSync('src/connectors/carrier/ups.ts', 'utf8');

assert(
  !upsConnector.includes("options.confirmation !== 'none'"),
  'default delivery confirmation must not be sent as UPS DeliveryConfirmation DCISType=1',
);

assert(
  /options\.confirmation === 'signature'[\s\S]{0,180}DCISType: '2'/.test(upsConnector) &&
    /options\.confirmation === 'adult_signature'[\s\S]{0,120}DCISType: '3'/.test(upsConnector),
  'explicit UPS signature confirmations must still map to UPS accessorial codes',
);

assert(
  upsConnector.includes('PackageServiceOptions') &&
    upsConnector.includes('DeclaredValue'),
  'UPS insurance/declared-value package service options must remain wired',
);

console.log('UPS direct accessorial guard passed');
