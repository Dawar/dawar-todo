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
    minute: Number(values.minute),
    hour: Number(values.hour),
    dayOfMonth: Number(values.day),
    month: Number(values.month),
    dayOfWeek: weekdays[values.weekday],
  };
}

export function cronMatchesDate(expression: string, date: Date, timeZone: string) {
  const parsed = parseCronExpression(expression);
  const current = cronDateParts(date, timeZone);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed.fields;
  if (!minute.values.has(current.minute) || !hour.values.has(current.hour) || !month.values.has(current.month)) return false;

  const dayOfMonthMatches = dayOfMonth.values.has(current.dayOfMonth);
  const dayOfWeekMatches = dayOfWeek.values.has(current.dayOfWeek);
  if (!dayOfMonth.wildcard && !dayOfWeek.wildcard) return dayOfMonthMatches || dayOfWeekMatches;
  return dayOfMonthMatches && dayOfWeekMatches;
}
