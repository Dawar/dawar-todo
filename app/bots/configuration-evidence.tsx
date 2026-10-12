"use client";

import type { ExecutionSettings, TurnConfiguration } from "../../lib/bot-execution-configuration";

export function settingsText(settings: ExecutionSettings | null | undefined) {
  if (!settings) return "Unknown configuration";
  const mode = settings.mode === "plan" ? "Plan" : settings.mode === "default" ? "Automatic" : "Unknown mode";
  const tier = settings.serviceTier === "priority" || settings.serviceTier === "fast"
    ? "Fast on" : settings.serviceTier === "default" ? "Fast off" : "Unknown Fast setting";
  return `${settings.model || "Unknown model"} · ${settings.effort || "Unknown effort"} · ${mode} · ${tier}`;
}

export function ConfigurationEvidence({ value, label = "Turn configuration" }: {
  value: TurnConfiguration | null | undefined;
  label?: string;
}) {
  const captured = value?.capturedAt ? new Date(value.capturedAt) : null;
  const capturedLabel = captured && Number.isFinite(captured.getTime()) ? captured.toLocaleString() : null;
  return <details className="bots-config-evidence">
    <summary>{label}: {settingsText(value?.requested)}{value?.requested && " · Requested"}</summary>
    <p>{value?.confirmation === "accepted-request"
      ? "Requested settings accepted. Actual runtime settings are not reported."
      : value?.requested ? "Requested settings; runtime confirmation is unavailable."
        : "No settings were recorded for this turn."}</p>
    {value && <small>Source: {value.source}{capturedLabel && ` · Captured ${capturedLabel}`}</small>}
  </details>;
}
