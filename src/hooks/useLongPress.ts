"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Detects long-press (touch-and-hold) gestures on mobile.
 *
 * - `isActive` — `true` after the long-press fires, stays `true` until dismissed
 * - `isTouchDevice` — `true` once the first touch is detected (used to
 *   switch Radix Tooltip between controlled / uncontrolled mode)
 * - `cancelClick()` — call at the top of your `onClick`; returns `true`
 *   when the click should be suppressed (it followed a long press)
 * - `dismiss()` — call from a close button to hide the tooltip
 * - `handlers` — spread onto the target element (`onTouchStart/End/Move`)
 */
export function useLongPress(delay = 500) {
  const [isActive, setIsActive] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const timerRef = useRef<number>(0);
  const firedRef = useRef(false);

  // Cleanup on unmount
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  // Auto-dismiss after 5 s so stale tooltips don't linger forever
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

  /** Dismiss the tooltip (for close button). */
  const dismiss = useCallback(() => {
    setIsActive(false);
    firedRef.current = false;
  }, []);

  return {
    isActive,
    isTouchDevice,
    cancelClick,
    dismiss,
    handlers: { onTouchStart, onTouchEnd, onTouchMove },
  };
}
