/**
 * PS-442 presentation-only guard.
 *
 * Reads source files only. It does not call an API, queue a label, spend postage,
 * notify a marketplace, or mutate order/shipment data.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const toolbar = readFileSync('web/src/components/Views/OrdersFilterToolbar.tsx', 'utf8');
const home = readFileSync('web/src/Home.tsx', 'utf8');

const widgetStart = toolbar.indexOf('id="queue-progress-indicator"');
const widgetEnd = toolbar.indexOf("const slot = typeof document", widgetStart);
assert.ok(widgetStart >= 0 && widgetEnd > widgetStart, 'queue progress widget must remain present');
const widget = toolbar.slice(widgetStart, widgetEnd);

assert.match(widget, /role="status"/);
assert.match(widget, /aria-live="polite"/);
assert.match(widget, /aria-atomic="true"/);
assert.match(widget, /aria-label=\{statusLabel\}/);
assert.match(widget, /role="progressbar"/);
assert.match(widget, /aria-label=\{`\$\{queueToolbarProgress\.label\}: \$\{queueToolbarProgress\.pct\}% complete`\}/);
assert.match(widget, /useHeaderSlot \? 'z-\[1300\]' : 'z-10'/);
assert.match(widget, /w-\[clamp\(280px,21\.5vw,340px\)\]/);

const titleIndex = widget.indexOf('{queueToolbarProgress.label}');
const progressbarIndex = widget.indexOf('role="progressbar"');
const detailIndex = widget.indexOf('data-queue-progress-detail');
assert.ok(titleIndex >= 0 && titleIndex < progressbarIndex && progressbarIndex < detailIndex,
  'widget must render title/percentage, full-width progressbar, then detail');

const detailEnd = widget.indexOf('</span>', detailIndex);
assert.ok(detailEnd > detailIndex, 'queue progress detail span must close');
const detail = widget.slice(detailIndex, detailEnd);
assert.match(detail, /w-full/);
assert.match(detail, /whitespace-normal/);
assert.match(detail, /break-words/);
assert.doesNotMatch(detail, /maxWidth|nowrap|overflow-hidden|textOverflow|ellipsis|truncate/,
  'detail must never return to clipped/ellipsis presentation');

assert.match(toolbar, /QUEUE_PROGRESS_HEADER_QUERY = '\(min-width: 1440px\)'/);
assert.match(toolbar, /slot && useHeaderSlot \? createPortal\(widget, slot\) : widget/);
assert.match(home, /id="queue-progress-slot"[\s\S]*?hidden min-\[1440px\]:block/);
assert.doesNotMatch(toolbar, /progress\.skipped|progress\.failed/,
  'toolbar must render parent-owned progress truth rather than derive queue counters');

console.log('PASS PS-442 queue progress readability guard');
