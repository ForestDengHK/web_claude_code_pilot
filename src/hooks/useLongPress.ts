"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Detects long-press (touch-and-hold) gestures on mobile AND provides
 * controlled tooltip dismiss support for desktop.
 *
 * - `tooltipOpen` — pass to Radix Tooltip `open` prop:
 *     - Mobile (touch): controlled by long-press state
 *     - Desktop: `undefined` (uncontrolled/hover-based) until dismiss is
 *       clicked, then briefly `false` to force-close
 * - `isTouchDevice` — `true` once the first touch is detected
 * - `cancelClick()` — call at the top of your `onClick`; returns `true`
 *   when the click should be suppressed (it followed a long press)
 * - `dismiss()` — call from a close button to hide the tooltip
 * - `handlers` — spread onto the target element (`onTouchStart/End/Move`)
 */
export function useLongPress(delay = 500) {
  const [isActive, setIsActive] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const timerRef = useRef<number>(0);
  const firedRef = useRef(false);
  const dismissTimerRef = useRef<number>(0);

  // Cleanup on unmount
  useEffect(() => () => {
    window.clearTimeout(timerRef.current);
    window.clearTimeout(dismissTimerRef.current);
  }, []);

  // Auto-dismiss after 10s so stale tooltips don't linger forever
  useEffect(() => {
    if (!isActive) return;
    const id = window.setTimeout(() => {
      setIsActive(false);
      firedRef.current = false;
    }, 10_000);
    return () => window.clearTimeout(id);
  }, [isActive]);

  const onTouchStart = useCallback(() => {
    setIsTouchDevice(true);
    // Dismiss any tooltip from a previous long press on this element
    setIsActive(false);
    setIsDismissed(false);
    firedRef.current = false;
    timerRef.current = window.setTimeout(() => {
      firedRef.current = true;
      setIsActive(true);
    }, delay);
  }, [delay]);

  const onTouchEnd = useCallback(() => {
    window.clearTimeout(timerRef.current);
    // Don't dismiss — tooltip stays until close button or auto-dismiss
  }, []);

  const onTouchMove = useCallback(() => {
    // Finger moved → user is scrolling, cancel everything
    window.clearTimeout(timerRef.current);
    setIsActive(false);
    firedRef.current = false;
  }, []);

  /** Returns `true` when the click should be swallowed (follows a long press). */
  const cancelClick = useCallback(() => {
    if (firedRef.current) {
      firedRef.current = false;
      return true;
    }
    return false;
  }, []);

  /** Dismiss the tooltip (for close button). Works on both mobile and desktop. */
  const dismiss = useCallback(() => {
    // Mobile: just clear the long-press state
    setIsActive(false);
    firedRef.current = false;

    // Desktop: briefly switch to controlled mode (open=false) to force-close,
    // then revert to uncontrolled (open=undefined) so hover works normally again.
    setIsDismissed(true);
    window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = window.setTimeout(() => {
      setIsDismissed(false);
    }, 300);
  }, []);

  // Tooltip `open` prop:
  // - Mobile: always controlled by long-press state
  // - Desktop: undefined (Radix handles hover) unless manually dismissed
  const tooltipOpen: boolean | undefined = isTouchDevice
    ? isActive
    : (isDismissed ? false : undefined);

  return {
    isActive,
    /** @deprecated Use `tooltipOpen` instead */
    isOpen: tooltipOpen,
    tooltipOpen,
    isTouchDevice,
    cancelClick,
    dismiss,
    handlers: { onTouchStart, onTouchEnd, onTouchMove },
  };
}
