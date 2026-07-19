import type { CalendarTodo } from "./calendar-feeds";

function escapeText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function calendarDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { compact: `${match[1]}${match[2]}${match[3]}`, date };
}

function nextCalendarDate(date: Date) {
  const next = new Date(date.valueOf());
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.getUTCFullYear()}${String(next.getUTCMonth() + 1).padStart(2, "0")}${String(next.getUTCDate()).padStart(2, "0")}`;
}

function utcTimestamp(value: string) {
  const parsed = new Date(value);
  const date = Number.isNaN(parsed.valueOf()) ? new Date(0) : parsed;
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function foldLine(line: string) {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of line) {
    const characterBytes = encoder.encode(character).length;
    if (bytes + characterBytes > 75 && current) {
      lines.push(current);
      current = ` ${character}`;
      bytes = 1 + characterBytes;
    } else {
      current += character;
      bytes += characterBytes;
    }
  }
  lines.push(current);
  return lines.join("\r\n");
}

function eventLines(todo: CalendarTodo, host: string) {
  const due = calendarDate(todo.dueDate);
  if (!due) return [];
  const description = [
    todo.notes.trim(),
    todo.project ? `Project: ${todo.project}` : "",
    todo.context ? `Context: ${todo.context}` : "",
    `Status: ${todo.status === "completed" ? "Completed" : "Open"}`,
  ].filter(Boolean).join("\n\n");
  const priority = todo.priority === 1 ? 1 : todo.priority === 2 ? 3 : todo.priority === 4 ? 9 : 5;
  return [
    "BEGIN:VEVENT",
    `UID:todo-${todo.id}@${host}`,
    `DTSTAMP:${utcTimestamp(todo.updatedAt)}`,
    `CREATED:${utcTimestamp(todo.createdAt)}`,
    `LAST-MODIFIED:${utcTimestamp(todo.updatedAt)}`,
    `DTSTART;VALUE=DATE:${due.compact}`,
    `DTEND;VALUE=DATE:${nextCalendarDate(due.date)}`,
    `SUMMARY:${escapeText(todo.title)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `PRIORITY:${priority}`,
    `TRANSP:TRANSPARENT`,
    `X-DAWAR-TODO-STATUS:${todo.status.toUpperCase()}`,
    ...(todo.project ? [`CATEGORIES:${escapeText(todo.project)}`] : []),
    "END:VEVENT",
  ];
}

export function renderTaskCalendar(name: string, todos: CalendarTodo[], host: string) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Dawar Todo//Task Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`,
    ...todos.flatMap((todo) => eventLines(todo, host)),
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
