import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_RESTART_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_MAX_RESTARTS_PER_HOUR = 2;
const DEFAULT_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

const root = process.cwd();
const env = process.env;

const config = {
  vercelShellUrl: env.VERCEL_SHELL_URL || '',
  renderBaseUrl: env.RENDER_BASE_URL || '',
  syncStatusUrl: env.WATCHDOG_SYNC_STATUS_URL || '',
  inventoryClaimStatusUrl: env.WATCHDOG_INVENTORY_CLAIM_STATUS_URL || '',
  cronSecret: env.WATCHDOG_CRON_SECRET || '',
  alertWebhookUrl: env.WATCHDOG_ALERT_WEBHOOK_URL || '',
  timeoutMs: readPositiveInt('WATCHDOG_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
  failureThreshold: readPositiveInt('WATCHDOG_FAILURE_THRESHOLD', DEFAULT_FAILURE_THRESHOLD),
  restartCooldownMs: readPositiveInt('WATCHDOG_RESTART_COOLDOWN_MS', DEFAULT_RESTART_COOLDOWN_MS),
  maxRestartsPerHour: readPositiveInt('WATCHDOG_MAX_RESTARTS_PER_HOUR', DEFAULT_MAX_RESTARTS_PER_HOUR),
  alertCooldownMs: readPositiveInt('WATCHDOG_ALERT_COOLDOWN_MS', DEFAULT_ALERT_COOLDOWN_MS),
  stateFile: env.WATCHDOG_STATE_FILE || path.join(root, 'outputs', 'production-watchdog-state.json'),
  allowRestarts: env.WATCHDOG_ALLOW_RESTARTS === 'true',
  deployHookUrl: env.RENDER_DEPLOY_HOOK_URL || '',
  renderApiKey: env.RENDER_API_KEY || '',
  renderServiceId: env.RENDER_SERVICE_ID || '',
};

function readPositiveInt(name, fallback) {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function redact(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return String(value)
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/(token|key|secret|password)=([^&\s]+)/gi, '$1=[redacted]');
  }
}

export function sanitizeAlertText(value, maxLength = 160) {
  return String(value || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(token|key|secret|password)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/https?:\/\/\S+/gi, '[url redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function publicTarget(value) {
  if (!value) return '[not configured]';
  return redact(value);
}

function joinUrl(base, routePath) {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${routePath.replace(/^\//, '')}`;
  url.search = '';
  return url.toString();
}

export function readState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      consecutiveFailures: Number(parsed.consecutiveFailures) || 0,
      restartAttempts: Array.isArray(parsed.restartAttempts) ? parsed.restartAttempts : [],
      lastRestartAt: Number.isFinite(parsed.lastRestartAt) ? parsed.lastRestartAt : null,
      lastAlertsByState:
        parsed.lastAlertsByState && typeof parsed.lastAlertsByState === 'object'
          ? parsed.lastAlertsByState
          : {},
    };
  } catch {
    return {
      consecutiveFailures: 0,
      restartAttempts: [],
      lastRestartAt: null,
      lastAlertsByState: {},
    };
  }
}

export function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkHttp(name, url, okStatus = (status) => status >= 200 && status < 500) {
  const started = Date.now();
  try {
    const response = await fetchWithTimeout(url, { method: 'GET' });
    return {
      name,
      ok: okStatus(response.status),
      status: response.status,
      ms: Date.now() - started,
      target: publicTarget(url),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      status: 'error',
      ms: Date.now() - started,
      target: publicTarget(url),
      error: error?.name === 'AbortError' ? 'timeout' : error?.message || 'request failed',
    };
  }
}

async function checkSyncFreshness(url) {
  const started = Date.now();
  if (!config.cronSecret) {
    return {
      name: 'Shipment sync freshness',
      ok: false,
      status: 'config-missing',
      ms: 0,
      target: 'WATCHDOG_CRON_SECRET',
    };
  }
  try {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'x-cron-secret': config.cronSecret },
    });
    const body = await response.json().catch(() => null);
    const state = typeof body?.verdict?.state === 'string' ? body.verdict.state : 'invalid';
    const alert = body?.verdict?.alert;
    const ok = response.status >= 200 && response.status < 300 && alert === false;
    return {
      name: 'Shipment sync freshness',
      ok,
      status: response.status,
      ms: Date.now() - started,
      target: publicTarget(url),
      details: { state },
      ...(body && typeof alert === 'boolean' ? {} : { error: 'invalid watchdog status response' }),
    };
  } catch (error) {
    return {
      name: 'Shipment sync freshness',
      ok: false,
      status: 'error',
      ms: Date.now() - started,
      target: publicTarget(url),
      error: error?.name === 'AbortError' ? 'timeout' : sanitizeAlertText(error?.message || 'request failed'),
    };
  }
}

/**
 * PS-497: stranded inventory claims.
 *
 * Reads the backend verdict rather than deciding anything here — the alarm rule
 * (activity-normalised, per source) is business truth and lives in
 * `src/services/inventory-claim-review-alarm.ts`. This is a thin consumer, exactly like
 * `checkSyncFreshness` above.
 *
 * `restartEligible: false` is the important part. A stranded-claim backlog is a DATA
 * condition — restarting the API cannot fix it, and a watchdog that restarts on it would
 * cycle production forever while the claims sat exactly where they were. It alerts and it
 * makes the run red; it never restarts.
 */
async function checkInventoryClaimAlarm(url) {
  const started = Date.now();
  const name = 'Inventory claim backlog';
  if (!config.cronSecret) {
    return { name, ok: false, status: 'config-missing', ms: 0, target: 'WATCHDOG_CRON_SECRET', restartEligible: false };
  }
  try {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'x-cron-secret': config.cronSecret },
    });
    const body = await response.json().catch(() => null);
    const verdict = body?.verdict;
    const alert = verdict?.alert;
    const ok = response.status >= 200 && response.status < 300 && alert === false;
    return {
      name,
      ok,
      status: response.status,
      ms: Date.now() - started,
      target: publicTarget(url),
      restartEligible: false,
      details: {
        state: typeof verdict?.state === 'string' ? verdict.state : 'invalid',
        // Sanitised: source names and counts only, never order or claim identifiers.
        alerting: Array.isArray(verdict?.sources)
          ? verdict.sources.filter((s) => s?.alert).map((s) => `${s.source}:${s.state}`).join(',')
          : '',
      },
      ...(body && typeof alert === 'boolean' ? {} : { error: 'invalid inventory claim alarm response' }),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      status: 'error',
      ms: Date.now() - started,
      target: publicTarget(url),
      restartEligible: false,
      error: error?.name === 'AbortError' ? 'timeout' : sanitizeAlertText(error?.message || 'request failed'),
    };
  }
}

async function runChecks() {
  const checks = [];

  if (config.vercelShellUrl) {
    checks.push(await checkHttp('Vercel shell', config.vercelShellUrl));
  } else {
    checks.push({ name: 'Vercel shell', ok: false, status: 'config-missing', target: 'VERCEL_SHELL_URL' });
  }

  if (!config.renderBaseUrl) {
    checks.push({ name: 'Render /health', ok: false, status: 'config-missing', target: 'RENDER_BASE_URL' });
    checks.push({
      name: 'Render /health/ready',
      ok: false,
      status: 'config-missing',
      target: 'RENDER_BASE_URL',
    });
    checks.push({
      name: 'Shipment sync freshness',
      ok: false,
      status: 'config-missing',
      target: 'RENDER_BASE_URL',
    });
    return checks;
  }

  checks.push(await checkHttp('Render /health', joinUrl(config.renderBaseUrl, '/health'), (status) => status >= 200 && status < 300));

  const detailChecks = await Promise.all([
    checkHttp('Render /health/ready', joinUrl(config.renderBaseUrl, '/health/ready'), (status) => status >= 200 && status < 300),
    checkHttp('Render /health/deep', joinUrl(config.renderBaseUrl, '/health/deep'), (status) => status >= 200 && status < 300),
  ]);
  checks.push(...detailChecks);
  const syncStatusUrl = config.syncStatusUrl || joinUrl(
    config.renderBaseUrl,
    '/cron/shipment-sync-watchdog/status',
  );
  checks.push(await checkSyncFreshness(syncStatusUrl));
  // PS-497: only meaningful when a base URL is configured; without one there is nothing to
  // ask, and inventing a config-missing failure here would page for a watchdog that was
  // never pointed at anything.
  if (config.renderBaseUrl) {
    checks.push(await checkInventoryClaimAlarm(
      config.inventoryClaimStatusUrl
      || joinUrl(config.renderBaseUrl, '/cron/inventory-claim-watchdog/status'),
    ));
  }

  return checks;
}

/**
 * PS-497: is any failing check something a restart could actually fix?
 *
 * Exported and called by `main()` rather than inlined, because the guard used to run a COPY
 * of this predicate. Review defeated that: adding `|| check.name === 'Inventory claim
 * backlog'` to the real predicate left every assertion green, since the behavioural test
 * exercised the copy and the source check only confirmed the original terms still appeared.
 * A copied safety predicate proves nothing about the code that actually runs.
 *
 * A stranded-claim backlog is a DATA condition: bouncing the API leaves every claim exactly
 * where it was, so a run failing only on that must alert without restarting. Checks with no
 * `restartEligible` flag are eligible, so every pre-existing check behaves as before.
 */
export function hasRestartEligibleFailure(checks) {
  return checks.some(
    (check) =>
      !check.ok &&
      check.name !== 'Render /health/deep' &&
      check.restartEligible !== false,
  );
}

export function summarizeHealth(checks) {
  // /health/deep is diagnostic. Render /health/ready and canonical sync
  // freshness are independently required and cannot mask each other.
  const requiredFailures = checks.filter(
    (check) => check.name !== 'Render /health/deep' && !check.ok,
  );
  return {
    ok: requiredFailures.length === 0,
    failingChecks: requiredFailures.map((check) => check.name),
  };
}

function restartMode() {
  if (!config.allowRestarts) return 'alert-only';
  if (config.deployHookUrl) return 'render-deploy-hook';
  if (config.renderApiKey && config.renderServiceId) return 'render-api';
  return 'alert-only';
}

export function canRestart(state, now) {
  const recentRestarts = (state.restartAttempts || []).filter((timestamp) => now - timestamp < 60 * 60 * 1000);
  state.restartAttempts = recentRestarts;

  if (restartMode() === 'alert-only') {
    return { ok: false, reason: 'alert-only' };
  }
  if (state.consecutiveFailures < config.failureThreshold) {
    return { ok: false, reason: 'below consecutive failure threshold' };
  }
  if (state.lastRestartAt && now - state.lastRestartAt < config.restartCooldownMs) {
    return { ok: false, reason: 'cooldown active' };
  }
  if (recentRestarts.length >= config.maxRestartsPerHour) {
    return { ok: false, reason: 'max restarts per hour reached' };
  }
  return { ok: true, reason: 'restart allowed' };
}

async function triggerRestart() {
  if (config.deployHookUrl) {
    const response = await fetchWithTimeout(config.deployHookUrl, { method: 'POST' });
    return { ok: response.status >= 200 && response.status < 400, status: response.status, method: 'deploy hook' };
  }

  const response = await fetchWithTimeout(
    `https://api.render.com/v1/services/${encodeURIComponent(config.renderServiceId)}/deploys`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.renderApiKey}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }
  );

  return { ok: response.status >= 200 && response.status < 300, status: response.status, method: 'Render API' };
}

async function sendAlert(payload) {
  if (!config.alertWebhookUrl) {
    console.warn('[production-watchdog] WATCHDOG_ALERT_WEBHOOK_URL not configured; alert written to process log only.');
    return false;
  }

  try {
    const response = await fetchWithTimeout(config.alertWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.status < 200 || response.status >= 300) {
      console.warn(`[production-watchdog] alert webhook returned HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`[production-watchdog] alert webhook failed: ${sanitizeAlertText(error?.message || 'request failed')}`);
    return false;
  }
}

export function alertStateKey(health, action = 'alert', reason = '') {
  const failureState = [...health.failingChecks].sort().join('|') || 'unknown';
  return `unhealthy:${failureState}:${action}:${sanitizeAlertText(reason, 80)}`;
}

export function shouldSendAlert(
  state,
  health,
  now,
  cooldownMs = DEFAULT_ALERT_COOLDOWN_MS,
  action = 'alert',
  reason = '',
) {
  const key = alertStateKey(health, action, reason);
  const sentAt = state.lastAlertsByState?.[key];
  return {
    key,
    send: !Number.isFinite(sentAt) || now - sentAt >= cooldownMs,
  };
}

export function buildAlertPayload({ checks, health, state, mode, action, reason }) {
  const headline = `PrepShip production watchdog: ${health.ok ? 'healthy' : 'unhealthy'} (${action})`;
  return {
    text: headline,
    content: headline,
    service: 'prepship-v4',
    status: health.ok ? 'healthy' : 'unhealthy',
    mode,
    action,
    reason: sanitizeAlertText(reason),
    consecutiveFailures: state.consecutiveFailures,
    threshold: config.failureThreshold,
    cooldownMs: config.restartCooldownMs,
    alertCooldownMs: config.alertCooldownMs,
    maxRestartsPerHour: config.maxRestartsPerHour,
    failingChecks: health.failingChecks,
    checks: checks.map(({ name, ok, status, ms, target, error, details }) => ({
      name,
      ok,
      status,
      ms,
      target,
      error: sanitizeAlertText(error),
      details,
    })),
    manualAction: 'Open the PS-431 runbook; inspect Render readiness and shipment sync status before recovery.',
    runbook: 'docs/runbooks/ps-431-production-self-healing.md',
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  const now = Date.now();
  const state = readState(config.stateFile);
  const checks = await runChecks();
  const health = summarizeHealth(checks);
  const mode = restartMode();

  if (health.ok) {
    state.consecutiveFailures = 0;
    writeState(config.stateFile, state);
    console.log(JSON.stringify({ status: 'healthy', mode, checks }, null, 2));
    return;
  }

  state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
  // PS-497: a restart must be justified by a failure a restart could actually fix. The rule
  // lives in the exported predicate so the guard executes THIS function, not a copy of it.
  const restartEligibleFailure = hasRestartEligibleFailure(checks);
  const restartDecision = restartEligibleFailure
    ? canRestart(state, now)
    : { ok: false, reason: 'no restart-eligible failure (data condition only)' };
  let action = 'alert';
  let reason = restartDecision.reason;

  if (restartDecision.ok) {
    const restart = await triggerRestart();
    action = restart.ok ? 'restart-requested' : 'restart-request-failed';
    reason = `${restart.method} returned HTTP ${restart.status}`;
    if (restart.ok) {
      state.lastRestartAt = now;
      state.restartAttempts = [...(state.restartAttempts || []), now];
    }
  }

  writeState(config.stateFile, state);
  const payload = buildAlertPayload({ checks, health, state, mode, action, reason });
  const alertDecision = shouldSendAlert(
    state,
    health,
    now,
    config.alertCooldownMs,
    action,
    reason,
  );
  if (alertDecision.send && await sendAlert(payload)) {
    state.lastAlertsByState ??= {};
    state.lastAlertsByState[alertDecision.key] = now;
  } else if (!alertDecision.send) {
    console.warn(`[production-watchdog] alert suppressed by state cooldown (${alertDecision.key})`);
  }
  writeState(config.stateFile, state);
  console.error(JSON.stringify(payload, null, 2));
  process.exitCode = health.ok ? 0 : 1;
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntrypoint) {
  main().catch((error) => {
    console.error(`[production-watchdog] ${error?.message || 'unexpected failure'}`);
    process.exitCode = 1;
  });
}
