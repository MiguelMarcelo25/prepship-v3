/**
 * PS-294 — SHIPP label 4×6 placement guard (#572 "SHIPP wrong size", folded in).
 *
 * THE BUG (SHIPP "wrong size"): src/connectors/carrier/shipp.ts assembles the SHIPP label PDF by
 * fitting the WHOLE source page/image onto a 288×432 (4×6 @72dpi) canvas with a DUPLICATED
 * Math.min contain-fit in TWO places (appendShippPdfPages + appendShippImagePage). The placement
 * math had no single owner, so the 4×6 invariant + centering can silently drift between the PDF and
 * the image path.
 *
 * SCOPE (slice 1 — connector-local, no shared file): establish ONE pure owner of the placement math
 * — computeFourBySixPlacement(srcWidth, srcHeight) — that both append paths call. Behavior-preserving
 * (contain-fit + center; identical math), but now a single, testable, GRAFTABLE seam. The
 * CONTENT-AWARE artwork crop that actually rescues an oversized / corner label is PS-287's shared
 * normalizer; PS-294 grafts onto that owner once it lands (separate slice, needs the print-queue
 * claim). This guard pins the 4×6 invariant + the single-owner seam so the graft is safe.
 *
 *   npx tsx scripts/ps-294-shipp-4x6-placement-guard.ts
 */
import { readFileSync } from 'node:fs';
import { PDFDocument, rgb } from 'pdf-lib';
import {
  computeFourBySixPlacement,
  FOUR_BY_SIX_WIDTH_PT,
  FOUR_BY_SIX_HEIGHT_PT,
} from '../src/connectors/carrier/shipp-label-4x6-placement';
import { __test_normalizeShippLabelPartsToPdfDataUrl } from '../src/connectors/carrier/shipp';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}
const approx = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

async function main() {
  // ── the 4×6 canvas is the postage standard (4in × 6in @ 72dpi) ───────────────
  check('4×6 canvas is 288×432pt', FOUR_BY_SIX_WIDTH_PT === 288 && FOUR_BY_SIX_HEIGHT_PT === 432,
    `${FOUR_BY_SIX_WIDTH_PT}×${FOUR_BY_SIX_HEIGHT_PT}`);

  // ── pure placement: contain-fit + centered ───────────────────────────────────
  {
    const p = computeFourBySixPlacement({ srcWidth: 288, srcHeight: 432 });
    check('exact-4×6 source fills the canvas with no offset',
      approx(p.drawWidth, 288) && approx(p.drawHeight, 432) && approx(p.x, 0) && approx(p.y, 0),
      JSON.stringify(p));
  }
  {
    const p = computeFourBySixPlacement({ srcWidth: 612, srcHeight: 792 }); // US-letter points
    check('oversized source is contained within 4×6', p.drawWidth <= 288.01 && p.drawHeight <= 432.01, JSON.stringify(p));
    check('oversized source preserves aspect ratio', approx(p.drawWidth / p.drawHeight, 612 / 792, 0.001));
    check('oversized source is centered',
      approx(p.x, (288 - p.drawWidth) / 2) && approx(p.y, (432 - p.drawHeight) / 2) && p.x >= 0 && p.y >= 0);
  }
  {
    const p = computeFourBySixPlacement({ srcWidth: 144, srcHeight: 216 }); // 2×3, same aspect as 4×6
    check('small same-aspect source scales UP to fill', approx(p.drawWidth, 288) && approx(p.drawHeight, 432), JSON.stringify(p));
  }
  {
    const p = computeFourBySixPlacement({ srcWidth: 0, srcHeight: 0 }); // degenerate
    check('degenerate dims fall back to a finite full canvas (no NaN/negative)',
      Number.isFinite(p.drawWidth) && Number.isFinite(p.drawHeight) && p.drawWidth > 0 && p.drawHeight > 0, JSON.stringify(p));
  }

  // ── wiring: both append paths use the ONE owner (no duplicated inline math) ───
  const shipp = readFileSync('src/connectors/carrier/shipp.ts', 'utf8');
  check('shipp.ts imports the single 4×6 placement owner',
    /from '\.\/shipp-label-4x6-placement'/.test(shipp) && /computeFourBySixPlacement/.test(shipp));
  const placementCalls = (shipp.match(/computeFourBySixPlacement\(/g) || []).length;
  check('both append paths (pdf + image) call the placement owner', placementCalls >= 2, `calls=${placementCalls}`);
  check('the duplicated inline Math.min placement math is gone from shipp.ts',
    !/Math\.min\(SHIPP_LABEL_PAGE_WIDTH \//.test(shipp));

  // ── integration: any source size still yields a 288×432 first page ───────────
  {
    const src = await PDFDocument.create();
    const srcPage = src.addPage([612, 792]); // oversized letter source
    srcPage.drawRectangle({ x: 40, y: 40, width: 120, height: 80, color: rgb(0, 0, 0) }); // real labels carry content
    const srcB64 = Buffer.from(await src.save()).toString('base64');
    const url = await __test_normalizeShippLabelPartsToPdfDataUrl([{ base64: srcB64, format: 'application/pdf' }]);
    check('assembled label is a data:application/pdf URL',
      typeof url === 'string' && url.startsWith('data:application/pdf;base64,'));
    if (typeof url === 'string') {
      const out = await PDFDocument.load(Buffer.from(url.split(',')[1]!, 'base64'));
      const page0 = out.getPage(0);
      check('the assembled label page is exactly 4×6 (288×432) regardless of source size',
        approx(page0.getWidth(), 288) && approx(page0.getHeight(), 432),
        `${page0.getWidth()}×${page0.getHeight()}`);
    }
  }

  if (failures > 0) { console.error(`\nFAIL PS-294 shipp 4×6 placement guard (${failures} failing)`); process.exit(1); }
  console.log('\nPASS PS-294 shipp 4×6 placement guard');
}

void main();
