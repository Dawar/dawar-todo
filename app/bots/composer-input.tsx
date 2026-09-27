"use client";
import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/** Measure the actual value, never a wrapped placeholder or an old inline height. */
export function ComposerInput({ value, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const measure = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    // Measuring the live editor at height zero changes the feed's scroll range
    // (and can trigger native caret scrolling) before its height is restored.
    const mirror = document.createElement("textarea");
    mirror.tabIndex = -1; mirror.setAttribute("aria-hidden", "true");
    mirror.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;height:0;min-height:0;max-height:none;overflow:hidden;box-sizing:border-box;";
    document.body.appendChild(mirror);
    let frame = 0, previous = "", active = true;
    const resize = () => {
      if (!input.getClientRects().length || input.clientWidth === 0) return;
      const css = getComputedStyle(input);
      const properties = ["width", "font", "font-family", "font-size", "font-weight", "font-style", "font-variation-settings", "line-height", "letter-spacing", "word-spacing", "text-indent", "text-transform", "padding", "border-width", "border-style", "white-space", "overflow-wrap", "word-break", "tab-size", "direction"];
      const values = properties.map((property) => css.getPropertyValue(property));
      const signature = [input.value, ...values, css.minHeight, css.maxHeight].join("|");
      if (signature === previous) return;
      previous = signature;
      const minimum = parseFloat(css.minHeight) || 40, maximum = parseFloat(css.maxHeight) || 180;
      const border = parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth);
      properties.forEach((property, index) => mirror.style.setProperty(property, values[index]));
      mirror.wrap = input.wrap; mirror.value = input.value;
      const height = `${Math.min(maximum, Math.max(minimum, input.value ? mirror.scrollHeight + border : minimum))}px`;
      if (input.style.height !== height) input.style.height = height;
    };
    const schedule = () => { if (!active) return; cancelAnimationFrame(frame); frame = requestAnimationFrame(resize); };
    measure.current = resize;
    const observer = new ResizeObserver(schedule);
    observer.observe(input); if (input.parentElement) observer.observe(input.parentElement);
    // Style/font and keyboard changes can change the budget without changing width.
    const styles = new MutationObserver(schedule);
    for (let parent: HTMLElement | null = input; parent; parent = parent.parentElement) styles.observe(parent, { attributes: true, attributeFilter: ["class", "style"] });
    window.visualViewport?.addEventListener("resize", schedule);
    window.addEventListener("resize", schedule); window.addEventListener("pageshow", schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    document.addEventListener("visibilitychange", schedule);
    void document.fonts?.ready.then(schedule);
    resize();
    return () => {
      active = false; measure.current = () => {}; cancelAnimationFrame(frame); observer.disconnect(); styles.disconnect(); mirror.remove();
      window.visualViewport?.removeEventListener("resize", schedule);
      window.removeEventListener("resize", schedule); window.removeEventListener("pageshow", schedule);
      document.fonts?.removeEventListener("loadingdone", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, []);
  useLayoutEffect(() => { measure.current(); }, [value, props.disabled]);
  return <textarea {...props} ref={ref} value={value} rows={1} />;
}
