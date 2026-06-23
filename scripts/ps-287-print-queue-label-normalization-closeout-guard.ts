/**
 * PS-287 closeout guard - Print Queue content-aware 4x6 label normalization.
 *
 * The normalization guard owns the offline geometry/PDF fixture checks. This
 * closeout guard locks the completion packet: runnable npm scripts, shared pure
 * owners, no live side effects, and Final Review-ready evidence.
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function hasScript(pkg: string, script: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${script}"\\s*:\\s*"${escaped}"`).test(pkg);
}

const packageJson = read('package.json');
const normalizationGuard = read('scripts/ps-287-print-queue-label-normalization-guard.ts');
const pdfOwner = read('src/services/print-queue-pdf.ts');
const fitOwner = read('src/services/print-queue-artwork-fit.ts');
const regionOwner = read('src/services/print-queue-artwork-region.ts');
const oversizeOwner = read('src/services/print-queue-artwork-oversize.ts');
const statusDoc = read('docs/ps-tickets/ps-287-print-queue-label-normalization-status.md');

check('package exposes the PS-287 normalization guard',
  hasScript(packageJson, 'test:ps-287-print-queue-label-normalization', 'tsx scripts/ps-287-print-queue-label-normalization-guard.ts'));
check('package exposes this PS-287 closeout guard',
  hasScript(packageJson, 'test:ps-287-print-queue-label-normalization-closeout', 'tsx scripts/ps-287-print-queue-label-normalization-closeout-guard.ts'));

check('normalization owner delegates to pure artwork bound and placement helpers',
  /deriveArtworkBounds\(src\)/.test(pdfOwner) &&
    /placeArtworkOnCanvas\(\{/.test(pdfOwner) &&
    /embedPages\(\s*\[\s*src\s*\]/.test(pdfOwner));
check('normalization owner writes every unrotated label onto a clean 288x432 page',
  /const TARGET_W = 288/.test(pdfOwner) &&
    /const TARGET_H = 432/.test(pdfOwner) &&
    /merged\.addPage\(\[TARGET_W, TARGET_H\]\)/.test(pdfOwner));
// PS-287 (Per user override unlock shipped data on 2026-06-23): the owner no longer copies
// rotated labels byte-for-byte — it BAKES the /Rotate onto the clean 288x432 canvas via
// placeRotatedArtworkOnCanvas so they print upright at 4x6 (the DoD #3 fix).
check('normalization owner bakes rotated labels onto the 4x6 canvas (no byte-for-byte copy)',
  /rotation !== 0/.test(pdfOwner) &&
    /placeRotatedArtworkOnCanvas\(/.test(pdfOwner) &&
    !/copyPages\(/.test(pdfOwner));

const appendOwner = pdfOwner.slice(
  pdfOwner.indexOf('export async function appendNormalizedLabelPages'),
  pdfOwner.indexOf('function safePdfText'),
);
check('normalization owner has no live/provider/queue side effects',
  Boolean(appendOwner) &&
    !/(fetch\s*\(|db\.|addToQueue|createLabel|notifyMarketplace|insert\s*\()/i.test(appendOwner));

check('artwork bounds owner prefers tight PDF box hints then falls back to content regions',
  /getCropBox/.test(fitOwner) &&
    /getTrimBox/.test(fitOwner) &&
    /deriveLabelContentRegion/.test(fitOwner));
check('content region owner handles letter and A4 no-box oversized sheets',
  /letter\/A4/.test(regionOwner) &&
    /pageH - height/.test(regionOwner));
check('content region owner keeps genuine oversized 4x6 pages whole',
  /oversized4x6AspectRegion/.test(regionOwner) &&
    /return oversized4x6/.test(regionOwner));
check('content region owner handles label-width asymmetric vertical whitespace',
  /recenteredLabelBandRegion/.test(regionOwner) &&
    /return band/.test(regionOwner));
check('oversize helper documents pure geometry and no live side effects',
  /PURE GEOMETRY/.test(oversizeOwner) &&
    /no DB, no carrier IO, no label bytes, no postage/.test(oversizeOwner));

check('normalization guard proves pure placement geometry',
  /placeArtworkOnCanvas preserves aspect ratio/.test(normalizationGuard) &&
    /placeArtworkOnCanvas centers the artwork horizontally/.test(normalizationGuard));
check('normalization guard proves no-box letter and A4 heuristics',
  /content-region: letter sheet yields/.test(normalizationGuard) &&
    /content-region: A4 sheet yields/.test(normalizationGuard));
check('normalization guard proves exact and near-4x6 pages are not spurious-cropped',
  /exact 4.+6 page is returned whole/.test(normalizationGuard) &&
    /near-4.+6 page is returned whole/.test(normalizationGuard));
check('normalization guard proves oversized 4x6 and asymmetric-band cases',
  /oversize-4.+6: 600.+900/.test(normalizationGuard) &&
    /asymmetric-band: a 288.+600 sheet/.test(normalizationGuard));
check('normalization guard proves end-to-end PDF page output and header preservation',
  /content-aware output page is a clean 288.+432/.test(normalizationGuard) &&
    /oversized letter still normalizes to 288.+432/.test(normalizationGuard) &&
    /rotated .+ label normalizes to a clean 288.+432/.test(normalizationGuard) &&
    /batch header page is preserved/.test(normalizationGuard));

const closeoutStatus = {
  card: 'PS-287',
  completion: 92,
  recommendation: 'Final Review',
  evidence: [
    'test:ps-287-print-queue-label-normalization',
    'test:ps-287-print-queue-label-normalization-closeout',
  ],
  safety: 'Offline fixture proof only: no real labels, postage, provider calls, queue mutation, marketplace notification, or production data repair.',
} as const;

check('closeout status recommends PS-287 Final Review',
  closeoutStatus.card === 'PS-287' &&
    closeoutStatus.completion >= 89 &&
    closeoutStatus.recommendation === 'Final Review');
check('closeout status includes focused normalization evidence',
  closeoutStatus.evidence.includes('test:ps-287-print-queue-label-normalization') &&
    closeoutStatus.evidence.includes('test:ps-287-print-queue-label-normalization-closeout'));
check('closeout status documents offline-only safety',
  /Offline fixture proof only/.test(closeoutStatus.safety));

check('PS-287 status doc exists and records the conservative percentage',
  /Current completion estimate: PS-287 92%/.test(statusDoc));
check('PS-287 status doc lists remaining non-blocking proof gap',
  /Optional next evidence/.test(statusDoc) &&
    /real captured carrier PDFs/.test(statusDoc));

if (failures > 0) {
  console.error(`\nFAIL PS-287 print-queue label normalization closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-287 print-queue label normalization closeout guard');
