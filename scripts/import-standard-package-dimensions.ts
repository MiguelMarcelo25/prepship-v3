import { sql } from '../src/db/client';
import { importStandardPackageDimensions } from '../src/services/package-dimension-importer';

try {
  const result = await importStandardPackageDimensions();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
