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
        display: [
          '"Bricolage Grotesque"',
          '-apple-system',
          'BlinkMacSystemFont',
          'system-ui',
          'sans-serif',
        ],
        sans: [
          '"Geist"',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
        mono: [
          '"Geist Mono"',
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
