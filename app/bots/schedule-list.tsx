"use client";
import { CalendarClock, ChevronDown, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { Bot, BotSchedule } from "../../lib/bots-types";
import { botsClient as client } from "./client";
import "./schedule-list.css";

function nextTime(schedule: BotSchedule) {
  if (!schedule.enabled) return "Paused";
  const next = schedule.nextRunAt && Date.parse(schedule.nextRunAt);
  if (next && Number.isFinite(next)) return `Next ${new Date(next).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  return !schedule.cron && schedule.at && Date.parse(schedule.at) < Date.now() ? "Completed" : "No next time scheduled";
}
export function ScheduleList({ bot, schedules, online, busy, onEdit, action }: {
  bot: Bot; schedules: BotSchedule[]; online: boolean; busy: boolean;
  onEdit: (schedule: BotSchedule | "new") => void; action: (fn: () => Promise<unknown>) => Promise<unknown>;
}) {
  return <section className="bots-schedule-list" aria-label="Schedules">
    <div className="bots-details-section-heading"><h3>Schedules</h3><button className="bots-icon-button" aria-label="Add schedule" disabled={!online || bot.archived} onClick={() => onEdit("new")}><Plus size={19} /></button></div>
    <p className="bots-details-lead">Regular work, on your terms. Choose a schedule to see its timing and controls.</p>
    {!online && <p className="bots-system-note">Saved schedules. Reconnect to make changes.</p>}
    {!schedules.length && <div className="bots-details-empty"><CalendarClock size={27} strokeWidth={1.5} /><h3>Make room for the routine</h3><p>Ask {bot.name} to schedule a check, or add one here.</p></div>}
    {schedules.map(schedule => <details key={schedule.id} className="bots-schedule-row">
      <summary><span><strong>{schedule.title}</strong><small>{nextTime(schedule)}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
      <div className="bots-schedule-row-body"><p>{schedule.timeZone}</p><div className="bots-schedule-row-actions">
        <button disabled={!online || busy || bot.archived} onClick={() => void action(() => client.rpc("schedules.run", bot.id, { id: schedule.id }))}><Play size={15} />Run now</button>
        <button disabled={!online} onClick={() => onEdit(schedule)}><Pencil size={15} />Edit</button>
        <button disabled={!online || busy || bot.archived} onClick={() => void action(() => client.rpc("schedules.save", bot.id, { id: schedule.id, enabled: !schedule.enabled }))}>{schedule.enabled ? <Pause size={15} /> : <Play size={15} />}{schedule.enabled ? "Pause" : "Resume"}</button>
        <button disabled={!online || busy} onClick={() => { if (window.confirm(`Delete “${schedule.title}”?`)) void action(() => client.rpc("schedules.delete", bot.id, { id: schedule.id })); }}><Trash2 size={15} />Delete</button>
      </div></div>
    </details>)}
  </section>;
}
