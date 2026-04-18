import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SHIPSTATION_API_KEY: z.string().optional(),
  SHIPSTATION_API_SECRET: z.string().optional(),
  SHIPSTATION_API_KEY_V2: z.string().optional(),
  SHIP_FROM_NAME: z.string().optional(),
  SHIP_FROM_COMPANY: z.string().optional(),
  SHIP_FROM_STREET1: z.string().optional(),
  SHIP_FROM_STREET2: z.string().optional(),
  SHIP_FROM_CITY: z.string().optional(),
  SHIP_FROM_STATE: z.string().optional(),
  SHIP_FROM_POSTAL_CODE: z.string().optional(),
  SHIP_FROM_COUNTRY: z.string().default('US'),
  SHIP_FROM_PHONE: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
