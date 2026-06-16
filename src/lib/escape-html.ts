// PS-254 (Card 9): minimal HTML-escape for values interpolated into server-rendered
// HTML (mock test labels, pick lists). Recipient names/addresses are attacker-influenced
// (they come from marketplace order data), so unescaped interpolation is stored XSS.
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape &, <, >, ", ' so a value is safe to drop into an HTML text/attribute context. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}
