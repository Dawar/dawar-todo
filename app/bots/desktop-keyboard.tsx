"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type RFB from "@novnc/novnc";

const anchor = "\u00a0".repeat(32);
const modifiers = {
  Ctrl: [0xffe3, "ControlLeft"],
  Alt: [0xffe9, "AltLeft"],
  Shift: [0xffe1, "ShiftLeft"],
} as const;
type Modifier = keyof typeof modifiers;
const keys: Record<string, [number, string]> = {
  Enter: [0xff0d, "Enter"], Tab: [0xff09, "Tab"], Escape: [0xff1b, "Escape"],
  Backspace: [0xff08, "Backspace"], Delete: [0xffff, "Delete"],
  ArrowLeft: [0xff51, "ArrowLeft"], ArrowUp: [0xff52, "ArrowUp"],
  ArrowRight: [0xff53, "ArrowRight"], ArrowDown: [0xff54, "ArrowDown"],
  Home: [0xff50, "Home"], End: [0xff57, "End"],
};

// Diff Unicode points, not UTF-16 units. The inert prefix lets a mobile IME
// report backspace even when no local text remains. Nothing is persisted.
export function desktopTextEdit(before: string, after: string) {
  const a = Array.from(before), b = Array.from(after);
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { erase: a.length - start - end, text: b.slice(start, b.length - end).join("") };
}

export function DesktopKeyboard({ remote, connected, onClose }: {
  remote: () => RFB | null; connected: boolean; onClose: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const previous = useRef(anchor), composing = useRef(false), mounted = useRef(true);
  const connectedRef = useRef(connected);
  useLayoutEffect(() => { connectedRef.current = connected; }, [connected]);
  const [selected, setSelected] = useState<Modifier[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [manualPaste, setManualPaste] = useState(false);
  const [moreKeys, setMoreKeys] = useState(false);
  const [message, setMessage] = useState("");
  const [reading, setReading] = useState(false);
  // Focus synchronously from the opening gesture in the parent. Mount autofocus
  // is only a fallback; iOS requires focus inside the original user gesture.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const reset = () => {
    previous.current = anchor;
    if (input.current) {
      input.current.value = anchor;
      input.current.setSelectionRange(anchor.length, anchor.length);
    }
  };
  const chord = (key: number, code?: string, mods = selected) => {
    const r = remote();
    if (!connectedRef.current || !r) return;
    try {
      for (const m of mods) { const [sym, code] = modifiers[m]; r.sendKey(sym, code, true); }
      r.sendKey(key, code);
    } finally {
      for (const m of [...mods].reverse()) { const [sym, code] = modifiers[m]; r.sendKey(sym, code, false); }
      setSelected([]);
    }
  };
  const type = (value: string, firstMods = selected) => {
    let mods = firstMods;
    for (const char of value.replace(/\r\n?/g, "\n")) {
      const cp = char.codePointAt(0)!;
      if (char === "\n") chord(...keys.Enter, mods);
      else if (char === "\t") chord(...keys.Tab, mods);
      else chord(cp <= 0xff ? cp : 0x01000000 | cp, undefined, mods);
      mods = [];
    }
  };
  const edit = (element: HTMLTextAreaElement) => {
    if (composing.current) return;
    const change = desktopTextEdit(previous.current, element.value);
    for (let i = 0; i < change.erase; i++) chord(...keys.Backspace, i === 0 ? selected : []);
    type(change.text, change.erase ? [] : selected);
    reset();
  };
  const paste = (value: string) => {
    const r = remote();
    if (!connectedRef.current || !r || !value) return;
    // Order on the same RFB channel: update remote clipboard, then Ctrl+V.
    // Never read/write the device clipboard without this user action.
    if (new TextEncoder().encode(value).length > 64 * 1024) {
      setManualPaste(true);
      setMessage("This paste is too large. Paste text in smaller sections (up to 64 KB).");
      return;
    }
    r.clipboardPasteFrom(value);
    chord(0x76, "KeyV", ["Ctrl"]);
    setPasteText("");
    setMessage("Paste sent to the focused remote app.");
    reset();
  };
  const readClipboard = async () => {
    const target = remote();
    setReading(true);
    try {
      if (!navigator.clipboard?.readText) throw new Error("unavailable");
      const value = await navigator.clipboard.readText();
      if (!mounted.current || target !== remote() || !connectedRef.current) return;
      if (!value) { setMessage("Clipboard has no text."); return; }
      paste(value);
    } catch {
      if (!mounted.current) return;
      setManualPaste(true);
      setMessage("Paste into the field below, then tap Paste to desktop.");
    } finally { if (mounted.current) setReading(false); }
  };
  return <section className="bots-desktop-keyboard" aria-label="Remote keyboard">
    <div className="bots-desktop-key-row" aria-label="Remote shortcuts"
      onPointerDown={(e) => { if ((e.target as HTMLElement).closest("button,summary")) e.preventDefault(); }}>
      <button type="button" disabled={!connected || reading} onClick={() => void readClipboard()}>Paste clipboard</button>
      {Object.keys(modifiers).map((m) => <button type="button" key={m} disabled={!connected}
        aria-pressed={selected.includes(m as Modifier)} title={`${m} for the next key`}
        onClick={() => setSelected((s) => s.includes(m as Modifier) ? s.filter((v) => v !== m) : [...s, m as Modifier])}>{m}</button>)}
      {[["Tab", "Tab"], ["Esc", "Escape"], ["←", "ArrowLeft"], ["↑", "ArrowUp"], ["↓", "ArrowDown"], ["→", "ArrowRight"], ["⌫", "Backspace"], ["Enter", "Enter"]].map(([label, key]) =>
        <button type="button" key={key} aria-label={key} disabled={!connected} onClick={() => chord(...keys[key])}>{label}</button>)}
      <button type="button" aria-expanded={moreKeys} onClick={() => setMoreKeys((v) => !v)}>More keys</button>
      <button type="button" onClick={onClose}>Hide</button>
    </div>
    {moreKeys && <div className="bots-desktop-key-more"
      onPointerDown={(e) => { if ((e.target as HTMLElement).closest("button")) e.preventDefault(); }}>
        {[["Select all", 0x61, "KeyA"], ["Copy", 0x63, "KeyC"], ["Undo", 0x7a, "KeyZ"]].map(([label, key, code]) =>
          <button type="button" key={label} disabled={!connected} onClick={() => chord(Number(key), String(code), ["Ctrl"])}>{label}</button>)}
        <button type="button" disabled={!connected} onClick={() => chord(...keys.Tab, ["Alt"])}>Switch app</button>
        <button type="button" disabled={!connected} onClick={() => { remote()?.sendCtrlAltDel(); setSelected([]); }}>Ctrl Alt Del</button>
        <button type="button" onClick={() => setManualPaste((v) => !v)}>Paste text…</button>
      </div>}
    <label className="bots-desktop-type-target">
      <span>{connected ? "Tap to type directly into the remote app" : "Reconnect to type"}</span>
      <textarea ref={input} data-desktop-typing="true" defaultValue={anchor} disabled={!connected}
        aria-label="Type directly into remote desktop" rows={1} inputMode="text" enterKeyHint="enter"
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        onFocus={reset} onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(e) => { composing.current = false; edit(e.currentTarget); }}
        onInput={(e) => edit(e.currentTarget)}
        onPaste={(e) => { e.preventDefault(); paste(e.clipboardData.getData("text/plain")); }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          // Native paste events own Cmd/Ctrl+V; printable/IME/deletion input
          // owns text. Special keys do not alter the local inert prefix.
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
          const physicalMods: Modifier[] = [];
          if (e.ctrlKey || e.metaKey) physicalMods.push("Ctrl");
          if (e.altKey) physicalMods.push("Alt");
          if (e.shiftKey) physicalMods.push("Shift");
          if (keys[e.key] && (e.key !== "Backspace" && e.key !== "Enter" || e.ctrlKey || e.metaKey || e.altKey)) {
            e.preventDefault(); chord(...keys[e.key], physicalMods.length ? physicalMods : selected);
          } else if ((e.ctrlKey || e.metaKey || e.altKey) && Array.from(e.key).length === 1) {
            e.preventDefault(); chord(e.key.toLowerCase().codePointAt(0)!, e.code, physicalMods);
          }
        }} />
    </label>
    {manualPaste && <form className="bots-desktop-paste" onSubmit={(e) => { e.preventDefault(); paste(pasteText); }}>
      <textarea aria-label="Text to paste into remote desktop" rows={2} value={pasteText}
        onChange={(e) => setPasteText(e.target.value)} placeholder="Paste text here" autoComplete="off" spellCheck={false} />
      <button type="submit" disabled={!connected || !pasteText}>Paste to desktop</button>
    </form>}
    {message && <p className="bots-desktop-key-message" role="status">{message}</p>}
  </section>;
}
