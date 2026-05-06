// 20 sidebar specs (variants F→Y) consumed by SidebarTemplated.
// Each spec is a config object that the renderer translates to Tailwind
// classes. Goal is to produce 20 visually distinct sidebars from one
// template by varying surface, accent hue, density, radius, active style,
// typography, ambient backdrop and logo icon.
import type { SidebarSpec } from './SidebarTemplated'

export const SIDEBAR_SPECS: Record<string, SidebarSpec> = {
  F: {
    id: 'F', name: 'Compact Indigo', tagline: 'Light · tight · indigo pill',
    swatches: ['#ffffff', '#eef2ff', '#4f46e5'],
    mode: 'light', density: 'compact', radius: 'pill', activeStyle: 'pill',
    surface: 'solid', iconStyle: 'minimal', typography: 'clean',
    accent: 'indigo', logoIcon: 'sparkles', ambient: 'none',
  },
  G: {
    id: 'G', name: 'Wide Emerald', tagline: 'Light · spacious · green fill',
    swatches: ['#ffffff', '#ecfdf5', '#059669'],
    mode: 'light', density: 'wide', radius: 'soft', activeStyle: 'fill',
    surface: 'solid', iconStyle: 'tile', typography: 'clean',
    accent: 'emerald', logoIcon: 'leaf', ambient: 'subtle',
  },
  H: {
    id: 'H', name: 'Dark Cyan Glow', tagline: 'Dark · cyber neon · animated',
    swatches: ['#0f172a', '#22d3ee', '#67e8f9'],
    mode: 'dark', density: 'cozy', radius: 'soft', activeStyle: 'glow',
    surface: 'gradient', iconStyle: 'tile', typography: 'clean',
    accent: 'cyan', logoIcon: 'zap', ambient: 'aurora',
  },
  I: {
    id: 'I', name: 'Mono Underline', tagline: 'Light · grayscale · underline',
    swatches: ['#ffffff', '#f5f5f5', '#171717'],
    mode: 'light', density: 'cozy', radius: 'sharp', activeStyle: 'underline',
    surface: 'solid', iconStyle: 'minimal', typography: 'mono',
    accent: 'slate', logoIcon: 'square', ambient: 'none',
  },
  J: {
    id: 'J', name: 'Rose Display', tagline: 'Light · pink · display font',
    swatches: ['#fff1f2', '#fce7e9', '#e11d48'],
    mode: 'light', density: 'cozy', radius: 'soft', activeStyle: 'pill',
    surface: 'gradient', iconStyle: 'circle', typography: 'display',
    accent: 'rose', logoIcon: 'flame', ambient: 'subtle',
  },
  K: {
    id: 'K', name: 'Amber Border', tagline: 'Light · golden · ring outline',
    swatches: ['#fffbeb', '#fef3c7', '#d97706'],
    mode: 'light', density: 'cozy', radius: 'soft', activeStyle: 'border',
    surface: 'solid', iconStyle: 'square', typography: 'clean',
    accent: 'amber', logoIcon: 'hexagon', ambient: 'subtle',
  },
  L: {
    id: 'L', name: 'Violet Glass', tagline: 'Light · frosted · purple accent',
    swatches: ['#faf5ff', '#ede9fe', '#7c3aed'],
    mode: 'light', density: 'cozy', radius: 'soft', activeStyle: 'pill',
    surface: 'glass', iconStyle: 'circle', typography: 'clean',
    accent: 'violet', logoIcon: 'diamond', ambient: 'aurora',
  },
  M: {
    id: 'M', name: 'Dark Forest', tagline: 'Dark · deep green · serene',
    swatches: ['#022c22', '#065f46', '#34d399'],
    mode: 'dark', density: 'cozy', radius: 'soft', activeStyle: 'bar',
    surface: 'gradient', iconStyle: 'tile', typography: 'clean',
    accent: 'emerald', logoIcon: 'leaf', ambient: 'aurora',
  },
  N: {
    id: 'N', name: 'Teal Compact', tagline: 'Light · ocean · tight density',
    swatches: ['#f0fdfa', '#ccfbf1', '#0d9488'],
    mode: 'light', density: 'compact', radius: 'soft', activeStyle: 'bar',
    surface: 'solid', iconStyle: 'minimal', typography: 'clean',
    accent: 'teal', logoIcon: 'triangle', ambient: 'subtle',
  },
  O: {
    id: 'O', name: 'Wide Blue Display', tagline: 'Light · roomy · serif feel',
    swatches: ['#eff6ff', '#dbeafe', '#1d4ed8'],
    mode: 'light', density: 'wide', radius: 'soft', activeStyle: 'pill',
    surface: 'gradient', iconStyle: 'tile', typography: 'display',
    accent: 'blue', logoIcon: 'box', ambient: 'subtle',
  },
  P: {
    id: 'P', name: 'Orange Pop', tagline: 'Light · warm · vibrant fill',
    swatches: ['#fff7ed', '#ffedd5', '#ea580c'],
    mode: 'light', density: 'cozy', radius: 'soft', activeStyle: 'fill',
    surface: 'solid', iconStyle: 'circle', typography: 'clean',
    accent: 'orange', logoIcon: 'flame', ambient: 'subtle',
  },
  Q: {
    id: 'Q', name: 'Charcoal Sharp', tagline: 'Dark · industrial · sharp corners',
    swatches: ['#171717', '#262626', '#fafafa'],
    mode: 'dark', density: 'cozy', radius: 'sharp', activeStyle: 'border',
    surface: 'solid', iconStyle: 'square', typography: 'mono',
    accent: 'zinc', logoIcon: 'square', ambient: 'none',
  },
  R: {
    id: 'R', name: 'Lime Fresh', tagline: 'Light · vibrant green · zesty',
    swatches: ['#f7fee7', '#ecfccb', '#65a30d'],
    mode: 'light', density: 'cozy', radius: 'pill', activeStyle: 'fill',
    surface: 'solid', iconStyle: 'circle', typography: 'clean',
    accent: 'lime', logoIcon: 'leaf', ambient: 'subtle',
  },
  S: {
    id: 'S', name: 'Sky Wide', tagline: 'Light · breezy · open spacing',
    swatches: ['#f0f9ff', '#e0f2fe', '#0284c7'],
    mode: 'light', density: 'wide', radius: 'soft', activeStyle: 'glow',
    surface: 'gradient', iconStyle: 'tile', typography: 'clean',
    accent: 'sky', logoIcon: 'triangle', ambient: 'aurora',
  },
  T: {
    id: 'T', name: 'Pink Pastel', tagline: 'Light · soft · friendly',
    swatches: ['#fdf2f8', '#fce7f3', '#db2777'],
    mode: 'light', density: 'cozy', radius: 'pill', activeStyle: 'pill',
    surface: 'gradient', iconStyle: 'circle', typography: 'display',
    accent: 'pink', logoIcon: 'sparkles', ambient: 'aurora',
  },
  U: {
    id: 'U', name: 'Dark Indigo Pro', tagline: 'Dark · indigo · refined',
    swatches: ['#0f172a', '#312e81', '#a5b4fc'],
    mode: 'dark', density: 'cozy', radius: 'soft', activeStyle: 'bar',
    surface: 'solid', iconStyle: 'tile', typography: 'clean',
    accent: 'indigo', logoIcon: 'diamond', ambient: 'subtle',
  },
  V: {
    id: 'V', name: 'Fuchsia Glow', tagline: 'Dark · pink neon · bold',
    swatches: ['#0a0a14', '#831843', '#f0abfc'],
    mode: 'dark', density: 'cozy', radius: 'soft', activeStyle: 'glow',
    surface: 'gradient', iconStyle: 'circle', typography: 'clean',
    accent: 'fuchsia', logoIcon: 'sparkles', ambient: 'aurora',
  },
  W: {
    id: 'W', name: 'Stone Italic', tagline: 'Light · paper · italic emphasis',
    swatches: ['#fafaf9', '#f5f5f4', '#57534e'],
    mode: 'light', density: 'cozy', radius: 'soft', activeStyle: 'underline',
    surface: 'solid', iconStyle: 'minimal', typography: 'italic',
    accent: 'stone', logoIcon: 'box', ambient: 'none',
  },
  X: {
    id: 'X', name: 'Yellow Brutal', tagline: 'Light · sharp · yellow accent',
    swatches: ['#ffffff', '#fef3c7', '#ca8a04'],
    mode: 'light', density: 'cozy', radius: 'sharp', activeStyle: 'fill',
    surface: 'solid', iconStyle: 'square', typography: 'mono',
    accent: 'yellow', logoIcon: 'triangle', ambient: 'none',
  },
  Y: {
    id: 'Y', name: 'Purple Royale', tagline: 'Dark · royal purple · luxe',
    swatches: ['#1e1b4b', '#4c1d95', '#c4b5fd'],
    mode: 'dark', density: 'wide', radius: 'soft', activeStyle: 'glow',
    surface: 'gradient', iconStyle: 'tile', typography: 'display',
    accent: 'purple', logoIcon: 'hexagon', ambient: 'aurora',
    brandGradient: 'from-purple-500 via-violet-500 to-fuchsia-500',
  },
}

export const SIDEBAR_SPEC_KEYS = Object.keys(SIDEBAR_SPECS) as Array<keyof typeof SIDEBAR_SPECS>
