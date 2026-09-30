"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Monitor,
  X,
  RefreshCw,
  Keyboard,
  LockKeyhole,
  UsersRound,
  Square,
} from "lucide-react";
import type { Bot } from "../../lib/bots-types";
import type { BotDesktopState } from "../../lib/bots-operations";
import type RFB from "@novnc/novnc";
import { botsClient as client } from "./client";
import { DesktopChannel } from "./desktop-channel";
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
    [error, setError] = useState("");
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
          setDesktop(value);
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
      {error && (
        <p className="bots-desktop-error" role="status">
          {error}
        </p>
      )}
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
    socket = useRef<WebSocket | null>(null);
  const [state, setState] = useState("Connecting…"),
    [error, setError] = useState(""),
    [exclusive, setExclusive] = useState(false),
    [changing, setChanging] = useState(false),
    [retry, setRetry] = useState(0),
    [text, setText] = useState(""),
    [showText, setShowText] = useState(false);
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
            "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),canvas",
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
      heartbeat: ReturnType<typeof setInterval> | undefined,
      renewal: ReturnType<typeof setInterval> | undefined,
      timeout: ReturnType<typeof setTimeout> | undefined,
      ws: WebSocket | undefined;
    const controller = new AbortController();
    const fail = (message: string) => {
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
      setExclusive(false);
      setChanging(false);
      try {
        const parentId = client.relayClientId;
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
            setExclusive(message.exclusive === true);
            setChanging(false);
            setError(message.error || "");
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
            if (!cancelled) {
              setState("Connected");
              setError("");
              clearTimeout(timeout);
              remote.focus({ preventScroll: true });
            }
          });
          remote.addEventListener("disconnect", () => {
            if (!cancelled) {
              setState("Disconnected");
              setExclusive(false);
              setChanging(false);
            }
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
                  if (ws?.readyState === WebSocket.OPEN)
                    ws.send(
                      JSON.stringify({
                        type: "auth",
                        role: "browser",
                        ticket: fresh.ticket,
                      }),
                    );
                } catch (e) {
                  if (!cancelled)
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
            if (ws?.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: "desktop", event: "ping" }));
          }, 10000);
        });
        ws.addEventListener("close", () => {
          if (!cancelled) {
            setState("Disconnected");
            setExclusive(false);
            setChanging(false);
            clearInterval(heartbeat);
            clearInterval(renewal);
          }
        });
        ws.addEventListener("error", () => fail("Desktop connection failed."));
      } catch (e) {
        if (!cancelled)
          fail(e instanceof Error ? e.message : "Desktop unavailable.");
      }
    })();
    // Owner sign-out, bot deletion and parent reconnect revoke this separate stream.
    const revocation = setInterval(() => {
      if (client.owner !== owner || !client.online)
        fail("DawarTodo disconnected. Reconnect to continue.");
    }, 1000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(heartbeat);
      clearInterval(renewal);
      clearInterval(revocation);
      clearTimeout(timeout);
      rfb.current?.disconnect();
      rfb.current = null;
      ws?.close();
      socket.current = null;
    };
  }, [bot.id, owner, retry]);
  const control = () => {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    setChanging(true);
    socket.current.send(
      JSON.stringify({
        type: "desktop",
        event: "control",
        exclusive: !exclusive,
      }),
    );
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
      className="bots-desktop-dialog"
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={`${bot.name} desktop control`}
    >
      <header>
        <div className="bots-desktop-heading">
          <Monitor size={20} />
          <strong>{bot.name}</strong>
          <span role="status">{state}</span>
        </div>
        <div className="bots-desktop-actions">
          <button
            disabled={state !== "Connected" || changing}
            onClick={control}
            title={
              exclusive
                ? "Let the agent use mouse and keyboard too"
                : "Pause agent mouse and keyboard input"
            }
          >
            {exclusive ? <LockKeyhole size={17} /> : <UsersRound size={17} />}
            <span>
              {exclusive
                ? "Release exclusive control"
                : "Take exclusive control"}
            </span>
          </button>
          <button
            disabled={state !== "Connected"}
            onClick={() => setShowText((v) => !v)}
            aria-label="Show desktop keyboard controls"
          >
            <Keyboard size={18} />
          </button>
          <button
            onClick={() => setRetry((v) => v + 1)}
            aria-label="Reconnect desktop"
          >
            <RefreshCw size={18} />
          </button>
          <button
            onClick={() => void stop()}
            disabled={Boolean(bot.activeTurnId)}
            aria-label="Stop desktop and close apps"
          >
            <Square size={17} />
          </button>
          <button onClick={onClose} aria-label="Close desktop dialog">
            <X size={22} />
          </button>
        </div>
      </header>
      <div className="bots-desktop-mode">
        {exclusive
          ? "You have exclusive mouse and keyboard control."
          : "Shared control · you and the agent can use this desktop together."}{" "}
        Closing this window leaves apps running.
      </div>
      {error && (
        <p className="bots-desktop-error" role="alert">
          {error}
        </p>
      )}
      <div className="bots-desktop-screen" ref={screen} />
      {showText && (
        <form
          className="bots-desktop-keyboard"
          onSubmit={(event) => {
            event.preventDefault();
            if (text) {
              rfb.current?.clipboardPasteFrom(text);
              rfb.current?.sendKey(0xffe3, "ControlLeft", true);
              rfb.current?.sendKey(0x76, "KeyV");
              rfb.current?.sendKey(0xffe3, "ControlLeft", false);
              setText("");
              rfb.current?.focus();
            }
          }}
        >
          <input
            aria-label="Text to paste into desktop"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Text to paste into focused app"
          />
          <button type="submit">Paste</button>
          {[
            ["Enter", 0xff0d],
            ["Tab", 0xff09],
            ["Escape", 0xff1b],
            ["Backspace", 0xff08],
          ].map(([label, key]) => (
            <button
              type="button"
              key={label}
              onClick={() => rfb.current?.sendKey(Number(key))}
            >
              {label}
            </button>
          ))}
          <button type="button" onClick={() => rfb.current?.sendCtrlAltDel()}>
            Ctrl Alt Del
          </button>
        </form>
      )}
    </div>,
    document.body,
  );
}
