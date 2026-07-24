import { env } from '../lib/env.js';
import { getSetting, setSetting } from './settings';
import type {
  ShipmentSyncWatchdogAction,
  ShipmentSyncWatchdogState,
} from './shipment-sync-watchdog';

const ALERT_STATE_KEY = 'shipment_sync.watchdog.alert_state';
const RUNBOOK = 'docs/runbooks/ps-431-production-self-healing.md';

export type ShipmentSyncWatchdogAlertKind = 'alert_only' | 'restart_cap_exhausted';

export type ShipmentSyncWatchdogAlertCandidate = {
  key: string;
  kind: ShipmentSyncWatchdogAlertKind;
  state: ShipmentSyncWatchdogState;
  reason: string;
};

export type ShipmentSyncWatchdogAlertState = {
  sentAtByKey: Record<string, number>;
};

export type ShipmentSyncWatchdogAlertNotification = {
  status: 'sent' | 'suppressed' | 'not_configured' | 'not_applicable' | 'failed';
  key: string | null;
  reason: string;
};

type AlertInput = {
  checkedAt: string;
  state: ShipmentSyncWatchdogState;
  verdictReason: string;
  recovery: ShipmentSyncWatchdogAction | null;
  source: 'timer' | 'cron' | 'manual';
  nowMs: number;
};

function parseAlertState(value: string | null): ShipmentSyncWatchdogAlertState {
  if (!value) return { sentAtByKey: {} };
  try {
    const parsed = JSON.parse(value) as { sentAtByKey?: unknown };
    const entries =
      parsed.sentAtByKey && typeof parsed.sentAtByKey === 'object'
        ? Object.entries(parsed.sentAtByKey)
        : [];
    return {
      sentAtByKey: Object.fromEntries(
        entries.filter((entry): entry is [string, number] => Number.isFinite(entry[1])),
      ),
    };
  } catch {
    return { sentAtByKey: {} };
  }
}

function safeReason(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(token|key|secret|password)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/https?:\/\/\S+/gi, '[url redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 240) || 'watchdog escalation requires operator review';
}

/**
 * Canonical PS-431 escalation policy. It intentionally accepts only watchdog
 * lifecycle metadata; account diagnostics, orders, shipments, and provider
 * payloads cannot enter the phone-alert contract.
 */
export function shipmentSyncWatchdogAlertCandidate(
  input: Pick<AlertInput, 'state' | 'verdictReason' | 'recovery'>,
): ShipmentSyncWatchdogAlertCandidate | null {
  const recovery = input.recovery;
  let kind: ShipmentSyncWatchdogAlertKind | null = null;
  if (recovery?.action === 'alert_only') {
    kind = 'alert_only';
  } else if (
    recovery?.action === 'restart_worker' &&
    recovery.status === 'skipped' &&
    recovery.reason === 'max restarts per hour reached'
  ) {
    kind = 'restart_cap_exhausted';
  }
  if (!kind) return null;

  return {
    key: `${input.state}:${kind}`,
    kind,
    state: input.state,
    reason: safeReason(kind === 'restart_cap_exhausted' ? recovery!.reason : input.verdictReason),
  };
}

export function shouldSendShipmentSyncWatchdogAlert(
  state: ShipmentSyncWatchdogAlertState,
  candidate: ShipmentSyncWatchdogAlertCandidate,
  nowMs: number,
  cooldownMs: number,
): boolean {
  const sentAt = state.sentAtByKey[candidate.key];
  return typeof sentAt !== 'number' || !Number.isFinite(sentAt) || nowMs - sentAt >= cooldownMs;
}

export function buildShipmentSyncWatchdogAlertPayload(
  input: AlertInput,
  candidate: ShipmentSyncWatchdogAlertCandidate,
) {
  const headline = `PrepShip shipment sync watchdog: ${candidate.state} (${candidate.kind})`;
  return {
    text: headline,
    content: headline,
    service: 'prepship-v4',
    component: 'shipment-sync-watchdog',
    state: candidate.state,
    escalation: candidate.kind,
    reason: candidate.reason,
    checkedAt: input.checkedAt,
    alertedAt: new Date(input.nowMs).toISOString(),
    source: input.source,
    manualAction: 'Open the PS-431 runbook; inspect sync status and Render worker logs before manual recovery.',
    runbook: RUNBOOK,
  };
}

export async function notifyShipmentSyncWatchdogEscalation(
  input: AlertInput,
): Promise<ShipmentSyncWatchdogAlertNotification> {
  const candidate = shipmentSyncWatchdogAlertCandidate(input);
  if (!candidate) {
    return { status: 'not_applicable', key: null, reason: 'no escalation state' };
  }

  const webhookUrl =
    env.SHIPMENT_SYNC_WATCHDOG_ALERT_WEBHOOK_URL ?? env.WATCHDOG_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    return { status: 'not_configured', key: candidate.key, reason: 'alert webhook not configured' };
  }

  try {
    const state = parseAlertState(await getSetting(ALERT_STATE_KEY));
    if (
      !shouldSendShipmentSyncWatchdogAlert(
        state,
        candidate,
        input.nowMs,
        env.SHIPMENT_SYNC_WATCHDOG_ALERT_COOLDOWN_MS,
      )
    ) {
      return { status: 'suppressed', key: candidate.key, reason: 'state cooldown active' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      env.SHIPMENT_SYNC_WATCHDOG_ALERT_TIMEOUT_MS,
    );
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildShipmentSyncWatchdogAlertPayload(input, candidate)),
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) {
        return {
          status: 'failed',
          key: candidate.key,
          reason: `alert webhook returned HTTP ${response.status}`,
        };
      }
    } finally {
      clearTimeout(timeout);
    }

    state.sentAtByKey[candidate.key] = input.nowMs;
    await setSetting(ALERT_STATE_KEY, JSON.stringify(state));
    return { status: 'sent', key: candidate.key, reason: 'alert webhook accepted' };
  } catch {
    return { status: 'failed', key: candidate.key, reason: 'alert delivery failed' };
  }
}
