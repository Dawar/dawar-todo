"use client";

import { useEffect, useRef, useState } from "react";
import { ActionIcon } from "./action-icon";

const INTENT_DISTANCE = 8;
const REFRESH_TRIGGER_DISTANCE = 80;
const MAX_INDICATOR_DISTANCE = 64;
const RELOAD_DELAY_MS = 180;

type PullGesture = {
  startX: number;
  startY: number;
  active: boolean;
};

function isAtPageTop() {
  return window.scrollY <= 0 && (document.scrollingElement?.scrollTop ?? 0) <= 0;
}

function shouldIgnoreTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(
    "[data-no-pull-refresh], [role='dialog'], input, textarea, select, [contenteditable='true']",
  ));
}

function standaloneDisplayMode() {
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  return iosNavigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

export function PullToRefresh() {
  const [pullDistance, setPullDistance] = useState(0);
  const [ready, setReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const gestureRef = useRef<PullGesture | null>(null);
  const rawDistanceRef = useRef(0);
  const refreshingRef = useRef(false);
  const reloadTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const narrowViewport = window.matchMedia("(max-width: 767px)");
    const coarsePointer = window.matchMedia("(pointer: coarse)");
    const enabled = () => narrowViewport.matches && coarsePointer.matches;

    const resetGesture = () => {
      gestureRef.current = null;
      rawDistanceRef.current = 0;
      setDragging(false);
      setReady(false);
      setPullDistance(0);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (
        !enabled()
        || refreshingRef.current
        || event.touches.length !== 1
        || !isAtPageTop()
        || document.body.style.overflow === "hidden"
        || shouldIgnoreTarget(event.target)
      ) return;

      const touch = event.touches[0];
      gestureRef.current = { startX: touch.clientX, startY: touch.clientY, active: false };
      rawDistanceRef.current = 0;
    };

    const onTouchMove = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || event.touches.length !== 1 || refreshingRef.current) return;

      const touch = event.touches[0];
      const deltaX = touch.clientX - gesture.startX;
      const deltaY = touch.clientY - gesture.startY;

      if (!gesture.active) {
        if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < INTENT_DISTANCE) return;
        if (deltaY <= 0 || Math.abs(deltaX) >= deltaY || !isAtPageTop()) {
          resetGesture();
          return;
        }
        gesture.active = true;
        setDragging(true);
        console.info("[todo-pwa] pull refresh gesture started", {
          path: window.location.pathname,
          standalone: standaloneDisplayMode(),
        });
      }

      if (!isAtPageTop()) {
        resetGesture();
        return;
      }

      if (event.cancelable) event.preventDefault();
      const rawDistance = Math.max(0, deltaY);
      const nextReady = rawDistance >= REFRESH_TRIGGER_DISTANCE;
      rawDistanceRef.current = rawDistance;
      setReady(nextReady);
      setPullDistance(Math.min(MAX_INDICATOR_DISTANCE, rawDistance * 0.5));
    };

    const finishGesture = (cancelled = false) => {
      const gesture = gestureRef.current;
      if (!gesture?.active || refreshingRef.current) {
        resetGesture();
        return;
      }

      const rawDistance = rawDistanceRef.current;
      gestureRef.current = null;
      rawDistanceRef.current = 0;
      setDragging(false);

      if (cancelled || rawDistance < REFRESH_TRIGGER_DISTANCE) {
        console.info("[todo-pwa] pull refresh cancelled", {
          path: window.location.pathname,
          pullDistance: Math.round(rawDistance),
          reason: cancelled ? "touch-cancelled" : "below-threshold",
        });
        setReady(false);
        setPullDistance(0);
        return;
      }

      refreshingRef.current = true;
      setReady(false);
      setRefreshing(true);
      setPullDistance(MAX_INDICATOR_DISTANCE);
      console.info("[todo-pwa] pull refresh triggered", {
        path: window.location.pathname,
        pullDistance: Math.round(rawDistance),
        online: navigator.onLine,
        standalone: standaloneDisplayMode(),
      });
      reloadTimerRef.current = window.setTimeout(() => window.location.reload(), RELOAD_DELAY_MS);
    };

    const onTouchEnd = () => finishGesture(false);
    const onTouchCancel = () => finishGesture(true);

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchCancel, { passive: true });
    console.info("[todo-pwa] pull refresh ready", {
      enabled: enabled(),
      standalone: standaloneDisplayMode(),
      triggerDistance: REFRESH_TRIGGER_DISTANCE,
    });

    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchCancel);
      if (reloadTimerRef.current !== null) window.clearTimeout(reloadTimerRef.current);
    };
  }, []);

  const visible = pullDistance > 0 || refreshing;
  const label = refreshing ? "Refreshing…" : ready ? "Release to refresh" : "Pull to refresh";
  const indicatorOffset = refreshing ? 12 : Math.min(12, pullDistance - 52);

  return (
    <div
      data-no-pull-refresh
      role="status"
      aria-live="polite"
      aria-hidden={!visible}
      className={`pointer-events-none fixed inset-x-0 z-[120] flex justify-center md:hidden ${dragging ? "transition-none" : "transition-[opacity,transform] duration-150"}`}
      style={{
        top: "calc(env(safe-area-inset-top) + 0.5rem)",
        opacity: visible ? Math.min(1, pullDistance / 20) : 0,
        transform: `translate3d(0, ${indicatorOffset}px, 0)`,
      }}
    >
      <div className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-white px-3 py-2 text-xs font-semibold text-[#216e4e] shadow-lg">
        <ActionIcon
          name="retry"
          className={`h-4 w-4 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
          style={refreshing ? undefined : { transform: `rotate(${Math.min(300, pullDistance * 4.5)}deg)` }}
        />
        {label}
      </div>
    </div>
  );
}
