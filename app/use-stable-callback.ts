"use client";
import { useCallback, useLayoutEffect, useRef } from "react";

export function useStableCallback<Args extends unknown[], Result>(fn: (...args: Args) => Result) {
  const latest = useRef(fn);
  useLayoutEffect(() => { latest.current = fn; });
  return useCallback((...args: Args) => latest.current(...args), []);
}
