"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ZoomInAreaIcon, ZoomOutAreaIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";

interface PinchZoomContainerProps {
  children: ReactNode;
  className?: string;
  /**
   * When true, always render a floating "+" button so the user can enter zoom
   * mode without a pinch gesture. Required for iframe children because touch
   * events inside an iframe never bubble out to the parent listener — without
   * the button the user has no way to start zooming.
   *
   * Once zoomed (scale > 1) we overlay a transparent capture div on top of
   * the iframe so further pinch / pan / double-tap gestures work.
   */
  iframeMode?: boolean;
  min?: number;
  max?: number;
  /** Reset zoom when this changes (e.g. switching files). */
  resetKey?: string;
  /**
   * `true` (default) sizes the container to its parent (h-full w-full) —
   * appropriate for fixed-size content like iframes and images.
   * `false` lets the container size with its children, so the outer scroll
   * container keeps working for long content like rendered markdown.
   */
  fill?: boolean;
  /** CSS transform-origin; defaults to `center center`. Use `top left` for
   * document-like content so the page header stays anchored when zooming. */
  originAnchor?: string;
}

/**
 * Wraps content with pinch-to-zoom, single-finger pan (when zoomed), double-tap
 * reset, and floating +/− controls. Used by file preview to let mobile users
 * zoom into HTML / Markdown / SVG / PDF / images, since the app-wide viewport
 * meta disables the browser's native page zoom.
 */
export function PinchZoomContainer({
  children,
  className,
  iframeMode = false,
  min = 1,
  max = 5,
  resetKey,
  fill = true,
  originAnchor = "center center",
}: PinchZoomContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });

  const gestureRef = useRef({
    initialDistance: 0,
    initialScale: 1,
    lastTouchX: 0,
    lastTouchY: 0,
    isPinching: false,
    isPanning: false,
  });

  const resetZoom = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    resetZoom();
  }, [resetKey, resetZoom]);

  const isZoomed = scale > 1;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const g = gestureRef.current;

    function getDistance(t1: Touch, t2: Touch) {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        e.preventDefault();
        g.isPinching = true;
        g.isPanning = false;
        g.initialDistance = getDistance(e.touches[0], e.touches[1]);
        g.initialScale = scale;
      } else if (e.touches.length === 1 && scale > 1) {
        // Single-finger pan only kicks in when zoomed, so scale=1 leaves
        // the underlying scroll / click behavior of children untouched.
        g.isPanning = true;
        g.isPinching = false;
        g.lastTouchX = e.touches[0].clientX;
        g.lastTouchY = e.touches[0].clientY;
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (g.isPinching && e.touches.length === 2) {
        e.preventDefault();
        const dist = getDistance(e.touches[0], e.touches[1]);
        const newScale = Math.min(
          max,
          Math.max(min, g.initialScale * (dist / g.initialDistance)),
        );
        setScale(newScale);
        if (newScale <= 1) setTranslate({ x: 0, y: 0 });
      } else if (g.isPanning && e.touches.length === 1 && scale > 1) {
        e.preventDefault();
        const dx = e.touches[0].clientX - g.lastTouchX;
        const dy = e.touches[0].clientY - g.lastTouchY;
        g.lastTouchX = e.touches[0].clientX;
        g.lastTouchY = e.touches[0].clientY;
        setTranslate((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
      }
    }

    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) g.isPinching = false;
      if (e.touches.length === 0) g.isPanning = false;
    }

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [scale, min, max]);

  // Desktop: Ctrl/Meta + wheel to zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = -e.deltaY * 0.005;
      setScale((prev) => {
        const next = Math.min(max, Math.max(min, prev * (1 + delta)));
        if (next <= 1) setTranslate({ x: 0, y: 0 });
        return next;
      });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [min, max]);

  // Double-tap toggles 1x ↔ 2.5x
  const lastTapRef = useRef(0);
  const handleClick = useCallback(
    (e: ReactMouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("button, a")) return;
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        if (scale > 1) resetZoom();
        else setScale(2.5);
      }
      lastTapRef.current = now;
    },
    [scale, resetZoom],
  );

  const stepZoomIn = () =>
    setScale((s) => Math.min(max, s < 1.5 ? 1.5 : s + 0.5));
  const stepZoomOut = () =>
    setScale((s) => {
      const next = Math.max(min, s - 0.5);
      if (next <= 1) setTranslate({ x: 0, y: 0 });
      return next;
    });

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative",
        fill ? "h-full w-full" : "block w-full",
        // For fixed-size content (fill=true), clip when zoomed so pan
        // doesn't bleed outside the preview area. For flowing content like
        // markdown (fill=false), let the outer scroll container keep working.
        isZoomed && fill && "overflow-hidden",
        className,
      )}
      onClick={handleClick}
    >
      <div
        className={fill ? "h-full w-full" : "block w-full"}
        style={{
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
          transformOrigin: originAnchor,
          transition: isZoomed ? "none" : "transform 0.2s ease-out",
        }}
      >
        {children}
      </div>

      {/* iframe overlay — captures gestures once zoomed so pinch / pan keep
          working on top of iframe content (which doesn't bubble touch out). */}
      {iframeMode && isZoomed && (
        <div className="absolute inset-0 touch-none" aria-hidden="true" />
      )}

      {(isZoomed || iframeMode) && (
        <ZoomControls
          scale={scale}
          onZoomIn={stepZoomIn}
          onZoomOut={stepZoomOut}
          onReset={resetZoom}
          expanded={isZoomed}
        />
      )}
    </div>
  );
}

function ZoomControls({
  scale,
  onZoomIn,
  onZoomOut,
  onReset,
  expanded,
}: {
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  expanded: boolean;
}) {
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onZoomIn();
        }}
        className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white shadow-md backdrop-blur-sm hover:bg-black/70"
        aria-label="Zoom in"
      >
        <HugeiconsIcon icon={ZoomInAreaIcon} className="h-4 w-4" />
      </button>
    );
  }
  return (
    <div className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-full bg-black/60 p-1 text-white shadow-md backdrop-blur-sm">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onZoomOut();
        }}
        className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-white/15"
        aria-label="Zoom out"
      >
        <HugeiconsIcon icon={ZoomOutAreaIcon} className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onReset();
        }}
        className="min-w-[3rem] px-1 text-[11px] tabular-nums hover:underline"
        aria-label="Reset zoom"
      >
        {Math.round(scale * 100)}%
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onZoomIn();
        }}
        className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-white/15"
        aria-label="Zoom in"
      >
        <HugeiconsIcon icon={ZoomInAreaIcon} className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
