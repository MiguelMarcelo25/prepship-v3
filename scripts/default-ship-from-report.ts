// Read-only diagnostic: what FROM address will the NEXT label print?
//
// Resolves the exact ship-from that direct-carrier + ShipStation labels now use
// (the default Location in Settings -> Location, via getDefaultShipFrom), and
// shows whether it matches the intended DR PREPPER USA business address or is
// still the old "SHIPPHQ WAREHOUSE" value.
//
// SAFETY: reads ONLY the default Location / SHIP_FROM_* env.
//   - This is YOUR OWN business return address — NO customer data / PII.
//   - NEVER reads orders/shipments, never buys postage, never creates labels.
//
//   npm run ship-from:report        (needs DATABASE_URL to read the Location;
//                                     falls back to SHIP_FROM_* env if no DB)
import 'dotenv/config';
import { getDefaultShipFrom } from '../src/lib/ship-from';
import { getDefaultLocation } from '../src/services/locations';

const EXPECTED = {
  name: 'DR PREPPER USA',
  street1: '413 W WALNUT ST',
  city: 'GARDENA',
  state: 'CA',
  zip: '90248',
};

function norm(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

async function main() {
  console.log('=== Default ship-from diagnostic (read-only) ===\n');

  // 1. Raw default Location record (the source of truth).
  try {
    const loc = await getDefaultLocation();
    if (loc) {
      console.log('Default Location record (Settings -> Location):');
      console.log(`  name    : ${loc.name ?? '(blank)'}`);
      console.log(`  company : ${loc.company ?? '(blank)'}`);
      console.log(`  street1 : ${loc.street1 ?? '(blank)'}`);
      console.log(`  street2 : ${loc.street2 ?? '(blank)'}`);
      console.log(`  city    : ${loc.city ?? '(blank)'}`);
      console.log(`  state   : ${loc.state ?? '(blank)'}`);
      console.log(`  zip     : ${loc.postalCode ?? '(blank)'}`);
      console.log('');
    } else {
      console.log('No default Location set — will fall back to SHIP_FROM_* env vars.\n');
    }
  } catch (err) {
    console.log(`Could not read default Location (${err instanceof Error ? err.message : String(err)}).`);
    console.log('Falling back to SHIP_FROM_* env vars.\n');
  }

  // 2. What labels will ACTUALLY print (resolved ship-from).
  let resolved: Awaited<ReturnType<typeof getDefaultShipFrom>>;
  try {
    resolved = await getDefaultShipFrom();
  } catch (err) {
    console.error('\n❌ Ship-from is NOT configured — label creation would fail this way:');
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log('What the NEXT label will print as FROM:');
  console.log(`  ${resolved.name}`);
  if (resolved.company_name && resolved.company_name !== resolved.name) console.log(`  ${resolved.company_name}`);
  console.log(`  ${resolved.address_line1}`);
  if (resolved.address_line2) console.log(`  ${resolved.address_line2}`);
  console.log(`  ${resolved.city_locality} ${resolved.state_province} ${resolved.postal_code}`);
  console.log(`  phone: ${resolved.phone ?? '(none)'}`);
  console.log('');

  // 3. Verdict vs the intended DR PREPPER USA address.
  const matches =
    norm(resolved.name) === norm(EXPECTED.name) &&
    norm(resolved.address_line1) === norm(EXPECTED.street1) &&
    norm(resolved.city_locality) === norm(EXPECTED.city) &&
    norm(resolved.state_province) === norm(EXPECTED.state) &&
    norm(resolved.postal_code).startsWith(norm(EXPECTED.zip));

  const mentionsShipphq =
    norm(resolved.name).includes('SHIPPHQ') ||
    norm(resolved.company_name).includes('SHIPPHQ') ||
    norm(resolved.address_line1).includes('SHIPPHQ');

  if (matches) {
    console.log('✅ MATCH — new labels will print DR PREPPER USA / 413 W WALNUT ST / GARDENA CA 90248.');
  } else if (mentionsShipphq) {
    console.log('⚠️  Still resolves to SHIPPHQ. Update the default Location in Settings -> Location to:');
    console.log('       DR PREPPER USA / 413 W WALNUT ST / GARDENA CA 90248');
  } else {
    console.log('⚠️  Does NOT match the intended DR PREPPER USA address (and is not SHIPPHQ).');
    console.log('     New labels will print the address shown above. Update Settings -> Location if that is wrong.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
