// @ts-nocheck
// Diagnostic endpoint — returns fingerprints (lengths + hash prefixes) of
// our Supabase / Postgres env vars so we can verify the function is seeing
// the values we think it is, WITHOUT exposing secrets. No auth required —
// the response only contains presence + safe hashes, never values.
//
// Remove this file once the new-Supabase migration is verified working.

import { createHash } from 'node:crypto';

function fingerprint(value: string | undefined): { present: boolean; length: number; sha256_prefix?: string } {
  if (!value) return { present: false, length: 0 };
  const h = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return { present: true, length: value.length, sha256_prefix: h };
}

export default async function handler(_req: any, res: any): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    SUPABASE_URL: process.env.SUPABASE_URL ?? '(unset)',
    SUPABASE_URL_fp: fingerprint(process.env.SUPABASE_URL),
    SUPABASE_JWT_SECRET_fp: fingerprint(process.env.SUPABASE_JWT_SECRET),
    DATABASE_URL_fp: fingerprint(process.env.DATABASE_URL),
    DATABASE_URL_host: (process.env.DATABASE_URL ?? '').match(/@([^:/]+)/)?.[1] ?? '(no host)',
    NODE_ENV: process.env.NODE_ENV ?? '(unset)',
    deployedAt: new Date().toISOString(),
  });
}
