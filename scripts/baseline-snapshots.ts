// PS-245 (Card 0): the verification baseline store. A snapshot is the known-good state of a money /
// quantity / label / inventory surface (cardId + surface + checksum + data) so a card's change can be
// diffed against it. readBaseline/writeBaseline/upsertSnapshot are pure JSON I/O over BASELINE.json.
//
// NOTE: the master regression baseline (the 29 known-red live/browser suites) is already enforced by
// `test:master:all-safe`; this store is the GOLDEN MONEY-SURFACE half. Capturing those golden values
// is an OPERATIONAL step (it reads live shipped/billing/label data), run by the operator post-deploy —
// not offline code. This module is the offline read/write/diff plumbing that capture + the gate use.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export type BaselineSnapshot = {
  cardId: string;
  surface: string;
  capturedAt: string;
  checksum: string;
  data: unknown;
};

export type BaselineFile = { version: 1; snapshots: BaselineSnapshot[] };

export const DEFAULT_BASELINE_PATH = 'test-results/baseline.json';

export function emptyBaseline(): BaselineFile {
  return { version: 1, snapshots: [] };
}

export function readBaseline(path: string = DEFAULT_BASELINE_PATH): BaselineFile {
  if (!existsSync(path)) return emptyBaseline();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BaselineFile>;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.snapshots)) {
      return { version: 1, snapshots: parsed.snapshots as BaselineSnapshot[] };
    }
  } catch {
    /* corrupt baseline -> treat as empty (capture re-seeds it) */
  }
  return emptyBaseline();
}

export function writeBaseline(file: BaselineFile, path: string = DEFAULT_BASELINE_PATH): void {
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

/** Insert or replace the snapshot for (cardId, surface); keeps the file sorted + deterministic. */
export function upsertSnapshot(file: BaselineFile, snap: BaselineSnapshot): BaselineFile {
  const others = file.snapshots.filter(
    (s) => !(s.cardId === snap.cardId && s.surface === snap.surface),
  );
  return {
    version: 1,
    snapshots: [...others, snap].sort((a, b) =>
      `${a.cardId}|${a.surface}`.localeCompare(`${b.cardId}|${b.surface}`),
    ),
  };
}

/** The surfaces whose golden value the gate diffs (drift here = a money/quantity regression). */
export function findSnapshot(
  file: BaselineFile,
  cardId: string,
  surface: string,
): BaselineSnapshot | null {
  return file.snapshots.find((s) => s.cardId === cardId && s.surface === surface) ?? null;
}
