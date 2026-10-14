"use client";
import { useId, useRef, useState } from "react";
import type { BotSchedule } from "../../lib/bots-types";
import { cronValidationError } from "../../lib/cron";
import { zonedDateTimeInputValue, zonedLocalDateTimeToUtc } from "../../lib/zoned-date-time";
import { ControlledDialog } from "@/components/ui/controlled-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";

function initialDate(schedule: BotSchedule | null, zone: string) {
  if (!schedule?.at) return "";
  try { return zonedDateTimeInputValue(new Date(schedule.at), zone); }
  catch { return ""; }
}

export function ScheduleEditor({ schedule, timeZone, online, close, save }: {
  schedule: BotSchedule | "new";
  timeZone: string;
  online: boolean;
  close: () => void;
  save: (value: Record<string, unknown>) => Promise<void>;
}) {
  const s = schedule === "new" ? null : schedule;
  const [zone, setZone] = useState(s?.timeZone ?? timeZone),
    [kind, setKind] = useState(s?.cron ? "custom" : "once"),
    [cron, setCron] = useState(s?.cron ?? "0 9 * * *"),
    [at, setAt] = useState(() => initialDate(s, s?.timeZone ?? timeZone)),
    [error, setError] = useState(""),
    [dateError, setDateError] = useState(""),
    [busy, setBusy] = useState(false);
  const inFlight = useRef(false), fieldId = useId();
  let zoneError = "";
  try {
    if (!zone.trim()) throw new Error();
    new Intl.DateTimeFormat(undefined, { timeZone: zone.trim() }).format();
  } catch { zoneError = "Enter a valid timezone, such as America/Toronto."; }
  const cronError = kind === "once" ? null : (!cron.trim() ? "Enter a cron expression." : cronValidationError(cron));
  return (
    <ControlledDialog title={s ? "Edit schedule" : "Schedule work"} onClose={close}>
      <form className="grid gap-4" aria-busy={busy} onSubmit={async (event) => {
        event.preventDefault();
        if (inFlight.current || !online) return;
        const form = event.currentTarget;
        if (zoneError || cronError) {
          form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
          return;
        }
        const data = new FormData(form);
        let instant: string | null = null;
        if (kind === "once") {
          try { instant = zonedLocalDateTimeToUtc(at, zone.trim()).toISOString(); }
          catch (cause) {
            setDateError(cause instanceof Error ? cause.message : "Choose a valid date and time.");
            form.querySelector<HTMLInputElement>('[name="at"]')?.focus();
            return;
          }
        }
        inFlight.current = true;
        setBusy(true);
        setError("");
        try {
          await save({
            ...(s ? { id: s.id } : {}),
            title: String(data.get("title")), prompt: String(data.get("prompt")),
            timeZone: zone.trim(), enabled: s?.enabled ?? true,
            cron: kind === "once" ? null : cron, at: instant,
          });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Schedule could not be saved.");
        } finally { inFlight.current = false; setBusy(false); }
      }}>
        <fieldset className="grid min-w-0 gap-4" disabled={busy}>
          <label className="grid gap-2 text-sm font-medium">Title
            <Input name="title" required defaultValue={s?.title} maxLength={160} />
          </label>
          <label className="grid gap-2 text-sm font-medium">What should the bot do?
            <Textarea name="prompt" required rows={4} defaultValue={s?.prompt} />
          </label>
          <label className="grid gap-2 text-sm font-medium">When
            <NativeSelect value={kind} onChange={(event) => {
              setKind(event.target.value); setDateError("");
              if (event.target.value === "hourly") setCron("0 * * * *");
              if (event.target.value === "daily") setCron("0 9 * * *");
              if (event.target.value === "weekdays") setCron("0 9 * * 1-5");
            }}>
              <option value="once">Once</option>
              <option value="hourly">Every hour</option>
              <option value="daily">Every day at 9 AM</option>
              <option value="weekdays">Weekdays at 9 AM</option>
              <option value="custom">Custom cron</option>
            </NativeSelect>
          </label>
          <label className="grid gap-2 text-sm font-medium">Timezone
            <Input required value={zone} spellCheck={false} aria-invalid={Boolean(zoneError) || undefined}
              aria-describedby={zoneError ? `${fieldId}-zone` : undefined}
              onChange={(event) => { setZone(event.target.value); setDateError(""); }} />
            {zoneError && <span className="text-sm font-normal text-destructive" id={`${fieldId}-zone`} role="alert">{zoneError}</span>}
          </label>
          {kind === "once" ? <label className="grid gap-2 text-sm font-medium">Date and time
            <Input name="at" type="datetime-local" required value={at}
              aria-invalid={Boolean(dateError) || undefined} aria-describedby={`${fieldId}-date-hint${dateError ? ` ${fieldId}-date-error` : ""}`}
              onChange={(event) => { setAt(event.target.value); setDateError(""); }} />
            <span className="text-sm font-normal text-muted-foreground" id={`${fieldId}-date-hint`}>In the timezone above.</span>
            {dateError && <span className="text-sm font-normal text-destructive" id={`${fieldId}-date-error`} role="alert">{dateError}</span>}
          </label> : kind === "custom" && <label className="grid gap-2 text-sm font-medium">Cron expression
            <Input required value={cron} spellCheck={false} aria-invalid={Boolean(cronError) || undefined}
              aria-describedby={`${fieldId}-cron-hint${cronError ? ` ${fieldId}-cron-error` : ""}`} onChange={(event) => setCron(event.target.value)} />
            <span className="text-sm font-normal text-muted-foreground" id={`${fieldId}-cron-hint`}>Minute · hour · day · month · weekday</span>
            {cronError && <span className="text-sm font-normal text-destructive" id={`${fieldId}-cron-error`} role="alert">{cronError}</span>}
          </label>}
        </fieldset>
        {s && !s.enabled && <p className="text-sm text-muted-foreground">This schedule will stay paused.</p>}
        {!online && <p className="text-sm text-muted-foreground" role="status">Reconnect to save this schedule.</p>}
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button variant="outline" type="button" onClick={close}>{busy ? "Close" : "Cancel"}</Button>
          <Button type="submit" disabled={busy || !online}>{busy ? "Saving…" : "Save schedule"}</Button>
        </div>
      </form>
    </ControlledDialog>
  );
}
