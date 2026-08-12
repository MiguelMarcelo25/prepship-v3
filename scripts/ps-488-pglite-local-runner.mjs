/**
 * Local runner for the PS-488 wire-protocol proofs.
 *
 * Starts a fresh in-memory PGlite behind a loopback PostgreSQL socket, points
 * PS488_PG17_ADMIN_URL at it, runs the given proof as a child process, then tears the
 * server down. This is what lets the proof be executed on a machine with no PostgreSQL
 * installed and no Docker, without touching any database the developer already has.
 *
 * IMPORTANT — this is a CONVENIENCE, not the authority.
 *
 * PGlite is its own PostgreSQL build and reports its own server_version (18.3 at the time
 * of writing), so a green run here is NOT a PostgreSQL 17 result. The proofs print
 * `server_version` on every run precisely so nobody can read a local pass as a CI pass.
 * The authoritative run is .github/workflows/ps-488-m2-pg17.yml, which uses a real
 * postgres:17 service container and asserts the major version before running anything.
 *
 * The proofs themselves are unchanged between the two: they take a connection URL and
 * nothing else, so there is no local-only variant of the code under test to drift.
 *
 *   node scripts/ps-488-pglite-local-runner.mjs scripts/ps-488-m3-invoice-grain-pg17.ts
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/ps-488-pglite-local-runner.mjs <proof.ts>');
  process.exit(1);
}

// Loopback only, and a port unlikely to collide with a real server.
const HOST = '127.0.0.1';
const PORT = Number(process.env.PS488_LOCAL_PGLITE_PORT ?? 55488);

const pg = await PGlite.create();
const server = new PGLiteSocketServer({ db: pg, port: PORT, host: HOST });
await server.start();

const child = spawn(process.execPath, [
  new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  target,
], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PS488_PG17_ADMIN_URL: `postgres://postgres:postgres@${HOST}:${PORT}/postgres`,
  },
});

const code = await new Promise((resolve) => child.on('exit', resolve));

await server.stop();
await pg.close();
process.exit(code ?? 1);
