"use client";

import { FormEvent, useEffect, useState } from "react";
import { SiteHeader } from "../site-header";

type Settings = {
  snoozeTimeZone: string;
  snoozeWakeHour: number;
};

const timeZones = [
  ["America/Toronto", "Eastern · Toronto"],
  ["America/New_York", "Eastern · New York"],
  ["America/Chicago", "Central"],
  ["America/Denver", "Mountain"],
  ["America/Los_Angeles", "Pacific"],
  ["Europe/London", "London"],
  ["UTC", "UTC"],
];

function hourLabel(hour: number) {
  if (hour === 0) return "12:00 AM";
  if (hour < 12) return `${hour}:00 AM`;
  if (hour === 12) return "12:00 PM";
  return `${hour - 12}:00 PM`;
}

async function request<T>(options?: RequestInit): Promise<T> {
  const response = await fetch("/api/settings", {
    ...options,
    headers: options?.body ? { "Content-Type": "application/json", ...(options.headers ?? {}) } : options?.headers,
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Something went wrong.");
  return payload;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({ snoozeTimeZone: "America/Toronto", snoozeWakeHour: 8 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    request<{ settings: Settings }>()
      .then(({ settings: loaded }) => {
        setSettings(loaded);
        console.info("[todo-ui] settings loaded", loaded);
      })
      .catch((error: Error) => setMessage(error.message))
      .finally(() => setLoading(false));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setMessage("");
    try {
      const { settings: persisted } = await request<{ settings: Settings }>({
        method: "PATCH",
        body: JSON.stringify(settings),
      });
      setSettings(persisted);
      setSaved(true);
      console.info("[todo-ui] settings saved", persisted);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f6f7f5] text-[#1d211f]">
      <SiteHeader current="settings" />
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-7">
          <p className="text-sm font-medium text-[#216e4e]">Profile</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] text-[#151816]">Daily review</h1>
          <p className="mt-2 text-sm leading-6 text-[#69716c]">Choose when snoozed tasks return to your open list.</p>
        </div>

        <form onSubmit={save} className="rounded-2xl border border-black/[0.07] bg-white p-5 shadow-[0_10px_35px_rgba(30,45,36,0.06)] sm:p-7">
          <fieldset disabled={loading || saving} className="space-y-5 disabled:opacity-60">
            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-[#303632]">Time zone</span>
              <select
                value={settings.snoozeTimeZone}
                onChange={(event) => { setSettings((current) => ({ ...current, snoozeTimeZone: event.target.value })); setSaved(false); }}
                className="h-12 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm outline-none transition focus:border-[#216e4e]/60 focus:ring-3 focus:ring-[#216e4e]/10"
              >
                {timeZones.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-[#303632]">Wake-up time</span>
              <select
                value={settings.snoozeWakeHour}
                onChange={(event) => { setSettings((current) => ({ ...current, snoozeWakeHour: Number(event.target.value) })); setSaved(false); }}
                className="h-12 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm outline-none transition focus:border-[#216e4e]/60 focus:ring-3 focus:ring-[#216e4e]/10"
              >
                {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
              </select>
            </label>
          </fieldset>

          <div className="mt-6 rounded-xl bg-[#f1f6f3] px-4 py-3 text-sm leading-6 text-[#4f6257]">
            Snoozing hides a task until {hourLabel(settings.snoozeWakeHour)} on the next calendar day in {timeZones.find(([zone]) => zone === settings.snoozeTimeZone)?.[1] ?? settings.snoozeTimeZone}.
          </div>

          {message && <p role="alert" className="mt-4 text-sm text-red-700">{message}</p>}

          <div className="mt-6 flex items-center gap-3">
            <button type="submit" disabled={loading || saving} className="rounded-xl bg-[#216e4e] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#195d41] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e] disabled:opacity-50">
              {saving ? "Saving…" : "Save settings"}
            </button>
            {saved && <span role="status" className="text-sm font-medium text-[#216e4e]">Saved</span>}
          </div>
        </form>
      </div>
    </main>
  );
}
