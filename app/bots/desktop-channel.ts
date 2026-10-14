/** Adapt our authenticated relay socket to the raw RFB channel noVNC expects.
 * Control/auth frames never enter the binary RFB decoder. */
export class DesktopChannel {
  binaryType: BinaryType = "arraybuffer";
  protocol = "";
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private handler: ((event: MessageEvent) => void) | null = null;
  private queued: MessageEvent[] = [];
  private bytes = 0;
  constructor(public socket: WebSocket) {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      if (this.handler) this.handler(event);
      else {
        this.bytes += event.data.byteLength;
        if (this.bytes > 2 * 1024 * 1024) this.close();
        else this.queued.push(event);
      }
    });
    socket.addEventListener("close", (event) => this.onclose?.(event));
    socket.addEventListener("error", (event) => this.onerror?.(event));
  }
  get readyState() {
    return this.socket.readyState;
  }
  get onmessage() {
    return this.handler;
  }
  set onmessage(value: ((event: MessageEvent) => void) | null) {
    this.handler = value;
    queueMicrotask(() => {
      if (!this.handler) return;
      for (const event of this.queued.splice(0)) this.handler(event);
      this.bytes = 0;
    });
  }
  send(data: ArrayBuffer | ArrayBufferView | Blob | string) {
    this.socket.send(data);
  }
  close() {
    this.queued = [];
    this.socket.close();
  }
}
