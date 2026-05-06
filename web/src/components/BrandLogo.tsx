// Reusable PrepShip brand mark. Renders the transparent logo PNG so it
// looks correct on any background (light/dark themes, colored tiles).
//
// Why a component instead of an inline <img>?
//   - One place to swap the asset (re-export, A/B test, etc.)
//   - Consistent srcset / sizing across every place it's used
//   - Decorative role + empty alt by default (we usually pair with a
//     visible "PrepShip" text label, so the image itself is decorative
//     to screen readers — pass `decorative={false}` for standalone use)
//
// Asset is `/prepshiplogo-transparent.png` (1254×1254 RGBA, served from
// web/public). Vite copies it to dist/ as-is and the browser caches it.

interface BrandLogoProps {
  /** Pixel size of the longer dimension. Renders square. Default 24. */
  size?: number;
  /** Tailwind / inline classes for the wrapping <img>. */
  className?: string;
  /** When true (default), image is decorative — screen readers skip it.
   *  Set false when the logo stands alone without a sibling text label. */
  decorative?: boolean;
}

export function BrandLogo({ size = 24, className = '', decorative = true }: BrandLogoProps) {
  return (
    <img
      src="/prepshiplogo-transparent.png"
      alt={decorative ? '' : 'PrepShip'}
      aria-hidden={decorative || undefined}
      width={size}
      height={size}
      className={className}
      style={{ width: size, height: size, objectFit: 'contain', display: 'block' }}
      draggable={false}
    />
  );
}

export default BrandLogo;
