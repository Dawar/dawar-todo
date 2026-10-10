import type RFB from "@novnc/novnc";
import type { DesktopViewport } from "./desktop-viewport";

export type DesktopTouchMode = "trackpad" | "direct";
export type DesktopPointer = { x: number; y: number };
const preferenceKey = "dawar-desktop-touch-mode-v1";

export function desktopTouchMode(): DesktopTouchMode {
  if (typeof window === "undefined") return "direct";
  try {
    const saved = localStorage.getItem(preferenceKey);
    if (saved === "trackpad" || saved === "direct") return saved;
  } catch { /* Private browsing still gets the device default. */ }
  return matchMedia("(pointer: coarse)").matches ? "trackpad" : "direct";
}

export function saveDesktopTouchMode(mode: DesktopTouchMode) {
  try { localStorage.setItem(preferenceKey, mode); } catch { /* Session choice still works. */ }
}

// noVNC 1.7 has no public pointer-send API or relative-touch mode. Keep its
// small internal adapter here: it still owns scaling, RFB encoding, throttling,
// connection/viewOnly checks, cursor shape, and the physical mouse handlers.
// Recheck this contract when updating noVNC; never modify node_modules.
type PointerRFB = RFB & {
  showDotCursor: boolean;
  _canvas: HTMLCanvasElement;
  _mousePos: Partial<DesktopPointer>;
  _mouseButtonMask: number;
  _sendMouse(x: number, y: number, mask: number): void;
  _handleMouseMove(x: number, y: number): void;
  _handleMouseButton(x: number, y: number, mask: number): void;
  _cursor: { move(x: number, y: number): void };
};

type Finger = { x: number; y: number; startX: number; startY: number };
const clamp = (n: number) => Math.min(1, Math.max(0, n));

export class DesktopTrackpad {
  private remote: PointerRFB;
  private canvas: HTMLCanvasElement;
  private originalSend: PointerRFB["_sendMouse"];
  private point: DesktopPointer;
  private fingers = new Map<number, Finger>();
  private enabled = false;
  private started = 0;
  private moved = false;
  private multiple = false;
  private cancelled = false;
  private dragging = false;
  private hold: ReturnType<typeof setTimeout> | undefined;
  private scrollX = 0;
  private scrollY = 0;
  private suppressMouseUntil = 0;
  private observer: ResizeObserver;
  private touchCursor = false;
  private pair: { x: number; y: number; distance: number } | null = null;
  private gesture: "pending" | "scroll" | "pinch" = "pending";
  private frame = 0;

  constructor(remote: RFB, private root: HTMLElement, retained: DesktopPointer | null,
    private remember: (point: DesktopPointer) => void, private viewport?: () => DesktopViewport | null) {
    this.remote = remote as PointerRFB;
    const r = this.remote;
    if (!(r._canvas instanceof HTMLCanvasElement) || typeof r._sendMouse !== "function" ||
        typeof r._handleMouseMove !== "function" || typeof r._handleMouseButton !== "function" ||
        typeof r._cursor?.move !== "function") throw new Error("Desktop pointer adapter is unavailable.");
    this.canvas = r._canvas;
    const rect = this.canvas.getBoundingClientRect();
    // RFB does not report other clients' pointer positions. Retain this
    // controller's last position; a new controller starts visibly centered.
    this.point = retained ?? (Number.isFinite(r._mousePos.x) && Number.isFinite(r._mousePos.y) && rect.width && rect.height
      ? { x: clamp(r._mousePos.x! / rect.width), y: clamp(r._mousePos.y! / rect.height) }
      : { x: 0.5, y: 0.5 });
    this.originalSend = r._sendMouse;
    r._sendMouse = (x, y, mask) => {
      const bounds = this.canvas.getBoundingClientRect();
      if (Number.isFinite(x) && Number.isFinite(y) && bounds.width && bounds.height) {
        this.point = { x: clamp(x / bounds.width), y: clamp(y / bounds.height) };
        this.remember({ ...this.point });
      }
      this.originalSend.call(r, x, y, mask);
    };
    for (const name of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"])
      root.addEventListener(name, this.pointer, { capture: true, passive: false });
    for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"])
      root.addEventListener(name, this.touch, { capture: true, passive: false });
    for (const name of ["mousedown", "mousemove", "mouseup", "click", "dblclick", "contextmenu"])
      root.addEventListener(name, this.mouse, { capture: true, passive: false });
    window.addEventListener("blur", this.cancel);
    document.addEventListener("visibilitychange", this.visibility);
    window.addEventListener("orientationchange", this.cancel);
    this.observer = new ResizeObserver(() => { this.cancel(); this.paint(); });
    this.observer.observe(this.canvas);
  }

  setMode(mode: DesktopTouchMode) {
    this.cancel();
    this.enabled = mode === "trackpad";
    this.remote.showDotCursor = this.enabled;
    if (!this.enabled) this.touchCursor = false;
  }

  private coordinates() {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.min(this.point.x * rect.width, Math.max(0, rect.width - rect.width / (this.canvas.width || 1))),
      y: Math.min(this.point.y * rect.height, Math.max(0, rect.height - rect.height / (this.canvas.height || 1))),
      rect,
    };
  }

  private paint() {
    if (!this.enabled || !this.touchCursor) return;
    const { x, y, rect } = this.coordinates();
    this.remote._cursor.move(rect.left + x, rect.top + y);
  }

  private move(dx: number, dy: number) {
    const { rect } = this.coordinates();
    if (!rect.width || !rect.height) return;
    this.point = { x: clamp(this.point.x + dx / rect.width), y: clamp(this.point.y + dy / rect.height) };
    this.remember({ ...this.point });
    const { x, y } = this.coordinates();
    this.remote._handleMouseMove(x, y);
    this.paint();
  }

  private button(mask: number) {
    const { x, y } = this.coordinates();
    this.remote._handleMouseButton(x, y, mask);
    this.paint();
  }

  private click(mask: number) { this.button(mask); this.button(0); }
  private clearHold() { clearTimeout(this.hold); this.hold = undefined; }
  private release() {
    this.clearHold();
    if (this.dragging) {
      this.dragging = false;
      try { this.button(0); } catch { /* Lost transport: cleanup is not an acknowledged remote release. */ }
    }
  }

  cancel = () => {
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.viewport?.()?.endPinch(); this.pair = null;
    this.release();
    if (this.fingers.size) {
      this.cancelled = true;
      const ids = [...this.fingers.keys()];
      // A backgrounded tab may never receive the old pointerup. Clearing
      // tracking allows the next real contact to start a fresh gesture.
      this.fingers.clear();
      this.suppressMouseUntil = performance.now() + 800;
      for (const id of ids) {
        try { if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id); } catch { /* Detached or cancelled. */ }
      }
    }
  };
  private visibility = () => { if (document.hidden) this.cancel(); };
  private stop(event: Event) { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); }

  // Capture touch before noVNC's absolute gesture handler. Mouse/pen input
  // passes unchanged. preventDefault plus this guard excludes compatibility
  // mouse events; an actual mouse pointerdown immediately removes the guard.
  private touch = (event: Event) => {
    // Both touch modes are handled here so noVNC's gesture recognizer cannot
    // turn a pinch into remote wheel/key input. Physical mouse/pen still pass.
    this.stop(event);
  };
  private mouse = (event: Event) => {
    const mouse = event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } };
    if (mouse.sourceCapabilities?.firesTouchEvents || performance.now() < this.suppressMouseUntil)
      this.stop(event);
  };

  private pointer = (event: Event) => {
    const e = event as PointerEvent;
    if (e.pointerType !== "touch") {
      if (e.type === "pointerdown") { this.cancel(); this.touchCursor = false; this.suppressMouseUntil = 0; }
      if (e.type === "pointermove" && e.isTrusted && !this.fingers.size) {
        this.touchCursor = false; this.suppressMouseUntil = 0;
      }
      return;
    }
    this.stop(e);
    this.suppressMouseUntil = performance.now() + 800;
    if (e.type === "pointerdown") {
      if (!this.fingers.size) {
        this.started = performance.now(); this.moved = false; this.multiple = false;
        this.cancelled = this.remote._mouseButtonMask !== 0; this.scrollX = 0; this.scrollY = 0;
        this.touchCursor = this.enabled;
        if (this.remote.focusOnClick) this.remote.focus({ preventScroll: true });
        // No move or button event on contact. The finger's location never
        // becomes the cursor location, including after lifting/repositioning.
        this.paint();
      }
      this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
      try { this.canvas.setPointerCapture(e.pointerId); } catch { this.cancelled = true; }
      if (this.fingers.size === 1 && !this.cancelled) {
        // Hold, then move to drag; a normal swipe never presses a button.
        this.hold = setTimeout(() => {
          if (!this.cancelled && !this.moved && this.fingers.size === 1 && !this.viewport?.()?.panEnabled) {
            if (!this.enabled) this.direct(e.clientX, e.clientY);
            this.dragging = true; this.button(1);
          }
        }, 450);
      } else {
        this.release(); this.multiple = true;
        if (this.fingers.size === 2) {
          this.viewport?.()?.interruptInput(); this.cancelled = false;
        }
        this.pair = this.pairPosition(); this.gesture = "pending";
        if (this.fingers.size > 2) this.cancelled = true;
      }
      return;
    }
    const finger = this.fingers.get(e.pointerId);
    if (!finger) return;
    if (e.type === "pointermove") {
      const dx = e.clientX - finger.x, dy = e.clientY - finger.y;
      finger.x = e.clientX; finger.y = e.clientY;
      if (Math.hypot(e.clientX - finger.startX, e.clientY - finger.startY) > 7) {
        this.moved = true; this.clearHold();
      }
      if (this.cancelled) return;
      if (!this.multiple && this.viewport?.()?.panEnabled) {
        this.clearHold(); this.moved = true; this.viewport()?.pan(dx, dy);
      }
      else if (!this.multiple && this.enabled) this.move(dx, dy);
      else if (!this.multiple) {
        if (this.moved && !this.dragging) {
          this.direct(finger.startX, finger.startY); this.dragging = true; this.button(1);
        }
        this.direct(e.clientX, e.clientY);
      }
      else if (this.fingers.size === 2) {
        // Evaluate a pair once per frame, not once per finger: staggered
        // pointermove events must not misclassify a parallel swipe as a pinch.
        if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.movePair(); });
      }
      return;
    }
    if (e.type === "pointercancel" || e.type === "lostpointercapture") this.cancel();
    if (this.frame) { cancelAnimationFrame(this.frame); this.frame = 0; this.movePair(); }
    const wasDragging = this.dragging;
    this.release();
    this.fingers.delete(e.pointerId);
    try { if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId); } catch { /* Already released. */ }
    if (!this.fingers.size && !this.cancelled && !wasDragging && !this.moved && !this.viewport?.()?.panEnabled && performance.now() - this.started < 300) {
      if (!this.enabled) this.direct(e.clientX, e.clientY);
      this.click(this.multiple ? 4 : 1);
    }
    if (!this.fingers.size) { this.viewport?.()?.endPinch(); this.pair = null; }
  };

  private direct(x: number, y: number) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.point = { x: clamp((x - rect.left) / rect.width), y: clamp((y - rect.top) / rect.height) };
    const p = this.coordinates(); this.remote._handleMouseMove(p.x, p.y);
  }
  private pairPosition() {
    const [a, b] = this.fingers.values();
    if (!a || !b) return null;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  }
  private movePair() {
    const current = this.pairPosition(), before = this.pair;
    if (!current || !before || this.cancelled) return;
    const span = Math.abs(current.distance - before.distance);
    const travel = Math.hypot(current.x - before.x, current.y - before.y);
    if (this.gesture === "pending") {
      if (span > Math.max(12, before.distance * 0.10)) {
        this.gesture = "pinch"; this.moved = true;
        this.viewport?.()?.beginPinch(before.x, before.y, before.distance);
      } else if (travel > 12 && span < Math.max(6, before.distance * 0.03)) {
        this.gesture = "scroll"; this.moved = true;
      } else return;
    }
    if (this.gesture === "pinch") this.viewport?.()?.pinch(current.x, current.y, current.distance);
    else if (this.viewport?.()?.panEnabled) { this.viewport()?.pan(current.x - before.x, current.y - before.y); this.pair = current; }
    else {
      this.scrollX += current.x - before.x; this.scrollY += current.y - before.y;
      for (let i = 0; i < 8 && Math.abs(this.scrollY) >= 18; i++) {
        const sign = Math.sign(this.scrollY); this.click(sign > 0 ? 8 : 16); this.scrollY -= sign * 18;
      }
      for (let i = 0; i < 8 && Math.abs(this.scrollX) >= 18; i++) {
        const sign = Math.sign(this.scrollX); this.click(sign > 0 ? 32 : 64); this.scrollX -= sign * 18;
      }
      this.pair = current;
    }
  }

  dispose() {
    this.cancel();
    this.observer.disconnect();
    for (const name of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"])
      this.root.removeEventListener(name, this.pointer, true);
    for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"])
      this.root.removeEventListener(name, this.touch, true);
    for (const name of ["mousedown", "mousemove", "mouseup", "click", "dblclick", "contextmenu"])
      this.root.removeEventListener(name, this.mouse, true);
    window.removeEventListener("blur", this.cancel);
    document.removeEventListener("visibilitychange", this.visibility);
    window.removeEventListener("orientationchange", this.cancel);
    for (const id of this.fingers.keys()) {
      try { if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id); } catch { /* Detached canvas. */ }
    }
    this.fingers.clear();
    this.remote._sendMouse = this.originalSend;
  }
}
