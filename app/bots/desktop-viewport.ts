import type RFB from "@novnc/novnc";

export type DesktopView = { zoom: number; panning: boolean };
export function desktopGeometry(width: number, height: number, remoteWidth: number, remoteHeight: number, zoom: number) {
  const fit = remoteWidth > 0 && remoteHeight > 0 ? Math.min(width / remoteWidth, height / remoteHeight) : 0;
  const bounded = Math.max(0.5, Math.min(4, zoom));
  return { zoom: bounded, scale: fit * bounded, width: remoteWidth * fit * bounded, height: remoteHeight * fit * bounded };
}

// Mobile browser chrome can resize visualViewport too. Only a focused editable
// control plus a substantial unscaled height loss counts as an open keyboard.
export function desktopKeyboardOpen(layoutHeight: number, visibleHeight: number, scale: number, editable: boolean) {
  return editable && Math.abs(scale - 1) < 0.05 && layoutHeight - visibleHeight > Math.max(100, layoutHeight * 0.18);
}

type ViewRFB = RFB & {
  _screen: HTMLDivElement; _canvas: HTMLCanvasElement;
  _display: { width: number; height: number; scale: number };
  _updateScale(): void;
  _mouseButtonMask: number; _mousePos: { x?: number; y?: number };
  _handleMouseButton(x: number, y: number, mask: number): void;
  _keyboard: { _allKeysUp(): void };
};

// The installed noVNC 1.7 adapter owns CSS canvas size AND Display.absX/absY.
// Never transform the canvas separately: that would corrupt direct/mouse input.
// Release while the original channel is available; this is best effort, not a
// remote acknowledgement or a replacement for the held reconnect/ACK task.
export function releaseDesktopInput(remote: RFB | null) {
  if (!remote) return;
  const r = remote as ViewRFB;
  try {
    if (r._mouseButtonMask) r._handleMouseButton(r._mousePos.x ?? 0, r._mousePos.y ?? 0, 0);
  } catch { /* A failed channel cannot acknowledge release; keep disconnect cleanup responsive. */ }
  try { r._keyboard?._allKeysUp(); } catch { /* Same best-effort boundary on a lost channel. */ }
}

export class DesktopViewport {
  private r: ViewRFB;
  private originalScale: ViewRFB["_updateScale"];
  private observer: ResizeObserver;
  private framebuffer: MutationObserver;
  private zoom = 1;
  private panning = false;
  private top = false;
  private disposed = false;
  private pinchAnchor: { x: number; y: number; zoom: number; distance: number } | null = null;

  constructor(remote: RFB, private root: HTMLElement, private changed: (view: DesktopView) => void,
    private cancel: () => void) {
    this.r = remote as ViewRFB;
    const r = this.r;
    if (!(r._canvas instanceof HTMLCanvasElement) || !r._display || typeof r._updateScale !== "function")
      throw new Error("Desktop viewport controls are unavailable.");
    this.originalScale = r._updateScale;
    r._updateScale = () => {
      this.cancelInput();
      // Retain noVNC's Safari scrollbar repair and future scale side effects,
      // then apply our bounded zoom in the same display coordinate system.
      this.originalScale.call(r); this.layout(true);
    };
    r._screen.style.overscrollBehavior = "contain";
    r._canvas.style.flexShrink = "0";
    this.observer = new ResizeObserver(() => { this.cancelInput(); this.layout(true); });
    this.observer.observe(root);
    // Framebuffer resolution changes need the same mapping/fit refresh.
    this.framebuffer = new MutationObserver(() => { this.cancelInput(); this.layout(true); });
    this.framebuffer.observe(r._canvas, { attributes: true, attributeFilter: ["width", "height"] });
    this.layout(true);
    this.changed({ zoom: this.zoom, panning: this.panning });
  }

  private cancelInput() { this.cancel(); releaseDesktopInput(this.r); }
  private layout(center = false) {
    if (this.disposed) return;
    const r = this.r;
    const g = desktopGeometry(this.root.clientWidth, this.root.clientHeight, r._display.width, r._display.height, this.zoom);
    if (!g.scale) return;
    if (Math.abs(r._display.scale - g.scale) > 0.00001) r._display.scale = g.scale;
    r._canvas.style.margin = this.top ? "0 auto auto" : "auto";
    if (center) {
      r._screen.scrollLeft = Math.max(0, (g.width - this.root.clientWidth) / 2);
      r._screen.scrollTop = this.top ? 0 : Math.max(0, (g.height - this.root.clientHeight) / 2);
    }
  }

  alignTop(value: boolean) {
    if (this.top === value) return;
    this.cancelInput(); this.top = value; this.layout(true);
  }
  setZoom(value: number) {
    this.cancelInput(); this.zoom = desktopGeometry(1, 1, 1, 1, value).zoom;
    if (this.zoom <= 1) this.panning = false;
    this.layout(true); this.changed({ zoom: this.zoom, panning: this.panning });
  }
  fit() { this.panning = false; this.setZoom(1); }
  togglePan() {
    this.cancelInput(); this.panning = !this.panning;
    this.changed({ zoom: this.zoom, panning: this.panning });
  }
  get panEnabled() { return this.panning; }
  interruptInput() { releaseDesktopInput(this.r); }
  pan(dx: number, dy: number) { this.r._screen.scrollLeft -= dx; this.r._screen.scrollTop -= dy; }
  beginPinch(x: number, y: number, distance: number) {
    releaseDesktopInput(this.r);
    const rect = this.r._canvas.getBoundingClientRect();
    this.pinchAnchor = { x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height, zoom: this.zoom, distance };
  }
  pinch(x: number, y: number, distance: number) {
    const anchor = this.pinchAnchor;
    if (!anchor || !anchor.distance) return;
    this.zoom = desktopGeometry(1, 1, 1, 1, anchor.zoom * distance / anchor.distance).zoom;
    this.layout();
    const rect = this.r._canvas.getBoundingClientRect();
    this.r._screen.scrollLeft += rect.left + anchor.x * rect.width - x;
    this.r._screen.scrollTop += rect.top + anchor.y * rect.height - y;
    this.changed({ zoom: this.zoom, panning: this.panning });
  }
  endPinch() { this.pinchAnchor = null; }
  dispose() {
    this.cancelInput(); this.disposed = true; this.observer.disconnect(); this.framebuffer.disconnect();
    this.r._updateScale = this.originalScale; this.pinchAnchor = null;
  }
}
