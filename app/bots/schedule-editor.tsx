"use client";
import { useState } from "react";
import type { BotSchedule } from "../../lib/bots-types";
import { zonedDateTimeInputValue, zonedLocalDateTimeToUtc } from "../../lib/zoned-date-time";
import { ControlledDialog } from "@/components/ui/controlled-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";

export function ScheduleEditor({
  schedule,
  timeZone,
  close,
  save,
}: {
  schedule: BotSchedule | "new";
  timeZone: string;
  close: () => void;
  save: (value: Record<string, unknown>) => Promise<void>;
}) {
  const s = schedule === "new" ? null : schedule;
  const [zone, setZone] = useState(s?.timeZone ?? timeZone),
    [kind, setKind] = useState(s?.cron ? "custom" : "once"),
    [cron, setCron] = useState(s?.cron ?? "0 9 * * *"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <ControlledDialog title={s ? "Edit schedule" : "Schedule work"} onClose={close}>
      <form
        className="grid gap-4" aria-busy={busy}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const data = new FormData(e.currentTarget);
          try {
            await save({
              ...(s ? { id: s.id } : {}),
              title: String(data.get("title")),
              prompt: String(data.get("prompt")),
              timeZone: zone,
              enabled: true,
              cron: kind === "once" ? null : cron,
              at:
                kind === "once"
                  ? zonedLocalDateTimeToUtc(
                      String(data.get("at")),
                      zone,
                    ).toISOString()
                  : null,
            });
          } catch (e) {
            setError(
              e instanceof Error ? e.message : "Schedule could not be saved.",
            );
            setBusy(false);
          }
        }}
      >
        
        <label className="grid gap-2 text-sm font-medium">
          Title
          <Input
            name="title"
            required
            defaultValue={s?.title}
            maxLength={160}
          />
        </label>
        <label className="grid gap-2 text-sm font-medium">
          What should the bot do?
          <Textarea name="prompt" required rows={4} defaultValue={s?.prompt} />
        </label>
        <label className="grid gap-2 text-sm font-medium">
          When
          <NativeSelect
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              if (e.target.value === "hourly") setCron("0 * * * *");
              if (e.target.value === "daily") setCron("0 9 * * *");
              if (e.target.value === "weekdays") setCron("0 9 * * 1-5");
            }}
          >
            <option value="once">Once</option>
            <option value="hourly">Every hour</option>
            <option value="daily">Every day at 9 AM</option>
            <option value="weekdays">Weekdays at 9 AM</option>
            <option value="custom">Custom cron</option>
          </NativeSelect>
        </label>
        <label className="grid gap-2 text-sm font-medium">
          Timezone
          <Input
            required
            value={zone}
            onChange={(e) => setZone(e.target.value)}
          />
        </label>
        {kind === "once" ? (
          <label className="grid gap-2 text-sm font-medium">
            Date and time
            <Input
              name="at"
              type="datetime-local"
              required
              defaultValue={
                s?.at ? zonedDateTimeInputValue(new Date(s.at), zone) : ""
              }
            />
          </label>
        ) : (
          kind === "custom" && (
            <label className="grid gap-2 text-sm font-medium">
              Cron expression
              <Input
                required
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="minute hour day month weekday"
              />
            </label>
          )
        )}
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button variant="outline" type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save schedule"}
          </Button>
        </div>
      </form>
    </ControlledDialog>
  );
}
