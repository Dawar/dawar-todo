"use client";
import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/** Measure the actual value, never a wrapped placeholder or an old inline height. */
export function ComposerInput({ value, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const measure = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    let frame = 0, previous = "", active = true;
    const resize = () => {
      if (!input.getClientRects().length || input.clientWidth === 0) return;
      const css = getComputedStyle(input);
      const signature = [input.value, input.clientWidth, css.font, css.lineHeight, css.paddingTop, css.paddingBottom, css.minHeight, css.maxHeight].join("|");
      if (signature === previous) return;
      previous = signature;
      const minimum = parseFloat(css.minHeight) || 40, maximum = parseFloat(css.maxHeight) || 180;
      input.style.height = "0px";
      const border = parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth);
      input.style.height = `${Math.min(maximum, Math.max(minimum, input.value ? input.scrollHeight + border : minimum))}px`;
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
      active = false; measure.current = () => {}; cancelAnimationFrame(frame); observer.disconnect(); styles.disconnect();
      window.visualViewport?.removeEventListener("resize", schedule);
      window.removeEventListener("resize", schedule); window.removeEventListener("pageshow", schedule);
      document.fonts?.removeEventListener("loadingdone", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, []);
  useLayoutEffect(() => { measure.current(); }, [value, props.disabled]);
  return <textarea {...props} ref={ref} value={value} rows={1} />;
}
