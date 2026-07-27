const DAY_MS = 24 * 60 * 60 * 1000;

type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

function zonedCalendarDate(date: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
  };
}

function calendarDayNumber(date: CalendarDate) {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / DAY_MS);
}

function isInCurrentWeek(wake: Date, now: Date, timeZone: string) {
  const currentDay = calendarDayNumber(zonedCalendarDate(now, timeZone));
  const wakeDay = calendarDayNumber(zonedCalendarDate(wake, timeZone));
  const currentWeekday = new Date(currentDay * DAY_MS).getUTCDay();
  const currentWeekStart = currentDay - currentWeekday;
  return wakeDay >= currentWeekStart && wakeDay < currentWeekStart + 7;
}

export function snoozeLabel(
  value: string,
  now = Date.now(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale?: string,
) {
  const wake = new Date(value);
  if (Number.isNaN(wake.valueOf())) return "Snoozed";

  try {
    const current = new Date(now);
    const weekday = new Intl.DateTimeFormat(locale, {
      timeZone,
      weekday: "short",
    }).format(wake);
    const time = new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(wake);
    if (isInCurrentWeek(wake, current, timeZone)) return `Wakes ${weekday} ${time}`;

    const currentCalendarDate = zonedCalendarDate(current, timeZone);
    const wakeCalendarDate = zonedCalendarDate(wake, timeZone);
    const date = new Intl.DateTimeFormat(locale, {
      timeZone,
      month: "short",
      day: "numeric",
      ...(wakeCalendarDate.year !== currentCalendarDate.year ? { year: "numeric" as const } : {}),
    }).format(wake);
    return `Wakes ${weekday}, ${date} at ${time}`;
  } catch {
    return "Snoozed";
  }
}
