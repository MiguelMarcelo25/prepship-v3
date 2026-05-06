// 10 project-wide color themes. Each theme writes a flat map of CSS custom
// properties on :root. Two naming conventions are supported simultaneously:
//
//   1. NEW (used by tailwind.config.ts via var()):
//      --bg --surface --surface-2 --surface-3 --border --border-2
//      --text --text-2 --text-3 --text-4
//      --brand --brand-2 --brand-bg --brand-border
//      --ok --warn --danger
//
//   2. LEGACY (used throughout app-shell.css):
//      --surface2 --surface3 --border2 --text2 --text3 --text4
//      --ss-blue --ss-blue2 --ss-blue-bg --ss-blue-border
//      --green --green2 --green-bg --green-border --green-dark
//      --yellow --yellow-bg --red --red-bg --orange --orange-bg
//      --shadow --shadow-md --shadow-lg
//
// The buildVars helper expands a compact theme spec into both naming
// conventions so EVERY existing component reskins automatically without
// having to edit a single line of legacy CSS.

export type ThemeMode = 'light' | 'dark'

export interface Theme {
  id: string
  name: string
  tagline: string
  mode: ThemeMode
  /** 3-color swatch row for the picker preview */
  swatches: [string, string, string]
  vars: Record<string, string>
}

interface ThemeSpec {
  id: string
  name: string
  tagline: string
  mode: ThemeMode
  swatches: [string, string, string]
  bg: string
  surface: string
  surface2: string
  surface3: string
  border: string
  border2: string
  text: string
  text2: string
  text3: string
  text4: string
  brand: string
  brand2: string
  brandBg: string
  brandBorder: string
  ok: string
  okDark?: string
  okBg?: string
  okBorder?: string
  warn: string
  warnBg?: string
  danger: string
  dangerBg?: string
  orange?: string
  orangeBg?: string
  shadowAlpha?: string // rgb triplet — defaults to '15 23 42'
}

/** Convert a hex color (#RRGGBB or #RGB) to a space-separated RGB triplet
 *  (e.g. "42 91 215") so it can be used inside `rgb(var(...) / <alpha-value>)`
 *  for Tailwind opacity modifiers. */
function hexToRgbTriplet(hex: string): string {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length !== 6) return '128 128 128'
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `${r} ${g} ${b}`
}

function buildVars(s: ThemeSpec): Record<string, string> {
  const okDark = s.okDark ?? s.ok
  const okBg = s.okBg ?? s.surface2
  const okBorder = s.okBorder ?? s.border
  const warnBg = s.warnBg ?? s.surface2
  const dangerBg = s.dangerBg ?? s.surface2
  const orange = s.orange ?? s.warn
  const orangeBg = s.orangeBg ?? s.surface2
  const sh = s.shadowAlpha ?? '15 23 42'
  return {
    // ── New convention (used by tailwind.config.ts) ──────────────
    '--bg': s.bg,
    '--surface': s.surface,
    '--surface-2': s.surface2,
    '--surface-3': s.surface3,
    '--border': s.border,
    '--border-2': s.border2,
    '--text': s.text,
    '--text-2': s.text2,
    '--text-3': s.text3,
    '--text-4': s.text4,
    '--brand': s.brand,
    '--brand-2': s.brand2,
    '--brand-bg': s.brandBg,
    '--brand-border': s.brandBorder,
    '--ok': s.ok,
    '--warn': s.warn,
    '--danger': s.danger,
    '--shadow-color': sh,
    // ── RGB triplets (used by tailwind opacity modifiers like bg-brand/30) ──
    '--brand-rgb': hexToRgbTriplet(s.brand),
    '--brand-2-rgb': hexToRgbTriplet(s.brand2),
    '--brand-bg-rgb': hexToRgbTriplet(s.brandBg),
    '--brand-border-rgb': hexToRgbTriplet(s.brandBorder),
    '--ok-rgb': hexToRgbTriplet(s.ok),
    '--warn-rgb': hexToRgbTriplet(s.warn),
    '--danger-rgb': hexToRgbTriplet(s.danger),
    '--text-rgb': hexToRgbTriplet(s.text),
    '--text-2-rgb': hexToRgbTriplet(s.text2),
    '--text-3-rgb': hexToRgbTriplet(s.text3),
    '--text-4-rgb': hexToRgbTriplet(s.text4),
    '--surface-rgb': hexToRgbTriplet(s.surface),
    '--surface-2-rgb': hexToRgbTriplet(s.surface2),
    '--surface-3-rgb': hexToRgbTriplet(s.surface3),
    '--bg-rgb': hexToRgbTriplet(s.bg),
    '--border-rgb': hexToRgbTriplet(s.border),
    '--border-2-rgb': hexToRgbTriplet(s.border2),
    // ── Legacy convention (used by app-shell.css verbatim) ──────
    '--surface2': s.surface2,
    '--surface3': s.surface3,
    '--border2': s.border2,
    '--text2': s.text2,
    '--text3': s.text3,
    '--text4': s.text4,
    '--ss-blue': s.brand,
    '--ss-blue2': s.brand2,
    '--ss-blue-bg': s.brandBg,
    '--ss-blue-border': s.brandBorder,
    '--green': s.ok,
    '--green2': okDark,
    '--green-dark': okDark,
    '--green-bg': okBg,
    '--green-border': okBorder,
    '--yellow': s.warn,
    '--yellow-bg': warnBg,
    '--red': s.danger,
    '--red-bg': dangerBg,
    '--orange': orange,
    '--orange-bg': orangeBg,
    // Recomputed shadows so dark themes don't get washed-out shadows
    '--shadow': `0 1px 3px rgba(${sh}, .07), 0 1px 2px rgba(${sh}, .04)`,
    '--shadow-md': `0 4px 8px rgba(${sh}, .08), 0 2px 4px rgba(${sh}, .04)`,
    '--shadow-lg': `0 8px 24px rgba(${sh}, .12), 0 2px 8px rgba(${sh}, .06)`,
  }
}

const SPECS: ThemeSpec[] = [
  // ─── 01 Indigo (default — current product) ──────────────────────
  {
    id: 'indigo', name: 'Indigo', tagline: 'Default · clean · brand blue', mode: 'light',
    swatches: ['#f0f2f5', '#2a5bd7', '#0f172a'],
    bg: '#f0f2f5', surface: '#ffffff', surface2: '#f8f9fb', surface3: '#eef0f4',
    border: '#e1e4e8', border2: '#c8cdd5',
    text: '#1a1f2e', text2: '#4a5568', text3: '#8a95a3', text4: '#b0b8c4',
    brand: '#2a5bd7', brand2: '#1a48c0', brandBg: '#eef2ff', brandBorder: '#c3d0f5',
    ok: '#16a34a', okDark: '#15803d', okBg: '#f0fdf4', okBorder: '#bbf7d0',
    warn: '#d97706', warnBg: '#fffbeb',
    danger: '#dc2626', dangerBg: '#fef2f2',
    orange: '#e8650a', orangeBg: '#fff5ee',
    shadowAlpha: '15 23 42',
  },
  // ─── 02 Midnight ────────────────────────────────────────────────
  {
    id: 'midnight', name: 'Midnight', tagline: 'Dark · indigo accent · low light', mode: 'dark',
    swatches: ['#0b1220', '#818cf8', '#e2e8f0'],
    bg: '#0b1220', surface: '#111827', surface2: '#1f2937', surface3: '#374151',
    border: '#1f2937', border2: '#334155',
    text: '#f1f5f9', text2: '#cbd5e1', text3: '#94a3b8', text4: '#64748b',
    brand: '#818cf8', brand2: '#6366f1', brandBg: '#1e1b4b', brandBorder: '#3730a3',
    ok: '#34d399', okDark: '#10b981', okBg: '#022c22', okBorder: '#065f46',
    warn: '#fbbf24', warnBg: '#451a03',
    danger: '#fb7185', dangerBg: '#3f0a0a',
    orange: '#fb923c', orangeBg: '#451a03',
    shadowAlpha: '0 0 0',
  },
  // ─── 03 Forest ──────────────────────────────────────────────────
  {
    id: 'forest', name: 'Forest', tagline: 'Light · emerald · nature', mode: 'light',
    swatches: ['#f3f6f3', '#059669', '#0f1f17'],
    bg: '#f3f6f3', surface: '#ffffff', surface2: '#f1f5f1', surface3: '#e3eae3',
    border: '#dbe5db', border2: '#bccdc0',
    text: '#0f1f17', text2: '#2f4138', text3: '#5e7167', text4: '#94a594',
    brand: '#059669', brand2: '#047857', brandBg: '#ecfdf5', brandBorder: '#a7f3d0',
    ok: '#16a34a', okBg: '#f0fdf4', okBorder: '#bbf7d0',
    warn: '#d97706', warnBg: '#fffbeb',
    danger: '#dc2626', dangerBg: '#fef2f2',
    orange: '#ea580c', orangeBg: '#fff5ee',
    shadowAlpha: '15 31 23',
  },
  // ─── 04 Ocean ───────────────────────────────────────────────────
  {
    id: 'ocean', name: 'Ocean', tagline: 'Light · cyan · calm waters', mode: 'light',
    swatches: ['#f0f7f9', '#0891b2', '#082f3a'],
    bg: '#f0f7f9', surface: '#ffffff', surface2: '#ecf3f5', surface3: '#dde9ec',
    border: '#d4e2e6', border2: '#a8c4cb',
    text: '#082f3a', text2: '#274b58', text3: '#5a7782', text4: '#94adb5',
    brand: '#0891b2', brand2: '#0e7490', brandBg: '#ecfeff', brandBorder: '#a5f3fc',
    ok: '#10b981', okBg: '#ecfdf5', okBorder: '#a7f3d0',
    warn: '#f59e0b', warnBg: '#fffbeb',
    danger: '#ef4444', dangerBg: '#fef2f2',
    orange: '#f97316', orangeBg: '#fff7ed',
    shadowAlpha: '8 47 58',
  },
  // ─── 05 Sunset ──────────────────────────────────────────────────
  {
    id: 'sunset', name: 'Sunset', tagline: 'Light · warm · golden hour', mode: 'light',
    swatches: ['#fdf6f0', '#ea580c', '#3a1d0d'],
    bg: '#fdf6f0', surface: '#ffffff', surface2: '#faf0e6', surface3: '#f3e2d0',
    border: '#ead9c5', border2: '#d6b896',
    text: '#3a1d0d', text2: '#6b3f24', text3: '#9c7457', text4: '#c9ab93',
    brand: '#ea580c', brand2: '#c2410c', brandBg: '#fff7ed', brandBorder: '#fed7aa',
    ok: '#65a30d', okBg: '#f7fee7', okBorder: '#bef264',
    warn: '#eab308', warnBg: '#fefce8',
    danger: '#b91c1c', dangerBg: '#fef2f2',
    orange: '#dc2626', orangeBg: '#fef2f2',
    shadowAlpha: '58 29 13',
  },
  // ─── 06 Mono ────────────────────────────────────────────────────
  {
    id: 'mono', name: 'Mono', tagline: 'Light · monochrome · minimalist', mode: 'light',
    swatches: ['#fafafa', '#171717', '#000000'],
    bg: '#fafafa', surface: '#ffffff', surface2: '#f5f5f5', surface3: '#e5e5e5',
    border: '#e5e5e5', border2: '#a3a3a3',
    text: '#000000', text2: '#404040', text3: '#737373', text4: '#a3a3a3',
    brand: '#171717', brand2: '#000000', brandBg: '#f5f5f5', brandBorder: '#262626',
    ok: '#16a34a', okBg: '#f0fdf4', okBorder: '#bbf7d0',
    warn: '#d97706', warnBg: '#fffbeb',
    danger: '#dc2626', dangerBg: '#fef2f2',
    orange: '#ea580c', orangeBg: '#fff5ee',
    shadowAlpha: '0 0 0',
  },
  // ─── 07 Pastel ──────────────────────────────────────────────────
  {
    id: 'pastel', name: 'Pastel', tagline: 'Light · lavender · soft & friendly', mode: 'light',
    swatches: ['#faf5ff', '#a855f7', '#3b0764'],
    bg: '#faf5ff', surface: '#ffffff', surface2: '#f5edff', surface3: '#ebe0fa',
    border: '#e2d6f3', border2: '#c4a8e4',
    text: '#3b0764', text2: '#5b1c8c', text3: '#8856b3', text4: '#bf99dc',
    brand: '#a855f7', brand2: '#9333ea', brandBg: '#faf5ff', brandBorder: '#d8b4fe',
    ok: '#10b981', okBg: '#ecfdf5', okBorder: '#a7f3d0',
    warn: '#f59e0b', warnBg: '#fffbeb',
    danger: '#e11d48', dangerBg: '#fff1f2',
    orange: '#f97316', orangeBg: '#fff7ed',
    shadowAlpha: '59 7 100',
  },
  // ─── 08 Cyber ───────────────────────────────────────────────────
  {
    id: 'cyber', name: 'Cyber', tagline: 'Dark · neon · synthwave', mode: 'dark',
    swatches: ['#0a0a14', '#22d3ee', '#f0abfc'],
    bg: '#0a0a14', surface: '#14141f', surface2: '#1e1e2e', surface3: '#28283a',
    border: '#1e1e2e', border2: '#3a3a52',
    text: '#e4e4f0', text2: '#b8b8d4', text3: '#7a7a9c', text4: '#4a4a66',
    brand: '#22d3ee', brand2: '#06b6d4', brandBg: '#083344', brandBorder: '#0e7490',
    ok: '#4ade80', okDark: '#22c55e', okBg: '#052e16', okBorder: '#15803d',
    warn: '#facc15', warnBg: '#422006',
    danger: '#f0abfc', dangerBg: '#3b0764',
    orange: '#fb923c', orangeBg: '#451a03',
    shadowAlpha: '6 182 212',
  },
  // ─── 09 Cream ───────────────────────────────────────────────────
  {
    id: 'cream', name: 'Cream', tagline: 'Light · paper · editorial warmth', mode: 'light',
    swatches: ['#faf6ed', '#92400e', '#1c1917'],
    bg: '#faf6ed', surface: '#fefaf0', surface2: '#f5f0e3', surface3: '#ebe3d0',
    border: '#e0d5bf', border2: '#c4b08a',
    text: '#1c1917', text2: '#44403c', text3: '#78716c', text4: '#a8a29e',
    brand: '#92400e', brand2: '#7c2d12', brandBg: '#fef3c7', brandBorder: '#fcd34d',
    ok: '#65a30d', okBg: '#f7fee7', okBorder: '#bef264',
    warn: '#ca8a04', warnBg: '#fefce8',
    danger: '#b91c1c', dangerBg: '#fef2f2',
    orange: '#c2410c', orangeBg: '#fff7ed',
    shadowAlpha: '28 25 23',
  },
  // ─── 10 Royal ───────────────────────────────────────────────────
  {
    id: 'royal', name: 'Royal', tagline: 'Dark · purple & gold · luxury', mode: 'dark',
    swatches: ['#1a0f2e', '#fbbf24', '#f5e9c8'],
    bg: '#1a0f2e', surface: '#251a3d', surface2: '#2f2247', surface3: '#3b2c5a',
    border: '#2f2247', border2: '#4a3870',
    text: '#f5e9c8', text2: '#d4c79e', text3: '#9c8d6e', text4: '#6b5f4c',
    brand: '#fbbf24', brand2: '#d97706', brandBg: '#3b2c5a', brandBorder: '#92590f',
    ok: '#86efac', okDark: '#4ade80', okBg: '#052e16', okBorder: '#15803d',
    warn: '#fde047', warnBg: '#422006',
    danger: '#fda4af', dangerBg: '#3f0a0a',
    orange: '#fdba74', orangeBg: '#451a03',
    shadowAlpha: '0 0 0',
  },
  // ─── 11 Slate ───────────────────────────────────────────────────
  {
    id: 'slate', name: 'Slate', tagline: 'Light · cool gray · enterprise', mode: 'light',
    swatches: ['#f1f5f9', '#475569', '#0f172a'],
    bg: '#f1f5f9', surface: '#ffffff', surface2: '#f8fafc', surface3: '#e2e8f0',
    border: '#e2e8f0', border2: '#cbd5e1',
    text: '#0f172a', text2: '#334155', text3: '#64748b', text4: '#94a3b8',
    brand: '#475569', brand2: '#334155', brandBg: '#f1f5f9', brandBorder: '#cbd5e1',
    ok: '#16a34a', warn: '#d97706', danger: '#dc2626',
    shadowAlpha: '15 23 42',
  },
  // ─── 12 Rose ────────────────────────────────────────────────────
  {
    id: 'rose', name: 'Rose', tagline: 'Light · pink · romantic', mode: 'light',
    swatches: ['#fff1f2', '#e11d48', '#881337'],
    bg: '#fff1f2', surface: '#ffffff', surface2: '#fce7e9', surface3: '#fbcfd5',
    border: '#fbcfd5', border2: '#fda4af',
    text: '#881337', text2: '#9f1239', text3: '#be185d', text4: '#db8ea3',
    brand: '#e11d48', brand2: '#be123c', brandBg: '#fff1f2', brandBorder: '#fecdd3',
    ok: '#10b981', warn: '#f59e0b', danger: '#9f1239',
    shadowAlpha: '136 19 55',
  },
  // ─── 13 Sky ─────────────────────────────────────────────────────
  {
    id: 'sky', name: 'Sky', tagline: 'Light · bright blue · cheerful', mode: 'light',
    swatches: ['#f0f9ff', '#0284c7', '#0c4a6e'],
    bg: '#f0f9ff', surface: '#ffffff', surface2: '#e0f2fe', surface3: '#bae6fd',
    border: '#bae6fd', border2: '#7dd3fc',
    text: '#0c4a6e', text2: '#075985', text3: '#0369a1', text4: '#7dadc7',
    brand: '#0284c7', brand2: '#0369a1', brandBg: '#e0f2fe', brandBorder: '#7dd3fc',
    ok: '#16a34a', warn: '#f59e0b', danger: '#dc2626',
    shadowAlpha: '12 74 110',
  },
  // ─── 14 Lime ────────────────────────────────────────────────────
  {
    id: 'lime', name: 'Lime', tagline: 'Light · fresh green · vibrant', mode: 'light',
    swatches: ['#f7fee7', '#65a30d', '#1a2e05'],
    bg: '#f7fee7', surface: '#ffffff', surface2: '#ecfccb', surface3: '#d9f99d',
    border: '#d9f99d', border2: '#bef264',
    text: '#1a2e05', text2: '#365314', text3: '#4d7c0f', text4: '#84cc16',
    brand: '#65a30d', brand2: '#4d7c0f', brandBg: '#ecfccb', brandBorder: '#bef264',
    ok: '#16a34a', warn: '#ca8a04', danger: '#dc2626',
    shadowAlpha: '26 46 5',
  },
  // ─── 15 Crimson ─────────────────────────────────────────────────
  {
    id: 'crimson', name: 'Crimson', tagline: 'Light · deep red · elegant', mode: 'light',
    swatches: ['#faf5f5', '#991b1b', '#450a0a'],
    bg: '#faf5f5', surface: '#ffffff', surface2: '#f5e6e6', surface3: '#ecd0d0',
    border: '#ecd0d0', border2: '#d4a4a4',
    text: '#450a0a', text2: '#7f1d1d', text3: '#991b1b', text4: '#c97070',
    brand: '#991b1b', brand2: '#7f1d1d', brandBg: '#fef2f2', brandBorder: '#fecaca',
    ok: '#15803d', warn: '#a16207', danger: '#7f1d1d',
    shadowAlpha: '69 10 10',
  },
  // ─── 16 Charcoal ────────────────────────────────────────────────
  {
    id: 'charcoal', name: 'Charcoal', tagline: 'Dark · graphite · serious', mode: 'dark',
    swatches: ['#171717', '#fafafa', '#a3a3a3'],
    bg: '#171717', surface: '#262626', surface2: '#404040', surface3: '#525252',
    border: '#262626', border2: '#525252',
    text: '#fafafa', text2: '#d4d4d4', text3: '#a3a3a3', text4: '#737373',
    brand: '#fafafa', brand2: '#e5e5e5', brandBg: '#262626', brandBorder: '#525252',
    ok: '#4ade80', warn: '#fbbf24', danger: '#fb7185',
    shadowAlpha: '0 0 0',
  },
  // ─── 17 Mint ────────────────────────────────────────────────────
  {
    id: 'mint', name: 'Mint', tagline: 'Light · cool mint · refreshing', mode: 'light',
    swatches: ['#ecfdf5', '#0d9488', '#042f2e'],
    bg: '#ecfdf5', surface: '#ffffff', surface2: '#d1fae5', surface3: '#a7f3d0',
    border: '#a7f3d0', border2: '#6ee7b7',
    text: '#042f2e', text2: '#134e4a', text3: '#0f766e', text4: '#5eead4',
    brand: '#0d9488', brand2: '#0f766e', brandBg: '#ccfbf1', brandBorder: '#5eead4',
    ok: '#16a34a', warn: '#f59e0b', danger: '#dc2626',
    shadowAlpha: '4 47 46',
  },
  // ─── 18 Plum ────────────────────────────────────────────────────
  {
    id: 'plum', name: 'Plum', tagline: 'Light · muted purple · sophisticated', mode: 'light',
    swatches: ['#f5f3ff', '#6d28d9', '#1e1b4b'],
    bg: '#f5f3ff', surface: '#ffffff', surface2: '#ede9fe', surface3: '#ddd6fe',
    border: '#ddd6fe', border2: '#c4b5fd',
    text: '#1e1b4b', text2: '#312e81', text3: '#4338ca', text4: '#a5b4fc',
    brand: '#6d28d9', brand2: '#5b21b6', brandBg: '#ede9fe', brandBorder: '#c4b5fd',
    ok: '#10b981', warn: '#f59e0b', danger: '#dc2626',
    shadowAlpha: '30 27 75',
  },
  // ─── 19 Sand ────────────────────────────────────────────────────
  {
    id: 'sand', name: 'Sand', tagline: 'Light · desert beige · warm earth', mode: 'light',
    swatches: ['#faf5e6', '#a16207', '#3a2a04'],
    bg: '#faf5e6', surface: '#fefdf3', surface2: '#fef3c7', surface3: '#fde68a',
    border: '#fde68a', border2: '#fcd34d',
    text: '#3a2a04', text2: '#713f12', text3: '#a16207', text4: '#d4a52e',
    brand: '#a16207', brand2: '#854d0e', brandBg: '#fef9c3', brandBorder: '#fde68a',
    ok: '#65a30d', warn: '#ca8a04', danger: '#b91c1c',
    shadowAlpha: '58 42 4',
  },
  // ─── 20 Steel ───────────────────────────────────────────────────
  {
    id: 'steel', name: 'Steel', tagline: 'Light · industrial · gray-blue', mode: 'light',
    swatches: ['#f1f5f9', '#1e3a5f', '#0a1628'],
    bg: '#eff3f7', surface: '#ffffff', surface2: '#e7edf3', surface3: '#d1dce6',
    border: '#cbd5e1', border2: '#94a3b8',
    text: '#0a1628', text2: '#1e3a5f', text3: '#475569', text4: '#94a3b8',
    brand: '#1e3a5f', brand2: '#0f1f3d', brandBg: '#dbeafe', brandBorder: '#93c5fd',
    ok: '#16a34a', warn: '#d97706', danger: '#dc2626',
    shadowAlpha: '10 22 40',
  },
  // ─── 21 Coral ───────────────────────────────────────────────────
  {
    id: 'coral', name: 'Coral', tagline: 'Light · warm coral · friendly', mode: 'light',
    swatches: ['#fff5f5', '#f97316', '#7c2d12'],
    bg: '#fff5f0', surface: '#ffffff', surface2: '#ffedd5', surface3: '#fed7aa',
    border: '#fed7aa', border2: '#fdba74',
    text: '#7c2d12', text2: '#9a3412', text3: '#c2410c', text4: '#fdba74',
    brand: '#f97316', brand2: '#ea580c', brandBg: '#ffedd5', brandBorder: '#fdba74',
    ok: '#16a34a', warn: '#ca8a04', danger: '#dc2626',
    shadowAlpha: '124 45 18',
  },
  // ─── 22 Forest Dark ─────────────────────────────────────────────
  {
    id: 'forest-dark', name: 'Forest Dark', tagline: 'Dark · deep green · earthy', mode: 'dark',
    swatches: ['#0a1810', '#34d399', '#d1fae5'],
    bg: '#0a1810', surface: '#0f2419', surface2: '#172e22', surface3: '#1f4030',
    border: '#172e22', border2: '#1f4030',
    text: '#d1fae5', text2: '#a7f3d0', text3: '#6ee7b7', text4: '#34d399',
    brand: '#34d399', brand2: '#10b981', brandBg: '#1a3d2c', brandBorder: '#065f46',
    ok: '#4ade80', warn: '#facc15', danger: '#fb7185',
    shadowAlpha: '0 0 0',
  },
  // ─── 23 Bronze ──────────────────────────────────────────────────
  {
    id: 'bronze', name: 'Bronze', tagline: 'Light · warm metallic · vintage', mode: 'light',
    swatches: ['#fdf6e3', '#a16207', '#451a03'],
    bg: '#fdf6e3', surface: '#fefbf2', surface2: '#fef3c7', surface3: '#fde68a',
    border: '#e8d5a8', border2: '#c89c5e',
    text: '#451a03', text2: '#78350f', text3: '#a16207', text4: '#ca8a04',
    brand: '#a16207', brand2: '#854d0e', brandBg: '#fef3c7', brandBorder: '#d4a52e',
    ok: '#65a30d', warn: '#d97706', danger: '#b91c1c',
    shadowAlpha: '69 26 3',
  },
  // ─── 24 Iceberg ─────────────────────────────────────────────────
  {
    id: 'iceberg', name: 'Iceberg', tagline: 'Light · pale icy blue · arctic', mode: 'light',
    swatches: ['#f0f9ff', '#0369a1', '#082f49'],
    bg: '#f0fbff', surface: '#ffffff', surface2: '#e0f2fe', surface3: '#bae6fd',
    border: '#bae6fd', border2: '#7dd3fc',
    text: '#082f49', text2: '#0c4a6e', text3: '#0369a1', text4: '#7dadc7',
    brand: '#0369a1', brand2: '#075985', brandBg: '#dbeafe', brandBorder: '#93c5fd',
    ok: '#10b981', warn: '#f59e0b', danger: '#dc2626',
    shadowAlpha: '8 47 73',
  },
  // ─── 25 Honey ───────────────────────────────────────────────────
  {
    id: 'honey', name: 'Honey', tagline: 'Light · warm gold · inviting', mode: 'light',
    swatches: ['#fffbeb', '#d97706', '#451a03'],
    bg: '#fffbeb', surface: '#ffffff', surface2: '#fef3c7', surface3: '#fde68a',
    border: '#fde68a', border2: '#fcd34d',
    text: '#451a03', text2: '#78350f', text3: '#b45309', text4: '#fbbf24',
    brand: '#d97706', brand2: '#b45309', brandBg: '#fef3c7', brandBorder: '#fcd34d',
    ok: '#16a34a', warn: '#ca8a04', danger: '#b91c1c',
    shadowAlpha: '69 26 3',
  },
  // ─── 26 Berry ───────────────────────────────────────────────────
  {
    id: 'berry', name: 'Berry', tagline: 'Light · mixed berries · sweet', mode: 'light',
    swatches: ['#fdf2f8', '#be185d', '#500724'],
    bg: '#fdf2f8', surface: '#ffffff', surface2: '#fce7f3', surface3: '#fbcfe8',
    border: '#fbcfe8', border2: '#f9a8d4',
    text: '#500724', text2: '#831843', text3: '#9d174d', text4: '#db2777',
    brand: '#be185d', brand2: '#9d174d', brandBg: '#fce7f3', brandBorder: '#f9a8d4',
    ok: '#16a34a', warn: '#d97706', danger: '#9f1239',
    shadowAlpha: '80 7 36',
  },
  // ─── 27 Slate Dark ──────────────────────────────────────────────
  {
    id: 'slate-dark', name: 'Slate Dark', tagline: 'Dark · cool gray · monitor mode', mode: 'dark',
    swatches: ['#0f172a', '#94a3b8', '#f1f5f9'],
    bg: '#0f172a', surface: '#1e293b', surface2: '#334155', surface3: '#475569',
    border: '#1e293b', border2: '#334155',
    text: '#f1f5f9', text2: '#cbd5e1', text3: '#94a3b8', text4: '#64748b',
    brand: '#94a3b8', brand2: '#64748b', brandBg: '#1e293b', brandBorder: '#475569',
    ok: '#4ade80', warn: '#fbbf24', danger: '#fb7185',
    shadowAlpha: '0 0 0',
  },
  // ─── 28 Lavender Dark ───────────────────────────────────────────
  {
    id: 'lavender-dark', name: 'Lavender Dark', tagline: 'Dark · purple haze · dreamy', mode: 'dark',
    swatches: ['#1e1b4b', '#a78bfa', '#ede9fe'],
    bg: '#1e1b4b', surface: '#312e81', surface2: '#3730a3', surface3: '#4338ca',
    border: '#312e81', border2: '#4338ca',
    text: '#ede9fe', text2: '#ddd6fe', text3: '#c4b5fd', text4: '#a78bfa',
    brand: '#a78bfa', brand2: '#8b5cf6', brandBg: '#3730a3', brandBorder: '#6366f1',
    ok: '#86efac', warn: '#fde047', danger: '#fda4af',
    shadowAlpha: '0 0 0',
  },
  // ─── 29 Espresso ────────────────────────────────────────────────
  {
    id: 'espresso', name: 'Espresso', tagline: 'Dark · warm brown · cozy', mode: 'dark',
    swatches: ['#1c1410', '#d97706', '#fef3c7'],
    bg: '#1c1410', surface: '#2a1f1a', surface2: '#3d2c24', surface3: '#523c30',
    border: '#2a1f1a', border2: '#523c30',
    text: '#fef3c7', text2: '#fde68a', text3: '#d4a52e', text4: '#a16207',
    brand: '#d97706', brand2: '#b45309', brandBg: '#3d2c24', brandBorder: '#92400e',
    ok: '#86efac', warn: '#fde047', danger: '#fb7185',
    shadowAlpha: '0 0 0',
  },
  // ─── 30 Aurora ──────────────────────────────────────────────────
  {
    id: 'aurora', name: 'Aurora', tagline: 'Dark · multi-hue · northern lights', mode: 'dark',
    swatches: ['#0a1228', '#22d3ee', '#a78bfa'],
    bg: '#0a1228', surface: '#111c3a', surface2: '#1a2848', surface3: '#243557',
    border: '#1a2848', border2: '#3a4a6e',
    text: '#e0f2fe', text2: '#bae6fd', text3: '#7dd3fc', text4: '#38bdf8',
    brand: '#22d3ee', brand2: '#0891b2', brandBg: '#0e2942', brandBorder: '#0e7490',
    ok: '#86efac', warn: '#fde047', danger: '#fda4af',
    shadowAlpha: '34 211 238',
  },
]

export const THEMES: Theme[] = SPECS.map((s) => ({
  id: s.id,
  name: s.name,
  tagline: s.tagline,
  mode: s.mode,
  swatches: s.swatches,
  vars: buildVars(s),
}))

export const DEFAULT_THEME_ID = 'indigo'

export function findTheme(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!
}
