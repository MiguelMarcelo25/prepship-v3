import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: [
    './src/db/schema/clients.ts',
    './src/db/schema/orders.ts',
    './src/db/schema/shipments.ts',
    './src/db/schema/packages.ts',
    './src/db/schema/package-ledger.ts',
    './src/db/schema/products.ts',
    './src/db/schema/rates.ts',
    './src/db/schema/settings.ts',
    './src/db/schema/inventory.ts',
    './src/db/schema/locations.ts',
    './src/db/schema/billing.ts',
    './src/db/schema/print-queue.ts',
    './src/db/schema/parent-skus.ts',
  ],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  schemaFilter: ['public'],
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
