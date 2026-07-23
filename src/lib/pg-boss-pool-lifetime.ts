import type PgBoss from 'pg-boss';

export type PgBossPoolLifetimeOptions = PgBoss.ConstructorOptions & {
  maxLifetimeSeconds: number;
};

/**
 * pg-boss forwards unknown database options to pg.Pool, whose runtime supports
 * maxLifetimeSeconds. pg-boss 10.4 does not expose that pg option in its type,
 * so this narrow adapter keeps the runtime setting explicit and type-checked.
 */
export function withPgBossPoolLifetime(
  options: PgBoss.ConstructorOptions,
  maxLifetimeSeconds: number,
): PgBossPoolLifetimeOptions {
  return { ...options, maxLifetimeSeconds };
}
