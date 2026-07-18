import { getTodoSettings, updateTodoSettings } from "../../../db/todos";

export async function GET() {
  const startedAt = Date.now();
  try {
    const settings = await getTodoSettings();
    console.info("[todo-api] settings loaded", { ...settings, durationMs: Date.now() - startedAt });
    return Response.json({ settings });
  } catch (error) {
    console.error("[todo-api] settings load failed", error);
    return Response.json({ error: "Your daily review settings could not be loaded." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = (await request.json()) as {
      snoozeTimeZone?: string;
      snoozeWakeHour?: number;
    };
    const snoozeTimeZone = String(payload.snoozeTimeZone ?? "");
    const snoozeWakeHour = Number(payload.snoozeWakeHour);
    try {
      new Intl.DateTimeFormat("en", { timeZone: snoozeTimeZone }).format();
    } catch {
      return Response.json({ error: "Choose a valid time zone." }, { status: 400 });
    }
    if (!Number.isInteger(snoozeWakeHour) || snoozeWakeHour < 0 || snoozeWakeHour > 23) {
      return Response.json({ error: "Choose a wake-up hour between 12 AM and 11 PM." }, { status: 400 });
    }
    const settings = await updateTodoSettings({ snoozeTimeZone, snoozeWakeHour });
    console.info("[todo-api] settings saved", settings);
    return Response.json({ settings });
  } catch (error) {
    console.error("[todo-api] settings save failed", error);
    return Response.json({ error: "Your daily review settings could not be saved." }, { status: 500 });
  }
}
