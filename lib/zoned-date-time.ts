type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function partsFor(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
  };
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function zonedDateTimeInputValue(date: Date, timeZone: string) {
  const parts = partsFor(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function zonedLocalDateTimeToUtc(value: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error("Choose a valid date and time.");
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const [year, month, day, hour, minute] = [yearText, monthText, dayText, hourText, minuteText].map(Number);
  const calendarCheck = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    calendarCheck.getUTCFullYear() !== year
    || calendarCheck.getUTCMonth() + 1 !== month
    || calendarCheck.getUTCDate() !== day
    || calendarCheck.getUTCHours() !== hour
    || calendarCheck.getUTCMinutes() !== minute
  ) throw new Error("Choose a valid date and time.");

  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetAt = (timestamp: number) => {
    const current = partsFor(new Date(timestamp), timeZone);
    return Date.UTC(current.year, current.month - 1, current.day, current.hour, current.minute, 0) - timestamp;
  };
  let result = target - offsetAt(target);
  result = target - offsetAt(result);
  const resolved = new Date(result);
  const resolvedParts = partsFor(resolved, timeZone);
  if (
    resolvedParts.year !== year
    || resolvedParts.month !== month
    || resolvedParts.day !== day
    || resolvedParts.hour !== hour
    || resolvedParts.minute !== minute
  ) throw new Error("That local time does not exist because of a daylight-saving change. Choose another time.");
  return resolved;
}
