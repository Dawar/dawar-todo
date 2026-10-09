"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  Monitor,
  X,
  RefreshCw,
  Keyboard,
  LockKeyhole,
  UsersRound,
  Square,
  MoreHorizontal,
  Move,
  Maximize,
  Minus,
  Plus,
} from "lucide-react";
import type { Bot } from "../../lib/bots-types";
import type { BotDesktopState, BotBrowserRetention } from "../../lib/bots-operations";
import type RFB from "@novnc/novnc";
import { botsClient as client } from "./client";
import { DesktopChannel } from "./desktop-channel";
import { DesktopControl } from "./desktop-control";
import { DesktopTrackpad, desktopTouchMode, saveDesktopTouchMode, type DesktopTouchMode, type DesktopPointer } from "./desktop-trackpad";
import { DesktopKeyboard } from "./desktop-keyboard";
import { DesktopViewport, desktopKeyboardOpen, releaseDesktopInput, type DesktopView } from "./desktop-viewport";
import "./bot-desktop.css";

export function BotDesktopCard({
  bot,
  owner,
  online,
  onOpen,
}: {
  bot: Bot;
  owner: string;
  online: boolean;
  onOpen: () => void;
}) {
  const [desktop, setDesktop] = useState<BotDesktopState | null>(null),
    [error, setError] = useState(""),
    [policyError, setPolicyError] = useState(""),
    [savingPolicy, setSavingPolicy] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    let cancelled = false,
      busy = false,
      visible = false;
    const refresh = async () => {
      if (
        cancelled ||
        busy ||
        !visible ||
        document.visibilityState !== "visible" ||
        !online
      )
        return;
      busy = true;
      try {
        const value = await client.rpc<BotDesktopState>(
          "desktop.preview",
          bot.id,
          {},
          undefined,
          { owner, managed: true },
        );
        if (!cancelled) {
          setDesktop(current => current?.browser && value.browser && current.browser.revision > value.browser.revision
            ? { ...value, browser: current.browser }
            : value);
          setError("");
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Desktop unavailable.");
      } finally {
        busy = false;
      }
    };
    const observer = new IntersectionObserver((entries) => {
      visible = Boolean(entries[0]?.isIntersecting);
      if (visible) void refresh();
    });
    if (ref.current) observer.observe(ref.current);
    const timer = setInterval(() => void refresh(), 5000);
    document.addEventListener("visibilitychange", refresh);
    void refresh();
    return () => {
      cancelled = true;
      clearInterval(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [bot.id, owner, online]);
  const label = !online
    ? "Offline"
    : bot.archived
      ? "Archived"
      : desktop?.state === "running"
        ? "Open desktop"
        : desktop?.state === "stopped"
          ? "Start desktop"
          : "Create desktop";
  return (
    <section
      className="bots-desktop-card"
      ref={ref}
      aria-label={`${bot.name} desktop`}
    >
      <div className="bots-desktop-card-title">
        <Monitor size={16} />
        <strong>{bot.name} · Desktop</strong>
      </div>
      <button
        className="bots-desktop-preview"
        disabled={!online || bot.archived}
        onClick={onOpen}
        aria-label={`${label} for ${bot.name}`}
      >
        {/* Preview bytes are already resized by the VM and must stay private. */}
        {desktop?.image ? (
          // Preview bytes are private, already resized and require no image CDN.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={desktop.image}
            alt={`${bot.name}'s desktop preview`}
            width={desktop.width}
            height={desktop.height}
          />
        ) : (
          <span className="bots-desktop-placeholder">
            <Monitor size={27} />
            <span>
              {desktop?.state === "stopped"
                ? "Apps are closed"
                : "Starts when needed"}
            </span>
          </span>
        )}
        <span className="bots-desktop-preview-label">{label}</span>
      </button>
      {desktop?.browser && (
        <div className="bots-browser-retention">
          <label>
            Browser retention
            <select value={desktop.browser.mode} disabled={!online || bot.archived || savingPolicy}
              onChange={async event => {
                const mode = event.target.value as "preserve" | "idle60" | "keep-task";
                const expectedRevision = desktop.browser!.revision;
                setSavingPolicy(true);
                try {
                  const browser = await client.rpc<BotBrowserRetention>("desktop.browserPolicy", bot.id, { mode, expectedRevision },
                    crypto.randomUUID(), { owner, managed: true });
                  setDesktop(current => current ? { ...current, browser } : current);
                  setPolicyError("");
                } catch (e) { setPolicyError(e instanceof Error ? e.message : "Could not save browser settings."); }
                finally { setSavingPolicy(false); }
              }}>
              <option value="preserve">Preserve browser</option>
              <option value="idle60">Close when safe after 60 minutes</option>
              <option value="keep-task">Keep open for current task</option>
            </select>
          </label>
          <p>{desktop.browser.mode === "idle60"
            ? desktop.browser.protected || !desktop.browser.releasedAt
              ? "Waiting for the agent to designate saved browser work safe to close."
              : "Released · cleanup waits for 60 minutes without work, connections or input."
            : desktop.browser.mode === "keep-task"
              ? "Browser stays open until the agent completes and releases this task, then the previous retention setting resumes."
              : "Browser stays open."} The desktop stays running. Tabs can restore on reopening; unsaved state is not guaranteed.</p>
          {desktop.browser.lastResult && <p role="status">{desktop.browser.lastResult}</p>}
        </div>
      )}
      {error && (
        <p className="bots-desktop-error" role="status">
          {error}
        </p>
      )}
      {policyError && <p className="bots-desktop-error" role="status">{policyError}</p>}
    </section>
  );
}

export function BotDesktopDialog({
  bot,
  owner,
  onClose,
}: {
  bot: Bot;
  owner: string;
  onClose: () => void;
}) {
  const screen = useRef<HTMLDivElement>(null),
    dialog = useRef<HTMLDivElement>(null),
    rfb = useRef<RFB | null>(null),
    trackpad = useRef<DesktopTrackpad | null>(null),
    viewport = useRef<DesktopViewport | null>(null),
    pointer = useRef<DesktopPointer | null>(null),
    pointerScope = useRef(""),
    socket = useRef<WebSocket | null>(null),
    controlReply = useRef<DesktopControl | null>(null);
  const [view, setView] = useState<DesktopView>({ zoom: 1, panning: false });
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const keyboardOpenRef = useRef(false);
  const [touchMode, setTouchMode] = useState<DesktopTouchMode>(desktopTouchMode);
  const touchModeRef = useRef(touchMode);
  useEffect(() => {
    touchModeRef.current = touchMode;
    trackpad.current?.setMode(touchMode);
  }, [touchMode]);
  const [state, setState] = useState("Connecting…"),
    [error, setError] = useState(""),
    [exclusive, setExclusive] = useState<boolean | null>(null),
    [changing, setChanging] = useState(false),
    [retry, setRetry] = useState(0),
    [showText, setShowText] = useState(false);
  const showTextRef = useRef(showText);
  useEffect(() => {
    showTextRef.current = showText;
    if (rfb.current) rfb.current.focusOnClick = !showText;
  }, [showText, state]);
  useEffect(() => {
    const visual = window.visualViewport;
    let baseline = window.innerHeight, width = window.innerWidth, frame = 0;
    const resize = () => {
      if (!dialog.current) return;
      if (width !== window.innerWidth) { width = window.innerWidth; baseline = window.innerHeight; }
      const active = document.activeElement;
      const editable = active instanceof HTMLElement && dialog.current.contains(active) &&
        (active.matches("textarea,input") || active.isContentEditable);
      if (!editable) baseline = Math.max(baseline, window.innerHeight);
      const open = desktopKeyboardOpen(Math.max(baseline, window.innerHeight), visual?.height ?? window.innerHeight, visual?.scale ?? 1, editable);
      keyboardOpenRef.current = open; setKeyboardOpen(open); viewport.current?.alignTop(open);
      dialog.current.style.height = `${visual?.height ?? window.innerHeight}px`;
      dialog.current.style.top = `${visual?.offsetTop ?? 0}px`;
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(resize); };
    resize(); visual?.addEventListener("resize", schedule); visual?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule); document.addEventListener("focusin", schedule); document.addEventListener("focusout", schedule);
    return () => {
      cancelAnimationFrame(frame); visual?.removeEventListener("resize", schedule); visual?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule); document.removeEventListener("focusin", schedule); document.removeEventListener("focusout", schedule);
    };
  }, [bot.id, owner]);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Escape belongs to the remote application while its canvas has focus.
      if (
        event.key === "Escape" &&
        !(document.activeElement instanceof HTMLCanvasElement)
      ) {
        event.preventDefault();
        closeRef.current();
      }
      if (
        event.key === "Tab" &&
        !(document.activeElement instanceof HTMLCanvasElement)
      ) {
        const items = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),summary,input:not(:disabled),textarea:not(:disabled),canvas",
          ) ?? []),
        ].filter((n) => n.getClientRects().length);
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", key);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    let cancelled = false,
      failed = false,
      heartbeat: ReturnType<typeof setInterval> | undefined,
      renewal: ReturnType<typeof setInterval> | undefined,
      timeout: ReturnType<typeof setTimeout> | undefined,
      parentId: string | null | undefined,
      ws: WebSocket | undefined,
      control: DesktopControl | undefined;
    const scope = `${owner}:${bot.id}`;
    if (pointerScope.current !== scope) {
      pointer.current = null;
      pointerScope.current = scope;
    }
    const controller = new AbortController();
    const fail = (message: string) => {
      if (cancelled || failed) return;
      failed = true;
      control?.end();
      clearTimeout(timeout);
      clearInterval(heartbeat);
      clearInterval(renewal);
      trackpad.current?.cancel();
      releaseDesktopInput(rfb.current);
      if (rfb.current) rfb.current.viewOnly = true;
      if (!cancelled) {
        setError(message);
        setState("Disconnected");
        setChanging(false);
      }
      ws?.close();
    };
    void (async () => {
      setError("");
      setState("Starting desktop…");
      setExclusive(null);
      setChanging(false);
      try {
        parentId = client.relayClientId;
        if (!parentId || client.owner !== owner)
          throw new Error("Reconnect DawarTodo before opening the desktop.");
        const access = await client.rpc<{ token: string }>(
          "desktop.open",
          bot.id,
          {},
          undefined,
          { owner, managed: true },
        );
        if (cancelled) return;
        const response = await fetch("/api/bots/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: controller.signal,
        });
        const session = (await response.json()) as {
          ticket: string;
          url: string;
          machineId: string;
          owner: string;
          error?: string;
        };
        if (!response.ok)
          throw new Error(session.error || "Desktop authentication failed.");
        if (
          session.owner !== owner ||
          client.owner !== owner ||
          client.relayClientId !== parentId
        )
          throw new Error("The signed-in session changed.");
        const { default: RFBClass } = await import("@novnc/novnc");
        if (cancelled) return;
        const url = new URL(session.url);
        url.searchParams.set("machine", session.machineId);
        ws = new WebSocket(url);
        socket.current = ws;
        const current = () => !cancelled && !failed && socket.current === ws &&
          client.owner === owner && client.relayClientId === parentId && client.online;
        control = new DesktopControl(
          exclusive => {
            if (!current() || ws?.readyState !== WebSocket.OPEN)
              throw new Error("Desktop stream changed.");
            ws.send(JSON.stringify({ type: "desktop", event: "control", exclusive }));
          },
          value => {
            if (cancelled || socket.current !== ws) return;
            setExclusive(value.exclusive);
            setChanging(value.changing);
          },
          fail,
        );
        controlReply.current = control;
        const channel = new DesktopChannel(ws);
        timeout = setTimeout(
          () => fail("The desktop did not connect. Reconnect to try again."),
          45000,
        );
        ws.addEventListener("open", () =>
          ws?.send(
            JSON.stringify({
              type: "auth",
              role: "browser",
              ticket: session.ticket,
              desktop: { botId: bot.id, token: access.token, parentId },
            }),
          ),
        );
        ws.addEventListener("message", (event) => {
          if (!current()) return;
          if (typeof event.data !== "string") return;
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (message.type === "error" || message.event === "closed") {
            fail(message.error || "Desktop disconnected.");
            return;
          }
          if (message.event === "control") {
            control?.reply(message);
            return;
          }
          if (message.event !== "ready" || rfb.current || !screen.current)
            return;
          const remote = new RFBClass(screen.current, channel, {
            shared: true,
            credentials: { password: message.password },
          });
          message.password = undefined;
          rfb.current = remote;
          remote.scaleViewport = true;
          remote.resizeSession = false;
          remote.qualityLevel = 6;
          remote.compressionLevel = 2;
          remote.addEventListener("connect", () => {
            if (current()) {
              try {
                trackpad.current = new DesktopTrackpad(remote, screen.current!, pointer.current,
                  (value) => { pointer.current = value; }, () => viewport.current);
                viewport.current = new DesktopViewport(remote, screen.current!, setView, () => trackpad.current?.cancel());
                viewport.current.alignTop(keyboardOpenRef.current);
                trackpad.current.setMode(touchModeRef.current);
              } catch {
                fail("Desktop pointer controls could not start. Reconnect to try again.");
                return;
              }
              setState("Connected");
              control?.connected();
              setError("");
              clearTimeout(timeout);
              remote.focusOnClick = !showTextRef.current;
              if (!showTextRef.current) remote.focus({ preventScroll: true });
            }
          });
          remote.addEventListener("disconnect", () => {
            fail("Desktop disconnected. Reconnect to continue; apps stay running.");
          });
          remote.addEventListener("securityfailure", () =>
            fail("Desktop authentication failed."),
          );
          renewal = setInterval(
            () => {
              void (async () => {
                try {
                  const response = await fetch("/api/bots/session", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: "{}",
                    signal: controller.signal,
                  });
                  const fresh = (await response.json()) as {
                    ticket: string;
                    owner: string;
                    error?: string;
                  };
                  if (
                    !response.ok ||
                    fresh.owner !== owner ||
                    client.owner !== owner
                  )
                    throw new Error(fresh.error || "Desktop session expired.");
                  if (current() && ws?.readyState === WebSocket.OPEN)
                    ws.send(
                      JSON.stringify({
                        type: "auth",
                        role: "browser",
                        ticket: fresh.ticket,
                      }),
                    );
                } catch (e) {
                  if (current())
                    fail(
                      e instanceof Error
                        ? e.message
                        : "Desktop session renewal failed.",
                    );
                }
              })();
            },
            10 * 60 * 1000,
          );
          heartbeat = setInterval(() => {
            if (current() && ws?.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: "desktop", event: "ping" }));
          }, 10000);
        });
        ws.addEventListener("close", () => {
          fail("Desktop connection closed. Reconnect to continue; apps stay running.");
        });
        ws.addEventListener("error", () => fail("Desktop connection failed."));
      } catch (e) {
        if (!cancelled)
          fail(e instanceof Error ? e.message : "Desktop unavailable.");
      }
    })();
    // Owner sign-out, bot deletion and parent reconnect revoke this separate stream.
    const revocation = setInterval(() => {
      if (client.owner !== owner || !client.online || (parentId && client.relayClientId !== parentId))
        fail("DawarTodo disconnected. Reconnect to continue.");
    }, 1000);
    return () => {
      cancelled = true;
      control?.end();
      if (controlReply.current === control) controlReply.current = null;
      controller.abort();
      clearInterval(heartbeat);
      clearInterval(renewal);
      clearInterval(revocation);
      clearTimeout(timeout);
      viewport.current?.dispose();
      viewport.current = null;
      trackpad.current?.dispose();
      trackpad.current = null;
      rfb.current?.disconnect();
      rfb.current = null;
      ws?.close();
      socket.current = null;
    };
  }, [bot.id, owner, retry]);
  const control = () => {
    if (exclusive === null) setRetry(v => v + 1);
    else controlReply.current?.request();
  };
  const stop = async () => {
    if (!window.confirm("Stop this desktop? Its open apps will close.")) return;
    try {
      await client.rpc("desktop.stop", bot.id, {}, undefined, {
        owner,
        managed: true,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not stop desktop.");
    }
  };
  return createPortal(
    <div
      className={`bots-desktop-dialog${keyboardOpen ? " bots-desktop-keyboard-open" : ""}`}
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={`${bot.name} desktop control`}
    >
      <header>
        <div className="bots-desktop-heading">
          <Monitor size={20} aria-hidden="true" />
          <div><strong>{bot.name}</strong><span role="status" data-connected={state === "Connected"}>{state}{state === "Disconnected" && exclusive === null ? " · Control unknown" : ""}</span></div>
        </div>
        <button onClick={onClose} aria-label="Close desktop · apps stay running" title="Close viewer · apps stay running"><X size={22} /></button>
      </header>
      <div className="bots-desktop-controls">
      <div className="bots-desktop-toolbar" aria-label="Desktop controls">
        <div className="bots-desktop-control-group">
          <button disabled={state !== "Connected"} onClick={() => {
            trackpad.current?.cancel(); releaseDesktopInput(rfb.current);
            flushSync(() => setShowText(v => !v));
            const typing = dialog.current?.querySelector<HTMLTextAreaElement>("[data-desktop-typing]");
            if (typing) typing.focus({ preventScroll: true }); else rfb.current?.focus({ preventScroll: true });
          }} aria-pressed={showText} aria-label={showText ? "Hide remote keyboard" : "Open remote keyboard"}>
            <Keyboard size={18} /><span>Keyboard</span>
          </button>
          <button type="button" aria-label={`Touch input: ${touchMode === "trackpad" ? "Trackpad" : "Direct touch"}. Switch touch mode`}
            onClick={() => { releaseDesktopInput(rfb.current); const next = touchMode === "trackpad" ? "direct" : "trackpad"; saveDesktopTouchMode(next); setTouchMode(next); }}>
            {touchMode === "trackpad" ? "Trackpad" : "Direct touch"}
          </button>
        <button className="bots-desktop-lease" disabled={changing || (state !== "Connected" && state !== "Disconnected")} onClick={control}
          aria-pressed={exclusive ?? undefined} aria-label={exclusive === null ? "Reconnect desktop control" : exclusive ? "Release exclusive control" : "Take exclusive control"}
          title={exclusive === null ? "Reconnect without replaying input; apps stay running" : exclusive ? "Let the agent use mouse and keyboard too" : "Pause agent mouse and keyboard input"}>
          {exclusive === null ? <RefreshCw size={16} /> : exclusive ? <LockKeyhole size={16} /> : <UsersRound size={16} />}<span>{changing ? "Changing control…" : exclusive === null ? "Reconnect control" : exclusive ? "Exclusive" : "Shared"}</span>
        </button>
        </div>
        <div className="bots-desktop-control-group bots-desktop-scale" aria-label="Screen zoom">
          <button disabled={state !== "Connected" || view.zoom <= 0.5} aria-label="Zoom screen out" onClick={() => viewport.current?.setZoom(view.zoom / 1.25)}><Minus size={17} /></button>
          <button disabled={state !== "Connected"} aria-label={`Fit screen · ${Math.round(view.zoom * 100)} percent of fit`} onClick={() => viewport.current?.fit()}><Maximize size={16} /><span>{view.zoom === 1 ? "Fit" : `${Math.round(view.zoom * 100)}%`}</span></button>
          <button disabled={state !== "Connected" || view.zoom >= 4} aria-label="Zoom screen in" onClick={() => viewport.current?.setZoom(view.zoom * 1.25)}><Plus size={17} /></button>
          <button disabled={state !== "Connected" || view.zoom <= 1} aria-label="Pan enlarged screen" aria-pressed={view.panning} onClick={() => viewport.current?.togglePan()}><Move size={17} /><span>Pan</span></button>
        </div>
        <details className="bots-desktop-more">
          <summary aria-label="More desktop options"><MoreHorizontal size={20} /></summary>
          <div>
            <button onClick={() => setRetry(v => v + 1)}><RefreshCw size={17} />Reconnect</button>
            <button onClick={() => void stop()} disabled={Boolean(bot.activeTurnId)}><Square size={17} />Stop desktop</button>
            <p>Closing the viewer leaves apps running. Stop closes them.</p>
            <p>{touchMode === "trackpad" ? "Swipe to move · Tap to click · Hold to drag · Two fingers to scroll or right-click." : "Tap to click · Drag to move remote items."} Pinch to zoom; use Pan to move an enlarged screen.</p>
            <p>{exclusive === null ? "Control mode is unknown. Reconnect; an unconfirmed exclusive lease may remain until its release or expiry." : exclusive ? "Agent input is paused while you have exclusive control." : "You and the agent can use this desktop together."}</p>
          </div>
        </details>
      </div>
      </div>
      {error && (
        <p className="bots-desktop-error" role="alert">
          {error}
        </p>
      )}
      <div className="bots-desktop-screen" ref={screen} />
      {showText && <DesktopKeyboard key={`${owner}:${bot.id}`} remote={() => rfb.current} connected={state === "Connected"}
        onClose={() => { setShowText(false); rfb.current?.focus({ preventScroll: true }); }} />}

    </div>,
    document.body,
  );
}
