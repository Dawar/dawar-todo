/** Copy and Forward deliberately share exactly the same text, with no task ID,
 * status, assignment, attachment download or hidden instruction appended. */
export const todoCopyText = (title: string, notes: string) => [title.trim(), notes.trim()].filter(Boolean).join("\n\n");

export type TodoForwardIntent = { id: string; text: string; owner: string; botId: string; state: "prepared" | "appended" };
const prefix = "dawar-todo-forward:v1:";
const key = (owner: string, id: string) => `${prefix}${JSON.stringify([owner, id])}`;
export function saveTodoForward(intent: TodoForwardIntent) {
  const previous = localStorage.getItem(key(intent.owner, intent.id));
  if (previous) {
    const saved = JSON.parse(previous) as TodoForwardIntent;
    if (saved.id !== intent.id || saved.owner !== intent.owner || saved.botId !== intent.botId || saved.text !== intent.text)
      throw Error("This saved forward has a different destination. Reopen the original forward.");
  }
  localStorage.setItem(key(intent.owner, intent.id), JSON.stringify(intent));
}
export function pendingTodoForwards(owner: string): TodoForwardIntent[] {
  if (!owner) return [];
  const values: TodoForwardIntent[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i);
    if (!name?.startsWith(prefix)) continue;
    let value: TodoForwardIntent;
    try { value = JSON.parse(localStorage.getItem(name)!); } catch { continue; }
    if (value && value.owner === owner && typeof value.id === "string" && typeof value.text === "string" && typeof value.botId === "string" && ["prepared", "appended"].includes(value.state)) values.push(value);
  }
  return values;
}
export function finishTodoForward(owner: string, botId: string) {
  // Called only once the intended conversation has actually opened. Draft
  // tombstones remain; an old dialog can never append this identity again.
  for (const intent of pendingTodoForwards(owner)) if (intent.botId === botId && intent.state === "appended") localStorage.removeItem(key(owner, intent.id));
}
