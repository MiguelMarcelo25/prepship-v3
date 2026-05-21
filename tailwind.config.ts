import type { Config } from 'tailwindcss';

const RUNTIME_SAFE_CLASSES = [
  'bg-brand',
  'bg-brand/10',
  'bg-brand/20',
  'text-brand',
  'border-brand',
  'ring-brand/30',
  'from-brand',
  'to-brand',
]

export default {
  content: [
    './web/index.html',
    './web/src/**/*.{ts,tsx}',
  ],
  safelist: RUNTIME_SAFE_CLASSES,
  theme: {
    extend: {
      // All semantic tokens reference CSS variables that ThemeProvider
      // writes onto :root. Using `rgb(var(--*-rgb) / <alpha-value>)`
      // keeps Tailwind opacity modifiers (e.g. `bg-brand/30`) working —
      // a raw `var(--brand)` would not let Tailwind compute the alpha.
      // Fallback triplets match the default Indigo theme.
      colors: {
        brand: {
          DEFAULT: 'rgb(var(--brand-rgb, 42 91 215) / <alpha-value>)',
          dark: 'rgb(var(--brand-2-rgb, 26 72 192) / <alpha-value>)',
          bg: 'rgb(var(--brand-bg-rgb, 238 242 255) / <alpha-value>)',
          border: 'rgb(var(--brand-border-rgb, 195 208 245) / <alpha-value>)',
        },
        ok: {
          DEFAULT: 'rgb(var(--ok-rgb, 22 163 74) / <alpha-value>)',
          dark: '#15803d',
          bg: '#f0fdf4',
          border: '#bbf7d0',
        },
        warn: {
          DEFAULT: 'rgb(var(--warn-rgb, 217 119 6) / <alpha-value>)',
          bg: '#fffbeb',
          border: '#fcd34d',
        },
        danger: {
          DEFAULT: 'rgb(var(--danger-rgb, 220 38 38) / <alpha-value>)',
          bg: '#fef2f2',
          border: '#fecaca',
        },
        ink: {
          DEFAULT: 'rgb(var(--text-rgb, 26 31 46) / <alpha-value>)',
          2: 'rgb(var(--text-2-rgb, 74 85 104) / <alpha-value>)',
          3: 'rgb(var(--text-3-rgb, 138 149 163) / <alpha-value>)',
          4: 'rgb(var(--text-4-rgb, 176 184 196) / <alpha-value>)',
        },
        surface: {
          DEFAULT: 'rgb(var(--surface-rgb, 255 255 255) / <alpha-value>)',
          2: 'rgb(var(--surface-2-rgb, 248 249 251) / <alpha-value>)',
          3: 'rgb(var(--surface-3-rgb, 238 240 244) / <alpha-value>)',
        },
        page: 'rgb(var(--bg-rgb, 240 242 245) / <alpha-value>)',
        line: {
          DEFAULT: 'rgb(var(--border-rgb, 225 228 232) / <alpha-value>)',
          2: 'rgb(var(--border-2-rgb, 200 205 213) / <alpha-value>)',
        },
      },
      // Boss directive 2026-05-08: match v2-original font feel.
      // v2-original uses NO custom webfont — just the browser system
      // stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`).
      // Drops Geist + Bricolage Grotesque to render the same
      // characters v2 did. Mono keeps a system-mono stack for tabular
      // numbers — v2 didn't define a custom mono either, but
      // `ui-monospace` is the modern best-practice fallback that
      // matches v2's behavior on Chrome/Windows where the user's
      // boss is testing.
      fontFamily: {
        display: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'system-ui',
          'sans-serif',
        ],
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '1' }],
        'xxs': ['10.5px', { lineHeight: '1' }],
        'tiny': ['11px', { lineHeight: '1.2' }],
        'xs2': ['11.5px', { lineHeight: '1.2' }],
        'sm2': ['12.5px', { lineHeight: '1.3' }],
      },
      borderRadius: {
        btn: '5px',
        card: '8px',
        modal: '10px',
      },
      boxShadow: {
        sm: '0 1px 3px rgba(0,0,0,.07), 0 1px 2px rgba(0,0,0,.04)',
        md: '0 4px 8px rgba(0,0,0,.08), 0 2px 4px rgba(0,0,0,.04)',
        lg: '0 8px 24px rgba(0,0,0,.12), 0 2px 8px rgba(0,0,0,.06)',
        'drawer-l': '-4px 0 32px rgba(0, 0, 0, 0.25)',
      },
      width: {
        sidebar: '220px',
        panel: '390px',
        drawer: '680px',
      },
      keyframes: {
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        bounceIn: {
          '0%': { opacity: '0', transform: 'scale(0.7)' },
          '60%': { opacity: '1', transform: 'scale(1.08)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        spinSlow: {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
      },
      animation: {
        pulse: 'pulse 0.8s ease-in-out infinite',
        fadeIn: 'fadeIn 0.25s ease-out',
        fadeInUp: 'fadeInUp 0.3s cubic-bezier(0.22, 1, 0.36, 1)',
        slideInRight: 'slideInRight 0.25s ease-out',
        bounceIn: 'bounceIn 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)',
        shimmer: 'shimmer 2s linear infinite',
        spinSlow: 'spinSlow 1.6s linear infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
