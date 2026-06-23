// PS-138 (Per user override unlock shipped data on 2026-06-09): pure PDF-rendering helpers
// extracted VERBATIM from src/services/print-queue.ts (no behavior change). These take pdf-lib
// page/font/rgb + already-fetched data and DRAW — they touch NO orders/shipments rows, no
// holds, no label-URL validation, and no postage. runMergeJob (the orchestrator, incl. the
// PS-129 hold exclusion + shipped-label-URL handling) stays in print-queue.ts and imports these.
// The layout arithmetic / constants / closures are kept char-for-char (PDF byte-identity is
// pinned by the offline cert guards: ps-070, ps-073-*, ps-109, batch-header-package-size,
// print-queue-batch-names, ps-084).
import { type PrintQueueEntry } from '../db/schema/print-queue.js';
import {
  collapseIdentityLines,
  resolveQueueLineIdentity,
  headerCardTitle,
  NO_SKU_PICK_NOTE,
  type CollapsedQueueLine,
} from './print-queue-identity.js';
import { degrees } from 'pdf-lib';
import { deriveArtworkBounds, placeArtworkOnCanvas, placeRotatedArtworkOnCanvas } from './print-queue-artwork-fit.js';

// Per user override unlock shipped data on 2026-06-02: display-only print
// layout. Append a label PDF's pages to the merged print document, normalizing
// each onto the standard 4x6 (288x432) print page so an oversized carrier label
// (e.g. FedEx Home Delivery, which returns a larger page) prints the SAME size
// as the USPS/UPS labels instead of dwarfing them.
//
// PS-287 (display/PDF-rendering only): the standard-4x6 branch is now
// CONTENT-AWARE. Instead of copying a near-4x6 page byte-for-byte (which
// preserved internally shifted/small/off-center artwork — e.g. a UPS Ground
// Saver / USPS handoff label with excess whitespace), we derive the visible
// artwork bounds from the page's PDF box hints (CropBox / TrimBox vs the
// MediaBox) and place that artwork scaled-to-fit + centered on a clean 288x432
// canvas (aspect preserved, small safe margin). The geometry lives in the pure
// print-queue-artwork-fit.ts helper.
//
//  - A ROTATED page is now ALSO normalized (PS-287, 2026-06-23): its PDF /Rotate is
//    BAKED onto the clean 288x432 canvas (placeRotatedArtworkOnCanvas) so it prints
//    upright at 4x6, instead of being copied byte-for-byte at its original
//    sideways/oversized size.
//  - An oversized or near-4x6 un-rotated page is content-aware fitted (its artwork
//    re-centered/scaled) rather than copied byte-for-byte.
//
// Mutates nothing but the in-memory merged print PDF — no label bytes, postage,
// shipments, or shipped/cancelled order data are touched.
export async function appendNormalizedLabelPages(
  merged: import('pdf-lib').PDFDocument,
  labelDoc: import('pdf-lib').PDFDocument,
): Promise<void> {
  const TARGET_W = 288;
  const TARGET_H = 432;
  const ARTWORK_MARGIN = 6;
  const labelPages = labelDoc.getPages();
  for (const src of labelPages) {
    const rotation = (((src.getRotation().angle ?? 0) % 360) + 360) % 360;
    // Content-aware: clip to the visible-artwork bounds (box hints) and place that
    // artwork scaled-to-fit + centered on a clean 4x6 canvas. embedPage IGNORES the
    // page's /Rotate (verified), so embedded dims are the UNROTATED content.
    const bounds = deriveArtworkBounds(src);
    const [embedded] = await merged.embedPages(
      [src],
      [{ left: bounds.x, bottom: bounds.y, right: bounds.x + bounds.width, top: bounds.y + bounds.height }],
    );
    if (!embedded) continue;
    const page = merged.addPage([TARGET_W, TARGET_H]);
    if (rotation !== 0) {
      // PS-287 (Per user override unlock shipped data on 2026-06-23): a ROTATED label is no
      // longer copied byte-for-byte (which preserved its sideways/oversized size). Bake its
      // /Rotate onto the clean 288x432 canvas so it prints UPRIGHT at 4x6 like the rest.
      const rp = placeRotatedArtworkOnCanvas({
        artworkW: embedded.width,
        artworkH: embedded.height,
        rotation,
        canvasW: TARGET_W,
        canvasH: TARGET_H,
        margin: ARTWORK_MARGIN,
      });
      page.drawPage(embedded, {
        x: rp.x,
        y: rp.y,
        width: rp.drawWidth,
        height: rp.drawHeight,
        rotate: degrees(rp.rotateDegrees),
      });
      continue;
    }
    const placed = placeArtworkOnCanvas({
      artworkW: embedded.width,
      artworkH: embedded.height,
      canvasW: TARGET_W,
      canvasH: TARGET_H,
      margin: ARTWORK_MARGIN,
    });
    page.drawPage(embedded, {
      x: placed.x,
      y: placed.y,
      width: placed.drawWidth,
      height: placed.drawHeight,
    });
  }
}

function safePdfText(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u00D7]/g, 'x')
    .replace(/[^\x20-\x7E]/g, '');
}

// PS-070 — resolve the pickable lines for a queue entry. Blank-SKU eBay lines
// are NO LONGER dropped: collapseIdentityLines keeps them keyed by title/id so
// multi-SKU combos stay complete and a no-SKU order still has a real identity.
// When there's no multi_sku_data, synthesize a single line from the primary
// sku / item description and run it through the same resolver, so a no-SKU
// order falls back to its title (or an explicit UNRESOLVED) — never the old
// "UNKNOWN SKU".
function collapseQueueSkuLines(
  entry: Pick<PrintQueueEntry, 'multiSkuData' | 'primarySku' | 'itemDescription' | 'orderQty'>,
): CollapsedQueueLine[] {
  const fromMulti = collapseIdentityLines(entry.multiSkuData);
  if (fromMulti.length > 0) return fromMulti;

  const sku = String(entry.primarySku ?? '').trim();
  const description = String(entry.itemDescription ?? '').trim();
  if (!sku && !description) return [];
  return collapseIdentityLines([{ sku, description, qty: entry.orderQty }]);
}

// ───────────────────────────────────────────────────────────────────
// PS-073 — Customer-name reference + Batch Manifest support.
// Per user override unlock shipped data on 2026-06-02: the Print Queue
// batch header/merge reads orders.shipToName (a shipped-data read path)
// to print a privacy-safe recipient-name rescue surface. This block adds
// ONLY read/derivation of recipient names + order numbers. It must never
// surface addresses, emails, phones, tracking numbers, label URLs, raw
// provider payloads, tokens, or secrets, and it does not mutate any
// shipped/cancelled order, shipment, or label record.
// ───────────────────────────────────────────────────────────────────

// Batches at or below this many orders show recipient names directly on
// the 4x6 batch header; larger batches get a dedicated Batch Manifest
// page instead so the header stays legible (see planBatchNamesDisplay).
export const BATCH_NAMES_HEADER_THRESHOLD = 30;

// The ONLY recipient fields allowed past this boundary. Intentionally
// minimal so address/email/phone/tracking can never ride along.
export type BatchRecipient = { name: string; orderNumber: string };

// Resolve a privacy-safe display name. Returns the recipient name when
// present, otherwise a safe order-number fallback — never PII.
export function resolveRecipientDisplayName(input: {
  shipToName?: string | null;
  orderNumber?: string | null;
  orderId?: string | null;
}): BatchRecipient {
  const orderNumber = String(input.orderNumber ?? input.orderId ?? '').trim();
  const name = String(input.shipToName ?? '').trim();
  if (name) return { name, orderNumber };
  return {
    name: orderNumber ? `Order ${orderNumber}` : 'Unnamed recipient',
    orderNumber,
  };
}

// Deterministic, case-insensitive ordering so the printed list is stable
// across renders (name, then order number to break ties).
export function sortBatchRecipients(list: BatchRecipient[]): BatchRecipient[] {
  return [...list].sort((a, b) => {
    const byName = a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase());
    return byName !== 0 ? byName : a.orderNumber.localeCompare(b.orderNumber);
  });
}

// Flag duplicate recipient names so the manifest can disambiguate them
// with their order number.
export function annotateDuplicateNames(
  list: BatchRecipient[]
): Array<BatchRecipient & { duplicate: boolean }> {
  const counts = new Map<string, number>();
  for (const r of list) {
    const key = r.name.toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return list.map((r) => ({
    ...r,
    duplicate: (counts.get(r.name.toLocaleLowerCase()) ?? 0) > 1,
  }));
}

// Decide whether names go on the header or spill to a manifest page.
// Above the threshold the header shows a compact pointer only (no list)
// so we never cram 40-60+ names onto a 4x6 slip.
export function planBatchNamesDisplay(
  count: number,
  threshold = BATCH_NAMES_HEADER_THRESHOLD
): { onHeader: boolean; needsManifest: boolean } {
  if (count <= threshold) return { onHeader: true, needsManifest: false };
  return { onHeader: false, needsManifest: true };
}

export function drawMockFallbackLabel(
  page: ReturnType<import('pdf-lib').PDFDocument['addPage']>,
  entry: PrintQueueEntry,
  font: import('pdf-lib').PDFFont,
  fontReg: import('pdf-lib').PDFFont,
  rgb: typeof import('pdf-lib').rgb,
  reason: string
) {
  const { width, height } = page.getSize();
  const pad = 14;
  const red = rgb(0.85, 0, 0);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.38, 0.38, 0.38);

  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 0, y: height - 36, width, height: 36, color: red });
  page.drawText('VOID - TEST LABEL - DO NOT SHIP', {
    x: pad,
    y: height - 24,
    size: 10,
    font,
    color: rgb(1, 1, 1),
  });

  page.drawText('PrepShip Test Label', { x: pad, y: height - 62, size: 16, font, color: black });
  page.drawText(safePdfText(`Order: ${entry.orderNumber ?? entry.orderId}`), { x: pad, y: height - 84, size: 10, font: fontReg, color: black });
  // PS-070 — never print a confident "SKU: Unknown SKU"; show the real sku or a
  // safe no-SKU/unresolved note (the title is drawn just below).
  const fallbackIdentity = resolveQueueLineIdentity({ sku: entry.primarySku, description: entry.itemDescription });
  page.drawText(safePdfText(fallbackIdentity.sku ? `SKU: ${fallbackIdentity.sku}` : fallbackIdentity.skuLineText), { x: pad, y: height - 104, size: 10, font: fontReg, color: black });
  page.drawText(safePdfText(`Qty: ${entry.orderQty ?? 1}`), { x: pad, y: height - 124, size: 10, font: fontReg, color: black });
  if (entry.itemDescription) {
    page.drawText(safePdfText(entry.itemDescription).slice(0, 48), { x: pad, y: height - 144, size: 8, font: fontReg, color: gray });
  }

  page.drawRectangle({ x: pad, y: 122, width: width - pad * 2, height: 72, borderColor: black, borderWidth: 1 });
  let x = pad + 8;
  for (let i = 0; i < 70; i += 1) {
    const barWidth = i % 3 === 0 ? 2 : 1;
    if (i % 4 !== 0) {
      page.drawRectangle({ x, y: 132, width: barWidth, height: 52, color: black });
    }
    x += barWidth + 2;
    if (x > width - pad - 8) break;
  }

  page.drawText('Fallback mock PDF page', { x: pad, y: 86, size: 9, font, color: black });
  page.drawText(safePdfText(reason).slice(0, 70), { x: pad, y: 70, size: 7, font: fontReg, color: gray });
}

// PS-073 — SVG path for a filled rounded rectangle, used for the prominent
// "BATCH HEADER" pill (the approved mock shows a rounded bar, not a full-bleed
// strip). pdf-lib's drawSvgPath places (0,0) at the given (x,y) and draws with
// y increasing DOWNWARD, so pass the pill's TOP-edge y and it fills downward.
function roundedRectSvgPath(w: number, h: number, r: number): string {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  return [
    `M ${rad} 0`,
    `H ${w - rad}`,
    `Q ${w} 0 ${w} ${rad}`,
    `V ${h - rad}`,
    `Q ${w} ${h} ${w - rad} ${h}`,
    `H ${rad}`,
    `Q 0 ${h} 0 ${h - rad}`,
    `V ${rad}`,
    `Q 0 0 ${rad} 0`,
    'Z',
  ].join(' ');
}

export function drawHeader(
  page: ReturnType<import('pdf-lib').PDFDocument['addPage']>,
  entry: PrintQueueEntry,
  totalOrders: number,
  font: import('pdf-lib').PDFFont,
  fontReg: import('pdf-lib').PDFFont,
  rgb: typeof import('pdf-lib').rgb,
  // 2026-05-14: drawHeader now takes an isTest flag so it can stamp
  // a small red "TEST" marker on the BATCH HEADER bar when the
  // entry's label URL is a mock (i.e. the operator is running the
  // test-order flow rather than a real shipment). Layout below the
  // bar is identical between test and real — only the marker changes
  // — so what an operator sees in test prints faithfully predicts
  // what their boss will see in real prints.
  isTest = false,
  // PS-073 (per user override unlock shipped data on 2026-06-02):
  // recipients holds the privacy-safe name list for THIS batch group
  // (already client-scoped + sorted); threshold governs header-vs-
  // manifest. Returns whether a Batch Manifest page is still required
  // (i.e. names did not fit on the header).
  recipients: BatchRecipient[] = [],
  threshold = BATCH_NAMES_HEADER_THRESHOLD,
  // Compact "LxWxH" package hint (e.g. 11x8x6) drawn under the QTY line so the
  // packer knows what size box to use. null/empty omits the line entirely.
  packageDims: string | null = null
): { manifestNeeded: boolean } {
  const { width, height } = page.getSize();
  const cx = width / 2;
  const pad = 16;

  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
  // PS-073 — prominent rounded "BATCH HEADER" pill (matches the approved mock)
  // instead of a full-bleed strip. Inset with side margins + a small top margin;
  // the pill still occupies the top ~40pt band so content below is unchanged.
  const barH = 30;
  const barTop = height - 6; // PDF y of the pill's top edge
  const barW = width - pad * 2;
  page.drawSvgPath(roundedRectSvgPath(barW, barH, 8), {
    x: pad,
    y: barTop,
    color: rgb(0.1, 0.1, 0.1),
  });
  const headerTitle = 'BATCH HEADER';
  const headerTitleSize = 15;
  const headerBaseline = barTop - barH / 2 - headerTitleSize / 2 + 2;
  page.drawText(headerTitle, {
    x: cx - font.widthOfTextAtSize(headerTitle, headerTitleSize) / 2,
    y: headerBaseline,
    size: headerTitleSize,
    font,
    color: rgb(1, 1, 1),
  });
  // Test-mode stamp: small red "TEST" at the right end of the pill. Doesn't
  // shift any other content.
  if (isTest) {
    const testLabel = 'TEST';
    const testSize = 11;
    page.drawText(testLabel, {
      x: pad + barW - 12 - font.widthOfTextAtSize(testLabel, testSize),
      y: barTop - barH / 2 - testSize / 2 + 1,
      size: testSize,
      font,
      color: rgb(1, 0.45, 0.45),
    });
  }

  const ink = rgb(0.1, 0.1, 0.1);
  const sub = rgb(0.45, 0.45, 0.45);

  // Truncate text with an ellipsis so long names/SKUs never overrun
  // their column or the page edge.
  const fitText = (text: string, size: number, f: typeof font, maxW: number): string => {
    let t = safePdfText(text);
    if (f.widthOfTextAtSize(t, size) <= maxW) return t;
    while (t.length > 1 && f.widthOfTextAtSize(`${t}...`, size) > maxW) t = t.slice(0, -1);
    return `${t}...`;
  };

  // PS — wrap the FULL text across multiple lines so a long product name is
  // shown COMPLETELY instead of being shrunk + cut off with "...". Greedy
  // word-wrap at the given size; a single word wider than the column is
  // hard-broken. Only the LAST kept line is ellipsized, and only if the text
  // exceeds `maxLines` (a safety cap so a many-SKU combo can't overrun the
  // 4x6). Per user override unlock shipped data on 2026-06-02: display-only
  // change to the PS-073 batch header — reads no new fields, mutates nothing.
  const wrapText = (
    text: string,
    size: number,
    f: typeof font,
    maxW: number,
    maxLines: number,
  ): string[] => {
    const clean = safePdfText(text).replace(/\s+/g, ' ').trim();
    if (!clean) return [''];
    if (f.widthOfTextAtSize(clean, size) <= maxW) return [clean];

    // Hard-break a single word that is itself wider than the column.
    const breakLongWord = (word: string, out: string[]): string => {
      let w = word;
      while (w.length > 1 && f.widthOfTextAtSize(w, size) > maxW) {
        let lo = 1;
        let hi = w.length;
        let fit = 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (f.widthOfTextAtSize(w.slice(0, mid), size) <= maxW) {
            fit = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        out.push(w.slice(0, fit));
        w = w.slice(fit);
      }
      return w;
    };

    const lines: string[] = [];
    let current = '';
    for (const word of clean.split(' ')) {
      const candidate = current ? `${current} ${word}` : word;
      if (f.widthOfTextAtSize(candidate, size) <= maxW) {
        current = candidate;
        continue;
      }
      if (current) {
        lines.push(current);
        current = '';
      }
      current = f.widthOfTextAtSize(word, size) > maxW ? breakLongWord(word, lines) : word;
    }
    if (current) lines.push(current);

    if (lines.length <= maxLines) return lines;

    // Over the cap: keep the first maxLines lines, ellipsize the last kept one.
    const kept = lines.slice(0, maxLines);
    let last = kept.pop() ?? '';
    while (last.length > 1 && f.widthOfTextAtSize(`${last}...`, size) > maxW) {
      last = last.slice(0, -1);
    }
    kept.push(`${last}...`);
    return kept;
  };

  // ── 1) Item/pick cards (top): product name left, xN right, sku below.
  // Every SKU in a multi-SKU combo gets its own outlined card; a single
  // SKU still renders as one card so the layout is consistent.
  const cards: CollapsedQueueLine[] = (() => {
    const lines = collapseQueueSkuLines(entry);
    if (lines.length > 0) return lines;
    // PS-070 — no usable sku/title/id: flag UNRESOLVED, never a fake pickable SKU.
    const qtyValue = Number(entry.orderQty);
    const id = resolveQueueLineIdentity({});
    return [{
      sku: id.sku,
      description: id.title,
      qty: Number.isFinite(qtyValue) && qtyValue > 0 ? Math.trunc(qtyValue) : 1,
      groupToken: id.groupToken,
      kind: id.kind,
      cardTitle: id.cardTitle,
      skuLineText: id.skuLineText,
    }];
  })();

  // Cap how many cards render so a high-SKU combo can't push the order
  // count into negative space (the count has a font-size floor). Hidden
  // SKUs are summarised in a "+N more" line; the QTY total below still
  // counts ALL SKUs, and the manifest combo line lists every SKU.
  const MAX_HEADER_CARDS = 6;
  const visibleCards = cards.slice(0, MAX_HEADER_CARDS);
  const hiddenCardCount = cards.length - visibleCards.length;

  // Card/text sizes scale down as the SKU count grows so the mock's bold
  // card look is preserved for the common 1-2 SKU case while many-SKU
  // combos still fit. (Big, prominent product-name cards per the design.)
  const n = cards.length;
  const cardH = n <= 2 ? 42 : n === 3 ? 38 : n <= 5 ? 33 : 28;
  const cardGap = n <= 3 ? 8 : n <= 5 ? 6 : 5;
  const titleSize = n <= 2 ? 18 : n === 3 ? 16 : n <= 5 ? 14 : 12.5;
  const skuSize = n <= 3 ? 10.5 : 9;
  const qtySize = n <= 2 ? 19 : n <= 5 ? 16 : 15;

  // PS-073 — adaptive product-name font. A short/normal name keeps the bold
  // default size (the design default — e.g. "Leeds Line V2"); only a LONG name
  // steps the font down so the full name stays visible without ballooning into
  // an oversized multi-line block. The driver is the name's NATURAL wrapped
  // line count at the default size (measured with a high cap so it never
  // ellipsizes here), not the SKU count. Floor keeps it legible.
  const TITLE_MIN_SIZE = n <= 2 ? 11 : 10;
  const fitTitleSize = (text: string, maxW: number): number => {
    const naturalLines = wrapText(text, titleSize, font, maxW, 99).length;
    if (naturalLines <= 2) return titleSize; // short/normal -> default, no shrink
    // Long name: drop ~1.5pt per extra line beyond 2, clamped to [min, default].
    const stepped = titleSize - (naturalLines - 2) * 1.5;
    return Math.max(TITLE_MIN_SIZE, Math.min(titleSize, stepped));
  };

  let y = height - 40 - 12;
  for (const item of visibleCards) {
    const boxW = width - pad * 2;
    const qtyText = `x${item.qty}`;
    const qtyW = font.widthOfTextAtSize(qtyText, qtySize);

    // PS — show the FULL product name. Wrap it across as many lines as needed
    // and grow the card to fit, instead of shrinking to one line and cutting
    // it off with "...". `maxTitleLines` caps height per SKU count so a
    // many-SKU combo still fits a 4x6; the common 1-2 SKU case (lots of free
    // space) gets enough lines to show everything.
    const maxTitleLines = n <= 2 ? 6 : n === 3 ? 3 : n <= 5 ? 2 : 1;
    const titleMaxW = boxW - 24 - qtyW - 8;
    // PS-109: never render the SKU as the product name; show "Unnamed item" when no
    // real name is available, with the real "sku: X" still on the line below.
    const titleText = headerCardTitle(item);
    // Shrink only when the name is genuinely long (see fitTitleSize); short
    // names render at the default size unchanged.
    const itemTitleSize = fitTitleSize(titleText, titleMaxW);
    const titleLines = wrapText(titleText, itemTitleSize, font, titleMaxW, maxTitleLines);

    // Dynamic card height: keep the original fixed height for a single-line
    // title (so single-line cards — and the recipient-names vertical budget —
    // are byte-identical to before) and add ONE line-height per EXTRA wrapped
    // line. This is what stops a wrapped name from silently stealing space
    // from the names list when it isn't needed.
    const titleLineH = Math.round(itemTitleSize * 1.18);
    const dynCardH = cardH + Math.max(0, titleLines.length - 1) * titleLineH;

    // PS-073 — rounded item card (matches the approved mock). drawSvgPath takes
    // the TOP-edge y and fills downward, so pass `y` (the card's top).
    page.drawSvgPath(roundedRectSvgPath(boxW, dynCardH, 6), {
      x: pad,
      y,
      color: rgb(0.94, 0.98, 1),
      borderColor: rgb(0.55, 0.7, 0.9),
      borderWidth: 1.25,
    });

    // Product NAME is the prominent card title; sku sits smaller below.
    // PS-070 — cardTitle prefers the product title; skuLineText is either a real
    // "sku: X" or a safe "no SKU — eBay item" / UNRESOLVED note, never a
    // confident "sku: UNKNOWN SKU". The first title line keeps the original
    // baseline; extra wrapped lines flow downward into the grown card.
    const firstTitleBaseline = y - Math.round(cardH * 0.46);
    let ty = firstTitleBaseline;
    for (const line of titleLines) {
      page.drawText(line, { x: pad + 12, y: ty, size: itemTitleSize, font, color: ink });
      ty -= titleLineH;
    }
    // QTY stays aligned with the first title line, top-right.
    page.drawText(qtyText, { x: pad + boxW - 12 - qtyW, y: firstTitleBaseline, size: qtySize, font, color: ink });
    // sku line sits at the bottom of the (possibly taller) card — same offset
    // from the bottom edge as the original layout.
    const skuBaseline = y - dynCardH + Math.round(skuSize * 0.7) + 5;
    page.drawText(fitText(item.skuLineText || (item.sku ? `sku: ${item.sku}` : NO_SKU_PICK_NOTE), skuSize, fontReg, boxW - 24), {
      x: pad + 12,
      y: skuBaseline,
      size: skuSize,
      font: fontReg,
      color: sub,
    });
    y -= dynCardH + cardGap;
  }
  if (hiddenCardCount > 0) {
    page.drawText(safePdfText(`+${hiddenCardCount} more SKU${hiddenCardCount === 1 ? '' : 's'} (full combo on manifest)`), {
      x: pad + 2,
      y: y - 9,
      size: 9,
      font: fontReg,
      color: sub,
    });
    y -= 15;
  }

  // ── 2) Total units per order ──
  const totalUnits = cards.reduce((sum, item) => sum + item.qty, 0);
  y -= 2;
  page.drawText(`QTY: ${totalUnits} total unit${totalUnits === 1 ? '' : 's'} per order`, {
    x: pad,
    y: y - 13,
    size: 13.5,
    font,
    color: ink,
  });
  y -= 24;

  // ── 2b) Package size hint (helps the packer pick the right box) ──
  // Drawn directly under the QTY line. Omitted when no dimensions are known so
  // the layout below (ORDERS count + names) reflows exactly as before.
  if (packageDims) {
    page.drawText(safePdfText(`Package: ${packageDims}`), {
      x: pad,
      y: y - 11,
      size: 11.5,
      font: fontReg,
      color: sub,
    });
    y -= 18;
  }

  // ── Decide names placement (header list vs manifest pointer) ──
  const regionTop = y;
  const regionBottom = 14; // floor above the footer line at y=4
  const plan = planBatchNamesDisplay(recipients.length, threshold);
  const nameRowH = 11.5;
  const namesTitleH = 18;
  const listBoxPad = 8;
  const dividerGap = 14;
  const labelSize = 15;
  const MIN_COUNT_FONT = 40;
  const MAX_COUNT_FONT = 60;
  const available = regionTop - regionBottom;
  const pointerH = 22;

  let renderNamesOnHeader = plan.onHeader && recipients.length > 0;
  let manifestPointer = plan.needsManifest;

  // Adaptive column count for the names list. Small batches keep the approved
  // 2-column look; larger batches (e.g. 20-30 names) widen to 3-4 columns so
  // the list stays SHORT enough to fit on the header without crushing the
  // ORDERS count below MIN_COUNT_FONT. Without this a header-sized batch
  // (<= threshold) could still spill to a manifest purely because 2 columns
  // made the list too tall. Cols never exceed 4 so names stay legible on the
  // 256pt-wide content area (≈64pt/col at 4).
  const maxNamesZoneH = available - dividerGap - labelSize - 4 - 10 - MIN_COUNT_FONT;
  const maxNameRows = Math.max(1, Math.floor((maxNamesZoneH - namesTitleH - listBoxPad) / nameRowH));
  let cols = 2;
  while (cols < 4 && Math.ceil(recipients.length / cols) > maxNameRows) cols += 1;
  const nameRows = Math.ceil(recipients.length / cols);
  let namesZoneH = renderNamesOnHeader ? namesTitleH + nameRows * nameRowH + listBoxPad : 0;

  // ── 3) Big ORDERS count — top-anchored, sized to leave room for the names
  // section DIRECTLY below it (matches the approved 2nd-image mock). The count
  // font is capped so the count + names stay compact at the top and the leftover
  // space falls to the BOTTOM of the page, instead of pinning names to the page
  // floor with a big gap between the count and the list.
  const reservedBelowCount = renderNamesOnHeader ? namesZoneH + dividerGap : manifestPointer ? pointerH : 0;
  let countFontSize = Math.floor(available - reservedBelowCount - labelSize - 4 - 10);
  if (renderNamesOnHeader && countFontSize < MIN_COUNT_FONT) {
    // names would crush the count below the legible floor -> spill to a manifest.
    renderNamesOnHeader = false;
    manifestPointer = true;
    namesZoneH = 0;
    countFontSize = Math.floor(available - (manifestPointer ? pointerH : 0) - labelSize - 16);
  }
  countFontSize = Math.max(MIN_COUNT_FONT, Math.min(MAX_COUNT_FONT, countFontSize));
  const manifestNeeded = manifestPointer;

  const countStr = String(totalOrders);
  const countW = font.widthOfTextAtSize(countStr, countFontSize);
  const countBlockH = countFontSize + 4 + labelSize;
  const countBlockTop = regionTop - 6;
  page.drawText(countStr, {
    x: cx - countW / 2,
    y: countBlockTop - countFontSize,
    size: countFontSize,
    font,
    color: rgb(0.05, 0.05, 0.05),
  });
  const labelStr = `ORDER${totalOrders === 1 ? '' : 'S'}`;
  page.drawText(labelStr, {
    x: cx - font.widthOfTextAtSize(labelStr, labelSize) / 2,
    y: countBlockTop - countFontSize - labelSize - 4,
    size: labelSize,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });
  const countBlockBottom = countBlockTop - countBlockH;

  // ── 4) Names reference area — DIRECTLY below the ORDERS count ──
  if (renderNamesOnHeader) {
    const zoneTop = countBlockBottom - dividerGap;
    // thin divider between the count and the names section.
    page.drawLine({
      start: { x: pad, y: zoneTop + 6 },
      end: { x: width - pad, y: zoneTop + 6 },
      thickness: 0.75,
      color: rgb(0.85, 0.85, 0.85),
    });
    page.drawText(safePdfText(`Names in this batch (${recipients.length})`), {
      x: pad,
      y: zoneTop - 13,
      size: 12.5,
      font,
      color: ink,
    });
    const listTop = zoneTop - namesTitleH;
    const listBoxH = nameRows * nameRowH + listBoxPad;
    page.drawSvgPath(roundedRectSvgPath(width - pad * 2, listBoxH, 6), {
      x: pad,
      y: listTop,
      color: rgb(0.99, 0.99, 0.99),
      borderColor: rgb(0.85, 0.85, 0.85),
      borderWidth: 1,
    });
    const colW = (width - pad * 2) / cols;
    const nameSize = 9;
    recipients.forEach((recipient, i) => {
      const col = i % cols;
      const rowIdx = Math.floor(i / cols);
      const tx = pad + 10 + col * colW;
      const ty = listTop - 11 - rowIdx * nameRowH;
      page.drawText(fitText(recipient.name.toLocaleUpperCase(), nameSize, fontReg, colW - 16), {
        x: tx,
        y: ty,
        size: nameSize,
        font: fontReg,
        color: rgb(0.2, 0.2, 0.2),
      });
    });
  } else if (manifestPointer && recipients.length > 0) {
    page.drawText(safePdfText(`Names: see Batch Manifest page (${recipients.length}) >`), {
      x: pad,
      y: countBlockBottom - 16,
      size: 11,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });
  }

  // PS-073 footer (matches the approved mock): the names list is a secondary
  // rescue/reference surface — primary picking info stays at the top. Sits below
  // the names region floor (regionBottom) so it never overlaps the list.
  const footerText = 'Reference only - primary picking info stays at top';
  const footerSize = 7.5;
  page.drawText(safePdfText(footerText), {
    x: cx - fontReg.widthOfTextAtSize(footerText, footerSize) / 2,
    y: 4,
    size: footerSize,
    font: fontReg,
    color: rgb(0.55, 0.55, 0.55),
  });

  return { manifestNeeded };
}

// Module-level ellipsis truncation (mirrors drawHeader's local fitText)
// so the manifest can clip long names without overrunning columns.
function ellipsizePdf(
  text: string,
  size: number,
  f: import('pdf-lib').PDFFont,
  maxW: number
): string {
  let t = safePdfText(text);
  if (f.widthOfTextAtSize(t, size) <= maxW) return t;
  while (t.length > 1 && f.widthOfTextAtSize(`${t}...`, size) > maxW) t = t.slice(0, -1);
  return `${t}...`;
}

// PS-073: how many recipient names fit on a single Batch Manifest page
// (3 columns x 24 rows). Drives pagination for very large batches.
const MANIFEST_NAMES_PER_PAGE = 72;

// PS-073 (per user override unlock shipped data on 2026-06-02):
// Draw ONE Batch Manifest page. Lists recipient names for a batch group
// with order numbers used ONLY to disambiguate duplicate/fallback names.
// Never renders addresses, emails, phones, tracking, or label data.
function drawManifestPage(
  page: ReturnType<import('pdf-lib').PDFDocument['addPage']>,
  opts: {
    comboLine: string;
    totalOrders: number;
    totalUnits: number;
    recipients: Array<BatchRecipient & { duplicate: boolean }>;
    pageIndex: number;
    pageCount: number;
    isTest: boolean;
    font: import('pdf-lib').PDFFont;
    fontReg: import('pdf-lib').PDFFont;
    rgb: typeof import('pdf-lib').rgb;
  }
) {
  const { font, fontReg, rgb } = opts;
  const { width, height } = page.getSize();
  const cx = width / 2;
  const pad = 16;
  const ink = rgb(0.1, 0.1, 0.1);
  const sub = rgb(0.45, 0.45, 0.45);

  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 0, y: height - 40, width, height: 40, color: rgb(0.1, 0.1, 0.1) });
  const titleText = 'BATCH MANIFEST';
  page.drawText(titleText, {
    x: cx - font.widthOfTextAtSize(titleText, 13) / 2,
    y: height - 27,
    size: 13,
    font,
    color: rgb(1, 1, 1),
  });
  if (opts.isTest) {
    const testLabel = 'TEST';
    const testSize = 11;
    page.drawText(testLabel, {
      x: width - pad - font.widthOfTextAtSize(testLabel, testSize),
      y: height - 26,
      size: testSize,
      font,
      color: rgb(1, 0.45, 0.45),
    });
  }

  let y = height - 40 - 18;
  page.drawText(ellipsizePdf(opts.comboLine, 11, font, width - pad * 2), {
    x: pad,
    y,
    size: 11,
    font,
    color: ink,
  });
  y -= 16;
  page.drawText(
    safePdfText(`${opts.totalOrders} order${opts.totalOrders === 1 ? '' : 's'} | QTY: ${opts.totalUnits} total unit${opts.totalUnits === 1 ? '' : 's'} per order`),
    { x: pad, y, size: 10, font: fontReg, color: sub }
  );
  y -= 16;
  if (opts.pageCount > 1) {
    page.drawText(safePdfText(`Page ${opts.pageIndex + 1} of ${opts.pageCount}`), {
      x: pad,
      y,
      size: 9,
      font: fontReg,
      color: sub,
    });
    y -= 12;
  }
  page.drawLine({
    start: { x: pad, y: y - 2 },
    end: { x: width - pad, y: y - 2 },
    thickness: 1,
    color: rgb(0.85, 0.85, 0.85),
  });
  y -= 16;

  // 3-column name grid. Duplicate / fallback names get their order
  // number appended so identical names stay distinguishable.
  const cols = 3;
  const colW = (width - pad * 2) / cols;
  const rowH = 12;
  const nameSize = 8.5;
  const listTop = y;
  opts.recipients.forEach((recipient, i) => {
    const col = i % cols;
    const rowIdx = Math.floor(i / cols);
    const tx = pad + 4 + col * colW;
    const ty = listTop - rowIdx * rowH;
    const needsOrderNo = recipient.duplicate && recipient.orderNumber
      && !recipient.name.startsWith('Order ');
    // Reserve the disambiguating suffix width FIRST, then ellipsize only
    // the name part — so the (#orderNumber) that distinguishes duplicate
    // names is never the thing that gets truncated away.
    const suffix = needsOrderNo ? safePdfText(` (#${recipient.orderNumber})`.toLocaleUpperCase()) : '';
    const suffixW = suffix ? fontReg.widthOfTextAtSize(suffix, nameSize) : 0;
    const namePart = ellipsizePdf(
      recipient.name.toLocaleUpperCase(),
      nameSize,
      fontReg,
      Math.max(12, colW - 8 - suffixW)
    );
    page.drawText(`${namePart}${suffix}`, {
      x: tx,
      y: ty,
      size: nameSize,
      font: fontReg,
      color: rgb(0.2, 0.2, 0.2),
    });
  });
}

// Append all Batch Manifest pages for one group to the document, splitting
// across pages when a group has more names than fit on a single page.
export function addBatchManifestPages(
  addPage: () => ReturnType<import('pdf-lib').PDFDocument['addPage']>,
  meta: {
    recipients: BatchRecipient[];
    totalOrders: number;
    totalUnits: number;
    comboLine: string;
    isTest: boolean;
  },
  font: import('pdf-lib').PDFFont,
  fontReg: import('pdf-lib').PDFFont,
  rgb: typeof import('pdf-lib').rgb
) {
  const annotated = annotateDuplicateNames(meta.recipients);
  const pageCount = Math.max(1, Math.ceil(annotated.length / MANIFEST_NAMES_PER_PAGE));
  for (let p = 0; p < pageCount; p += 1) {
    const slice = annotated.slice(p * MANIFEST_NAMES_PER_PAGE, (p + 1) * MANIFEST_NAMES_PER_PAGE);
    drawManifestPage(addPage(), {
      comboLine: meta.comboLine,
      totalOrders: meta.totalOrders,
      totalUnits: meta.totalUnits,
      recipients: slice,
      pageIndex: p,
      pageCount,
      isTest: meta.isTest,
      font,
      fontReg,
      rgb,
    });
  }
}

// Build a short item-combo summary line (e.g. "Booster Gel x1 + HU-10 x2")
// for the manifest header from the representative entry of a group.
export function buildComboSummaryLine(entry: PrintQueueEntry): { comboLine: string; totalUnits: number } {
  const lines = collapseQueueSkuLines(entry);
  const id = resolveQueueLineIdentity({});
  const cards: CollapsedQueueLine[] = lines.length > 0
    ? lines
    : [{
        sku: id.sku,
        description: id.title,
        qty: Math.max(1, Math.trunc(Number(entry.orderQty) || 1)),
        groupToken: id.groupToken,
        kind: id.kind,
        cardTitle: id.cardTitle,
        skuLineText: id.skuLineText,
      }];
  const comboLine = cards
    // PS-070 — show the title for no-SKU lines, never a bare "UNKNOWN SKU".
    .map((c) => `${headerCardTitle(c)} x${c.qty}`)
    .join(' + ');
  const totalUnits = cards.reduce((sum, c) => sum + c.qty, 0);
  return { comboLine, totalUnits };
}

// PS-073: test-only renderer. Builds the header (+ manifest pages when
// needed) for a single batch group using IN-MEMORY fixture data so guards
// can certify layout/behaviour WITHOUT fetching labels, buying postage,
// touching the network, or reading the database. Fixtures must use fake
// names only.
export async function renderBatchHeaderPdfForTest(input: {
  entry: PrintQueueEntry;
  totalOrders: number;
  recipients: BatchRecipient[];
  isTest?: boolean;
  threshold?: number;
  packageDims?: string | null;
}): Promise<Uint8Array> {
  const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);

  const sortedRecipients = sortBatchRecipients(input.recipients);
  const headerPage = doc.addPage([288, 432]);
  const { manifestNeeded } = drawHeader(
    headerPage,
    input.entry,
    input.totalOrders,
    font,
    fontReg,
    rgb,
    input.isTest ?? false,
    sortedRecipients,
    input.threshold ?? BATCH_NAMES_HEADER_THRESHOLD,
    input.packageDims ?? null
  );

  if (manifestNeeded) {
    const { comboLine, totalUnits } = buildComboSummaryLine(input.entry);
    addBatchManifestPages(
      () => doc.addPage([288, 432]),
      {
        recipients: sortedRecipients,
        totalOrders: input.totalOrders,
        totalUnits,
        comboLine,
        isTest: input.isTest ?? false,
      },
      font,
      fontReg,
      rgb
    );
  }

  return doc.save();
}
