// v2-parity hover preview. Renders a tiny thumbnail; on hover, pops a
// floating image preview that tracks the cursor. The preview is mounted at
// documentElement, outside PrepShip's body-level zoom, so right-side panel
// thumbnails stay visible at 75%/90% app zoom.

import { useEffect, useRef } from 'react';

type HoverImageProps = {
  src: string | null | undefined;
  alt?: string;
  size: number;
  previewSize?: number;
  radius?: number;
  fallback?: React.ReactNode;
  title?: string;
};

let previewEl: HTMLDivElement | null = null;
let previewImg: HTMLImageElement | null = null;
let moveHandler: ((ev: MouseEvent) => void) | null = null;

function ensurePreviewElement(previewSize: number): HTMLDivElement {
  if (previewEl) {
    if (previewEl.parentElement !== document.documentElement) {
      document.documentElement.appendChild(previewEl);
    }
    return previewEl;
  }

  const el = document.createElement('div');
  el.id = '_thumb-preview';
  el.style.cssText =
    'position:fixed;z-index:99999;background:var(--bg,#fff);' +
    'border:1px solid var(--border,#ddd);border-radius:8px;' +
    'box-shadow:0 6px 24px rgba(0,0,0,.22);padding:5px;' +
    'pointer-events:none;display:none';

  const img = document.createElement('img');
  img.style.cssText = `width:${previewSize}px;height:${previewSize}px;object-fit:contain;border-radius:5px;display:block`;
  el.appendChild(img);
  document.documentElement.appendChild(el);
  previewEl = el;
  previewImg = img;
  return el;
}

function position(el: HTMLDivElement, cx: number, cy: number, previewSize: number) {
  const gap = 14;
  const fullW = previewSize + 10; // size + padding
  const rawLeft = Math.max(gap, Math.min(cx + gap, window.innerWidth - fullW - gap));
  const rawTop = Math.max(gap, Math.min(cy - fullW / 2, window.innerHeight - fullW - gap));
  el.style.left = `${rawLeft}px`;
  el.style.top = `${rawTop}px`;
  el.style.removeProperty('zoom');
}

function showPreview(src: string, ev: React.MouseEvent, previewSize: number) {
  const el = ensurePreviewElement(previewSize);
  if (previewImg) {
    previewImg.style.width = `${previewSize}px`;
    previewImg.style.height = `${previewSize}px`;
    previewImg.src = src;
  }
  position(el, ev.clientX, ev.clientY, previewSize);
  el.style.display = 'block';
  if (moveHandler) document.removeEventListener('mousemove', moveHandler);
  moveHandler = (e: MouseEvent) => position(el, e.clientX, e.clientY, previewSize);
  document.addEventListener('mousemove', moveHandler);
}

function hidePreview() {
  if (previewEl) previewEl.style.display = 'none';
  if (moveHandler) {
    document.removeEventListener('mousemove', moveHandler);
    moveHandler = null;
  }
}

export default function HoverImage({
  src,
  alt = '',
  size,
  previewSize = 160,
  radius,
  fallback,
  title,
}: HoverImageProps) {
  const hideOnUnmountRef = useRef(true);
  useEffect(() => {
    const ref = hideOnUnmountRef;
    return () => {
      if (ref.current) hidePreview();
    };
  }, []);

  if (!src) {
    return fallback ? <>{fallback}</> : null;
  }

  return (
    <img
      src={src}
      alt={alt}
      title={title}
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? Math.floor(size / 8),
        objectFit: 'cover',
        flexShrink: 0,
        cursor: 'zoom-in',
      }}
      onMouseEnter={(ev) => showPreview(src, ev, previewSize)}
      onMouseLeave={() => hidePreview()}
    />
  );
}
