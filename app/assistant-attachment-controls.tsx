"use client";

import { useEffect, useRef, useState } from "react";
import { ActionIcon } from "./action-icon";

export function AssistantAttachmentMenu({
  disabled,
  onFiles,
  onRecord,
  onNeedsTask,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
  onRecord: () => void;
  onNeedsTask?: () => boolean;
}) {
  const [open, setOpen] = useState(false);
  const mediaRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  function choose(action: () => void) {
    if (onNeedsTask?.()) {
      setOpen(false);
      return;
    }
    action();
  }
  function selected(input: HTMLInputElement) {
    const files = [...(input.files ?? [])];
    input.value = "";
    setOpen(false);
    if (files.length) onFiles(files);
  }
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className="grid h-10 w-10 place-items-center rounded-xl text-[#216e4e] transition hover:bg-[#eaf3ed] disabled:opacity-40"
        aria-label="Add attachment"
        aria-expanded={open}
      >
        <ActionIcon name="attachment" className="h-5 w-5" />
      </button>
      {open && (
        <>
          <button type="button" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} aria-label="Close attachment menu" />
          <div className="absolute bottom-12 left-0 z-50 w-60 rounded-2xl border border-black/[0.08] bg-white p-1.5 shadow-xl">
            <button type="button" onClick={() => choose(() => mediaRef.current?.click())} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-semibold hover:bg-[#f2f5f2]"><ActionIcon name="image" />Photos or videos</button>
            <button type="button" onClick={() => choose(() => fileRef.current?.click())} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-semibold hover:bg-[#f2f5f2]"><ActionIcon name="file" />Files</button>
            <button type="button" onClick={() => choose(() => { setOpen(false); onRecord(); })} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-semibold hover:bg-[#f2f5f2]"><ActionIcon name="mic" />Record voice memo</button>
          </div>
        </>
      )}
      <input ref={mediaRef} type="file" accept="image/*,video/*" multiple className="sr-only" onChange={(event) => selected(event.currentTarget)} />
      <input ref={fileRef} type="file" multiple className="sr-only" onChange={(event) => selected(event.currentTarget)} />
    </div>
  );
}

export function AssistantVoiceRecorder({
  onClose,
  onRecorded,
}: {
  onClose: () => void;
  onRecorded: (file: File, durationMs: number) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "recording">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAtRef.current), 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => () => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  async function start() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const durationMs = Math.max(1, Date.now() - startedAtRef.current);
        const mimeType = recorder.mimeType.split(";", 1)[0] || "audio/webm";
        const extension = mimeType === "audio/mp4" ? "m4a" : "webm";
        const file = new File(chunksRef.current, `Voice memo ${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`, { type: mimeType });
        stream.getTracks().forEach((track) => track.stop());
        console.info("[todo-talk-ui] voice memo recorded", { bytes: file.size, durationMs, mimeType });
        onRecorded(file, durationMs);
      };
      startedAtRef.current = Date.now();
      recorder.start(250);
      setPhase("recording");
    } catch (cause) {
      console.error("[todo-talk-ui] voice recorder start failed", cause);
      setError("Microphone access could not be started.");
    }
  }

  function stop() {
    recorderRef.current?.stop();
    setPhase("idle");
  }

  const seconds = Math.round(elapsed / 1000);
  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-label="Record voice memo">
      <button type="button" className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-label="Close voice recorder" />
      <div className="relative w-full rounded-t-3xl bg-white p-6 shadow-2xl sm:max-w-sm sm:rounded-3xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Voice memo</h2>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full bg-[#f1f2f0]" aria-label="Close"><ActionIcon name="close" /></button>
        </div>
        <div className="py-9 text-center">
          <div className={`mx-auto mb-4 grid h-20 w-20 place-items-center rounded-full ${phase === "recording" ? "animate-pulse bg-red-100 text-red-700" : "bg-[#eaf3ed] text-[#216e4e]"}`}>
            <ActionIcon name={phase === "recording" ? "stop" : "mic"} className="h-9 w-9" />
          </div>
          <p className="font-mono text-3xl font-semibold tabular-nums">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</p>
          <p className="mt-2 text-sm text-[#7b837e]">{phase === "recording" ? "Recording…" : "Ready when you are"}</p>
        </div>
        {error && <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <button
          type="button"
          onClick={phase === "recording" ? stop : () => void start()}
          className={`inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-white ${phase === "recording" ? "bg-red-700" : "bg-[#216e4e]"}`}
        >
          <ActionIcon name={phase === "recording" ? "stop" : "mic"} />
          {phase === "recording" ? "Finish recording" : "Start recording"}
        </button>
      </div>
    </div>
  );
}
