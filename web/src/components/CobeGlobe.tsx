/**
 * CobeGlobe — interactive 3D globe with animated shipment-pulse arcs.
 *
 * Ported into v4-stable from the animations/Network Globe design study.
 * Vite + React 18 friendly: no "use client" directive, no `next/dynamic`,
 * no SSR concerns (Vite is client-only here).
 *
 * Visual model:
 *   • Persistent dim arcs connect every fulfillment marker pair —
 *     a faint baseline network.
 *   • Every ~1500ms a BRIGHT pulse spawns on a random route, ramps up
 *     and back down via a smoothstep triangle envelope across ~3.5s.
 *     Up to 3 concurrent pulses — sells "live network activity" without
 *     ever flashing or strobing.
 *   • Drag-to-rotate works (cursor switches to grabbing). Auto-rotation
 *     pauses while the user drags, resumes on release.
 *
 * All GPU work is cobe's. We only push 6 RGB values per frame, which is
 * trivially cheap (no perf concern on phones / older laptops).
 *
 * NOTE on `positionAnchor`: this CSS Anchor Positioning property is
 * supported in Chrome 125+ and Safari TP. React 18's CSS types may not
 * know about it, so we cast via `as React.CSSProperties` to silence TS.
 * If you need to support older browsers, the marker halos won't anchor
 * and will simply not render visually — the globe itself works fine.
 */

import { useEffect, useRef, useCallback } from 'react';
import createGlobe, { type Arc } from 'cobe';

interface PulseMarker {
  id: string;
  location: [number, number];
  delay: number;
}

interface CobeGlobeProps {
  markers?: PulseMarker[];
  className?: string;
  speed?: number;
}

const defaultMarkers: PulseMarker[] = [
  { id: 'node-london', location: [51.51, -0.13], delay: 0 },
  { id: 'node-newyork', location: [40.71, -74.01], delay: 0.5 },
  { id: 'node-tokyo', location: [35.68, 139.65], delay: 1 },
  { id: 'node-sydney', location: [-33.87, 151.21], delay: 1.5 },
];

/* Animation tuning constants */
const PULSE_DURATION_MS = 3500;
const SPAWN_INTERVAL_MS = 1400;
const MAX_CONCURRENT = 3;
const DIM_COLOR: [number, number, number] = [0.16, 0.2, 0.26];
const BRIGHT_COLOR: [number, number, number] = [0.62, 0.78, 0.95];

type LivePulse = {
  pairIndex: number;
  startTime: number;
};

export function CobeGlobe({
  markers = defaultMarkers,
  className = '',
  speed = 0.0022,
}: CobeGlobeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerInteracting = useRef<{ x: number; y: number } | null>(null);
  const dragOffset = useRef({ phi: 0, theta: 0 });
  const phiOffsetRef = useRef(0);
  const thetaOffsetRef = useRef(0);
  const isPausedRef = useRef(false);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    pointerInteracting.current = { x: e.clientX, y: e.clientY };
    if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
    isPausedRef.current = true;
  }, []);

  const handlePointerUp = useCallback(() => {
    if (pointerInteracting.current !== null) {
      phiOffsetRef.current += dragOffset.current.phi;
      thetaOffsetRef.current += dragOffset.current.theta;
      dragOffset.current = { phi: 0, theta: 0 };
    }
    pointerInteracting.current = null;
    if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
    isPausedRef.current = false;
  }, []);

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      if (pointerInteracting.current !== null) {
        dragOffset.current = {
          phi: (e.clientX - pointerInteracting.current.x) / 300,
          theta: (e.clientY - pointerInteracting.current.y) / 1000,
        };
      }
    };
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointerup', handlePointerUp, { passive: true });
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [handlePointerUp]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    let globe: ReturnType<typeof createGlobe> | null = null;
    let animationId: number;
    let phi = 0;

    const allPairs: Array<{ from: [number, number]; to: [number, number] }> =
      markers.flatMap((fromMarker, i) =>
        markers.slice(i + 1).map((toMarker) => ({
          from: fromMarker.location,
          to: toMarker.location,
        })),
      );

    let livePulses: LivePulse[] = [];
    let lastSpawn = 0;
    const startTime = performance.now();

    function envelope(t: number): number {
      const tri = t < 0.5 ? t * 2 : (1 - t) * 2;
      return tri * tri * (3 - 2 * tri);
    }

    function lerpColor(intensity: number): [number, number, number] {
      return [
        DIM_COLOR[0] + (BRIGHT_COLOR[0] - DIM_COLOR[0]) * intensity,
        DIM_COLOR[1] + (BRIGHT_COLOR[1] - DIM_COLOR[1]) * intensity,
        DIM_COLOR[2] + (BRIGHT_COLOR[2] - DIM_COLOR[2]) * intensity,
      ];
    }

    function init() {
      const width = canvas.offsetWidth;
      if (width === 0 || globe) return;

      globe = createGlobe(canvas, {
        devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        width,
        height: width,
        phi: 0,
        theta: 0.25,
        dark: 1,
        diffuse: 1.2,
        mapSamples: 16000,
        mapBrightness: 6,
        baseColor: [0.32, 0.38, 0.48],
        markerColor: [0.48, 0.64, 0.82],
        glowColor: [0.08, 0.1, 0.14],
        markerElevation: 0,
        markers: markers.map((m) => ({
          location: m.location,
          size: 0.04,
        })),
        arcs: allPairs.map((p) => ({ from: p.from, to: p.to, color: DIM_COLOR })),
        arcColor: DIM_COLOR,
        arcWidth: 0.5,
        arcHeight: 0.32,
        opacity: 0.85,
      });

      function animate() {
        const now = performance.now();
        const elapsed = now - startTime;

        // Cull expired pulses
        livePulses = livePulses.filter(
          (p) => now - p.startTime < PULSE_DURATION_MS,
        );

        // Spawn new pulse on schedule
        if (
          elapsed - lastSpawn > SPAWN_INTERVAL_MS &&
          livePulses.length < MAX_CONCURRENT
        ) {
          const occupied = new Set(livePulses.map((p) => p.pairIndex));
          const available: number[] = [];
          for (let i = 0; i < allPairs.length; i++) {
            if (!occupied.has(i)) available.push(i);
          }
          if (available.length > 0) {
            // Guarded index — TS strict noUncheckedIndexedAccess sees
            // `available[i]` as possibly undefined; the `length > 0`
            // check above guarantees the element exists at runtime.
            const idx = available[Math.floor(Math.random() * available.length)]!;
            livePulses.push({ pairIndex: idx, startTime: now });
            lastSpawn = elapsed;
          }
        }

        const arcs: Arc[] = allPairs.map((p, i) => {
          const pulse = livePulses.find((lp) => lp.pairIndex === i);
          if (!pulse) return { from: p.from, to: p.to, color: DIM_COLOR };
          const t = (now - pulse.startTime) / PULSE_DURATION_MS;
          return { from: p.from, to: p.to, color: lerpColor(envelope(t)) };
        });

        if (!isPausedRef.current) phi += speed;

        globe!.update({
          phi: phi + phiOffsetRef.current + dragOffset.current.phi,
          theta: 0.25 + thetaOffsetRef.current + dragOffset.current.theta,
          arcs,
        });

        animationId = requestAnimationFrame(animate);
      }

      animate();
      setTimeout(() => canvas && (canvas.style.opacity = '1'));
    }

    if (canvas.offsetWidth > 0) {
      init();
    } else {
      const ro = new ResizeObserver((entries) => {
        const first = entries[0];
        if (first && first.contentRect.width > 0) {
          ro.disconnect();
          init();
        }
      });
      ro.observe(canvas);
    }

    return () => {
      if (animationId) cancelAnimationFrame(animationId);
      if (globe) globe.destroy();
    };
  }, [markers, speed]);

  return (
    <div className={`relative aspect-square select-none ${className}`}>
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        style={{
          width: '100%',
          height: '100%',
          cursor: 'grab',
          opacity: 0,
          transition: 'opacity 1.6s ease',
          borderRadius: '50%',
          touchAction: 'none',
        }}
      />
    </div>
  );
}
