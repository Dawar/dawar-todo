const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function localDateOnly(value: string) {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText) - 1;
  const day = Number(dayText);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

function calendarDayNumber(date: Date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

export function dueDateSortValue(value: string | null) {
  if (!value) return Number.POSITIVE_INFINITY;
  return localDateOnly(value)?.valueOf() ?? Number.POSITIVE_INFINITY;
}

export function isDueTodayOrOverdue(value: string | null, now = new Date()) {
  if (!value) return false;
  const due = localDateOnly(value);
  return due ? calendarDayNumber(due) <= calendarDayNumber(now) : false;
}

export function formatDueDate(value: string, now = new Date(), locale?: string | string[]) {
  const due = localDateOnly(value);
  if (!due) return value;
  const difference = calendarDayNumber(due) - calendarDayNumber(now);
  if (difference < 0) {
    return `Overdue · ${new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(due)}`;
  }
  if (difference === 0) return "Due today";
  if (difference === 1) return "Due tomorrow";
  return `Due ${new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(due)}`;
}
