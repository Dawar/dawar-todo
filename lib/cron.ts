const FIELD_NAMES = ["minute", "hour", "day of month", "month", "day of week"] as const;
const FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

type ParsedField = {
  wildcard: boolean;
  values: Set<number>;
};

type ParsedCron = {
  fields: [ParsedField, ParsedField, ParsedField, ParsedField, ParsedField];
  normalized: string;
};

function parseNumber(value: string, fieldIndex: number) {
  if (!/^\d+$/.test(value)) throw new Error(`The ${FIELD_NAMES[fieldIndex]} field must use numbers.`);
  const parsed = Number(value);
  const [minimum, maximum] = FIELD_RANGES[fieldIndex];
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`The ${FIELD_NAMES[fieldIndex]} field must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseField(source: string, fieldIndex: number): ParsedField {
  const values = new Set<number>();
  const [minimum, maximum] = FIELD_RANGES[fieldIndex];
  const wildcard = source === "*";

  for (const segment of source.split(",")) {
    if (!segment) throw new Error(`The ${FIELD_NAMES[fieldIndex]} field contains an empty list item.`);
    const slashParts = segment.split("/");
    if (slashParts.length > 2) throw new Error(`The ${FIELD_NAMES[fieldIndex]} field has an invalid step.`);
    const base = slashParts[0];
    const step = slashParts[1] === undefined ? 1 : Number(slashParts[1]);
    if (!Number.isInteger(step) || step < 1) throw new Error(`The ${FIELD_NAMES[fieldIndex]} step must be a positive number.`);

    let start: number;
    let end: number;
    if (base === "*") {
      start = minimum;
      end = maximum;
    } else if (base.includes("-")) {
      const rangeParts = base.split("-");
      if (rangeParts.length !== 2) throw new Error(`The ${FIELD_NAMES[fieldIndex]} field has an invalid range.`);
      start = parseNumber(rangeParts[0], fieldIndex);
      end = parseNumber(rangeParts[1], fieldIndex);
      if (start > end) throw new Error(`The ${FIELD_NAMES[fieldIndex]} range must be ascending.`);
    } else {
      start = parseNumber(base, fieldIndex);
      end = slashParts[1] === undefined ? start : maximum;
    }

    for (let value = start; value <= end; value += step) {
      values.add(fieldIndex === 4 && value === 7 ? 0 : value);
    }
  }

  return { wildcard, values };
}

export function parseCronExpression(expression: string): ParsedCron {
  const normalized = expression.trim().replace(/\s+/g, " ");
  const parts = normalized.split(" ");
  if (parts.length !== 5) throw new Error("Use a five-field cron expression: minute hour day month weekday.");
  return {
    fields: parts.map(parseField) as ParsedCron["fields"],
    normalized,
  };
}

export function normalizeCronExpression(expression: string | null | undefined) {
  const value = expression?.trim() ?? "";
  return value ? parseCronExpression(value).normalized : null;
}

export function cronValidationError(expression: string | null | undefined) {
  try {
    normalizeCronExpression(expression);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "That cron expression is invalid.";
  }
}

function cronDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(values.year),
    minute: Number(values.minute),
    hour: Number(values.hour),
    dayOfMonth: Number(values.day),
    month: Number(values.month),
    dayOfWeek: weekdays[values.weekday],
  };
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetAt = (timestamp: number) => {
    const current = cronDateParts(new Date(timestamp), timeZone);
    return Date.UTC(current.year, current.month - 1, current.dayOfMonth, current.hour, current.minute, 0) - timestamp;
  };
  let result = target - offsetAt(target);
  result = target - offsetAt(result);
  return new Date(result);
}

function cronDayMatches(parsed: ParsedCron, month: number, dayOfMonth: number, dayOfWeek: number) {
  const [, , cronDayOfMonth, cronMonth, cronDayOfWeek] = parsed.fields;
  if (!cronMonth.values.has(month)) return false;
  const dayOfMonthMatches = cronDayOfMonth.values.has(dayOfMonth);
  const dayOfWeekMatches = cronDayOfWeek.values.has(dayOfWeek);
  if (!cronDayOfMonth.wildcard && !cronDayOfWeek.wildcard) return dayOfMonthMatches || dayOfWeekMatches;
  return dayOfMonthMatches && dayOfWeekMatches;
}

export function cronMatchesDate(expression: string, date: Date, timeZone: string) {
  const parsed = parseCronExpression(expression);
  const current = cronDateParts(date, timeZone);
  const [minute, hour, , month] = parsed.fields;
  if (!minute.values.has(current.minute) || !hour.values.has(current.hour) || !month.values.has(current.month)) return false;

  return cronDayMatches(parsed, current.month, current.dayOfMonth, current.dayOfWeek);
}

export function latestCronOccurrence(
  expression: string,
  at: Date,
  timeZone: string,
  after?: Date | null,
) {
  const parsed = parseCronExpression(expression);
  const atMinute = new Date(Math.floor(at.valueOf() / 60_000) * 60_000);
  const current = cronDateParts(atMinute, timeZone);
  const hours = [...parsed.fields[1].values].sort((a, b) => b - a);
  const minutes = [...parsed.fields[0].values].sort((a, b) => b - a);
  const afterValue = after?.valueOf() ?? atMinute.valueOf() - 5 * 366 * 24 * 60 * 60 * 1000;
  const afterLocal = cronDateParts(new Date(afterValue), timeZone);
  const earliestCalendarDay = Date.UTC(afterLocal.year, afterLocal.month - 1, afterLocal.dayOfMonth);
  let calendarDay = Date.UTC(current.year, current.month - 1, current.dayOfMonth);

  // Calendar-day iteration avoids an expensive minute-by-minute catch-up scan
  // while still handling local timezone and daylight-saving transitions.
  for (let daysChecked = 0; daysChecked <= 5 * 366 && calendarDay >= earliestCalendarDay; daysChecked += 1) {
    const calendar = new Date(calendarDay);
    const year = calendar.getUTCFullYear();
    const month = calendar.getUTCMonth() + 1;
    const dayOfMonth = calendar.getUTCDate();
    const dayOfWeek = calendar.getUTCDay();
    if (cronDayMatches(parsed, month, dayOfMonth, dayOfWeek)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const candidate = zonedDateTimeToUtc(year, month, dayOfMonth, hour, minute, timeZone);
          const candidateParts = cronDateParts(candidate, timeZone);
          const isExactLocalTime = candidateParts.year === year
            && candidateParts.month === month
            && candidateParts.dayOfMonth === dayOfMonth
            && candidateParts.hour === hour
            && candidateParts.minute === minute;
          if (isExactLocalTime && candidate.valueOf() <= atMinute.valueOf() && candidate.valueOf() > afterValue) {
            return candidate;
          }
        }
      }
    }
    calendarDay -= 24 * 60 * 60 * 1000;
  }
  return null;
}

export function nextCronOccurrence(expression: string, after: Date, timeZone: string) {
  const parsed = parseCronExpression(expression);
  const current = cronDateParts(after, timeZone);
  const hours = [...parsed.fields[1].values].sort((a, b) => a - b);
  const minutes = [...parsed.fields[0].values].sort((a, b) => a - b);
  let calendarDay = Date.UTC(current.year, current.month - 1, current.dayOfMonth);

  // Search calendar days in the user's timezone so DST changes do not shift
  // the displayed recurrence time. Five years covers the parser's full
  // practical scheduling horizon while keeping malformed edge cases bounded.
  for (let daysChecked = 0; daysChecked <= 5 * 366; daysChecked += 1) {
    const calendar = new Date(calendarDay);
    const year = calendar.getUTCFullYear();
    const month = calendar.getUTCMonth() + 1;
    const dayOfMonth = calendar.getUTCDate();
    const dayOfWeek = calendar.getUTCDay();
    if (cronDayMatches(parsed, month, dayOfMonth, dayOfWeek)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const candidate = zonedDateTimeToUtc(year, month, dayOfMonth, hour, minute, timeZone);
          const candidateParts = cronDateParts(candidate, timeZone);
          const isExactLocalTime = candidateParts.year === year
            && candidateParts.month === month
            && candidateParts.dayOfMonth === dayOfMonth
            && candidateParts.hour === hour
            && candidateParts.minute === minute;
          if (isExactLocalTime && candidate.valueOf() > after.valueOf()) return candidate;
        }
      }
    }
    calendarDay += 24 * 60 * 60 * 1000;
  }
  return null;
}
