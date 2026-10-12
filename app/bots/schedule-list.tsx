"use client";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CalendarClock, ChevronDown, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { Bot, BotSchedule } from "../../lib/bots-types";
import { botsClient as client } from "./client";
import "./schedule-list.css";
import { Button } from "@/components/ui/button";

function nextTime(schedule: BotSchedule) {
  if (!schedule.enabled) return "Paused";
  const next = schedule.nextRunAt && Date.parse(schedule.nextRunAt);
  if (next && Number.isFinite(next)) {
    try { return `Next ${new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: schedule.timeZone }).format(next)}`; }
    catch { return "Next time unavailable"; }
  }
  return !schedule.cron && schedule.at && Date.parse(schedule.at) < Date.now() ? "Scheduled time passed" : "No next time scheduled";
}
export function ScheduleList({ bot, schedules, online, busy, onEdit, action }: {
  bot: Bot; schedules: BotSchedule[]; online: boolean; busy: boolean;
  onEdit: (schedule: BotSchedule | "new") => void; action: (fn: () => Promise<unknown>) => Promise<unknown>;
}) {
  const owner = client.owner;
  const [deleting, setDeleting] = useState<{ schedule: BotSchedule; owner: string; botId: string } | null>(null);
  const confirmation = deleting?.owner === owner && deleting.botId === bot.id ? deleting : null;
  if (deleting && !confirmation) setDeleting(null);
  return <section className="bots-schedule-list" aria-label="Schedules">
    <div className="flex items-center justify-between gap-3"><h3 className="text-base font-semibold">Schedules</h3><Button variant="ghost" size="icon" type="button" aria-label="Add schedule" disabled={!online || busy || bot.archived} onClick={() => onEdit("new")}><Plus size={19} /></Button></div>
    <p className="mb-4 text-sm text-muted-foreground">Manage recurring and one-time work.</p>
    {!online && <p className="mb-4 text-sm text-muted-foreground">Saved schedules. Reconnect to make changes.</p>}
    {!schedules.length && <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"><CalendarClock size={27} strokeWidth={1.5} /><h3>No schedules yet</h3><p>Ask {bot.name} to schedule a check, or add one here.</p></div>}
    {schedules.map(schedule => <details key={schedule.id} className="bots-schedule-row">
      <summary><span><strong>{schedule.title}</strong><small>{nextTime(schedule)}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
      <div className="bots-schedule-row-body"><p>{schedule.timeZone}</p><div className="bots-schedule-row-actions">
        <Button variant="outline" type="button" disabled={!online || busy || bot.archived} onClick={() => void action(() => client.rpc("schedules.run", bot.id, { id: schedule.id }))}><Play size={15} />Run now</Button>
        <Button variant="outline" type="button" disabled={!online || busy} onClick={() => onEdit(schedule)}><Pencil size={15} />Edit</Button>
        <Button variant="outline" type="button" disabled={!online || busy || bot.archived} onClick={() => void action(() => client.rpc("schedules.save", bot.id, { id: schedule.id, enabled: !schedule.enabled }))}>{schedule.enabled ? <Pause size={15} /> : <Play size={15} />}{schedule.enabled ? "Pause" : "Resume"}</Button>
        <Button variant="ghost" className="text-destructive" type="button" disabled={!online || busy} onClick={() => setDeleting({ schedule, owner, botId: bot.id })}><Trash2 size={15} />Delete</Button>
      </div></div>
    </details>)}
    {confirmation && <ConfirmDialog title="Delete schedule?" description={`“${confirmation.schedule.title}” will no longer run automatically. Previous conversations are kept.`} confirmLabel="Delete schedule" destructive confirmDisabled={!online || busy} onCancel={() => setDeleting(null)} onConfirm={() => {
      if (!online || busy || client.owner !== confirmation.owner || bot.id !== confirmation.botId) return;
      setDeleting(null);
      void action(() => client.rpc("schedules.delete", confirmation.botId, { id: confirmation.schedule.id }));
    }} />}
  </section>;
}
