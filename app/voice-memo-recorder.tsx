"use client";
import { useEffect, useRef, useState } from "react";
import { ControlledDialog } from "@/components/ui/controlled-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ActionIcon } from "./action-icon";
import { formatDuration } from "./attachment-format";

export function VoiceMemoRecorder({ onClose, onAttach, returnFocus, maxBytes, maxDurationMs }: { maxBytes: number; maxDurationMs: number; returnFocus: HTMLElement | null; onClose: () => void; onAttach: (file: File, durationMs: number) => void }) {
  const [phase, setPhase] = useState<"idle" | "recording" | "review">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [recording, setRecording] = useState<{ file: File; url: string; durationMs: number } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const cancelledRef = useRef(false);
  const recordingUrlRef = useRef<string | null>(null);

  function releaseStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAtRef.current), 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => () => {
    cancelledRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
  }, []);

  async function start() {
    setError("");
    if (!("MediaRecorder" in window) || !navigator.mediaDevices?.getUserMedia) {
      setError("Voice recording is not supported by this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
      const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        if (cancelledRef.current) {
          releaseStream();
          return;
        }
        const durationMs = Math.max(1, Date.now() - startedAtRef.current);
        const recordedType = recorder.mimeType.split(";", 1)[0] || "audio/webm";
        const extension = recordedType === "audio/mp4" ? "m4a" : recordedType === "audio/ogg" ? "ogg" : "webm";
        const blob = new Blob(chunksRef.current, { type: recordedType });
        const file = new File([blob], `Voice memo ${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`, { type: recordedType });
        const url = URL.createObjectURL(file);
        recordingUrlRef.current = url;
        setRecording({ file, url, durationMs });
        setElapsed(durationMs);
        setPhase("review");
        releaseStream();
        console.info("[todo-ui] voice memo recorded", { bytes: file.size, mimeType: recordedType, durationMs });
      };
      recorder.start(1000);
      startedAtRef.current = Date.now();
      setElapsed(0);
      setPhase("recording");
      console.info("[todo-ui] voice recording started", { mimeType: recorder.mimeType });
    } catch (cause) {
      releaseStream();
      setError(cause instanceof DOMException && cause.name === "NotAllowedError" ? "Microphone access was not allowed." : "The microphone could not be started.");
      console.error("[todo-ui] voice recording start failed", cause);
    }
  }

  function stop() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  function rerecord() {
    if (recording) URL.revokeObjectURL(recording.url);
    recordingUrlRef.current = null;
    setRecording(null);
    setElapsed(0);
    setPhase("idle");
    void start();
  }

  const limitError = recording && (recording.file.size > maxBytes ? "Recording is too large to attach. Re-record a shorter memo." : recording.durationMs > maxDurationMs ? "Recording is too long to attach. Re-record a shorter memo." : "");
  return <VoiceMemoView phase={phase} elapsed={elapsed} error={error || limitError || ""} audioUrl={recording?.url} attachDisabled={!recording || recording.file.size > maxBytes || recording.durationMs > maxDurationMs} returnFocus={returnFocus} onClose={onClose} onStart={() => void start()} onStop={stop} onRerecord={rerecord} onAttach={() => { if (recording) onAttach(recording.file, recording.durationMs); }} />;
}

export function VoiceMemoView({ phase, elapsed, error, audioUrl, attachDisabled, returnFocus, onClose, onStart, onStop, onRerecord, onAttach }: {
  phase: "idle" | "recording" | "review"; elapsed: number; error: string; audioUrl?: string;
  attachDisabled: boolean; returnFocus: HTMLElement | null;
  onClose: () => void; onStart: () => void; onStop: () => void; onRerecord: () => void; onAttach: () => void;
}) {

  return (
    <ControlledDialog title="Voice memo" onClose={onClose} returnFocus={returnFocus} className="max-w-md" onKeyDown={(event) => event.stopPropagation()} onEscapeKeyDown={(event) => event.stopPropagation()}>
        <div className="my-7 text-center">
          <div className={cn("mx-auto mb-4 grid h-20 w-20 place-items-center rounded-full", phase === "recording" ? "motion-safe:animate-pulse bg-destructive/10 text-destructive" : "bg-accent text-primary")}>
            <ActionIcon name={phase === "recording" ? "stop" : "mic"} className="h-9 w-9" />
          </div>
          <p className="font-mono text-3xl font-semibold tabular-nums text-foreground">{formatDuration(elapsed)}</p>
          <p className="mt-2 text-sm text-muted-foreground">{phase === "idle" ? "Ready when you are" : phase === "recording" ? "Recording…" : "Review before attaching"}</p>
        </div>
        {audioUrl && <audio controls aria-label="Recorded voice memo" src={audioUrl} className="mb-5 w-full" preload="metadata" />}
        {error && <p role="alert" className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        {phase === "idle" ? (
          <Button type="button" onClick={onStart} className="h-12 w-full"><ActionIcon name="mic" />Start recording</Button>
        ) : phase === "recording" ? (
          <Button type="button" onClick={onStop} variant="destructive" className="h-12 w-full"><ActionIcon name="stop" />Finish recording</Button>
        ) : (
          <div className="flex gap-2">
            <Button type="button" onClick={onRerecord} variant="outline" className="h-12 flex-1">Re-record</Button>
            <Button type="button" onClick={onAttach} disabled={attachDisabled} className="h-12 flex-1"><ActionIcon name="attachment" />Attach</Button>
          </div>
        )}
    </ControlledDialog>
  );
}
