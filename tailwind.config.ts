import type { Config } from 'tailwindcss';

export default {
  content: [
    './web/index.html',
    './web/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#2a5bd7',
          dark: '#1a48c0',
          bg: '#eef2ff',
          border: '#c3d0f5',
        },
        ok: {
          DEFAULT: '#16a34a',
          dark: '#15803d',
          bg: '#f0fdf4',
          border: '#bbf7d0',
        },
        warn: {
          DEFAULT: '#d97706',
          bg: '#fffbeb',
          border: '#fcd34d',
        },
        danger: {
          DEFAULT: '#dc2626',
          bg: '#fef2f2',
          border: '#fecaca',
        },
        ink: {
          DEFAULT: '#1a1f2e',
          2: '#4a5568',
          3: '#8a95a3',
          4: '#b0b8c4',
        },
        surface: {
          DEFAULT: '#ffffff',
          2: '#f8f9fb',
          3: '#eef0f4',
        },
        page: '#f0f2f5',
        line: {
          DEFAULT: '#e1e4e8',
          2: '#c8cdd5',
        },
      },
      fontFamily: {
        sans: [
          '"Poppins"',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
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
      },
      animation: {
        pulse: 'pulse 0.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
