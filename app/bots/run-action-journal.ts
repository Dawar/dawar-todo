/** Critical scoped actions. Operation identity is immutable; only its outcome changes. */
export type RunActionMethod = "runs.interrupt" | "runs.resume" | "requests.respond" | "turn.interrupt" | "runs.decide" | "work.resume" | "peers.cancel" | "bursts.start" | "bursts.resume" | "bursts.stop" | "bursts.discard";
export type RunActionIntent = { id: string; method: RunActionMethod; params: Record<string, unknown> };
type Operation = RunActionIntent & { scope: string; state: "pending" | "accepted" | "rejected"; error?: string };
type Scope = { key: string; pending: string[]; revision: number; last?: string };
export type ActionSelection = { revision: number; current: Operation | null; last: Operation | null; selected?: Operation };
const methods = new Set(["runs.interrupt", "runs.resume", "requests.respond", "turn.interrupt", "runs.decide", "work.resume", "peers.cancel", "bursts.start", "bursts.resume", "bursts.stop", "bursts.discard"]);
let connection: Promise<IDBDatabase> | undefined;
function open() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("dawar-run-actions-v2", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("scopes", { keyPath: "key" });
      request.result.createObjectStore("operations", { keyPath: ["scope", "id"] });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error("Action storage is blocked. Close older app tabs and retry."));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      db.onclose = () => { connection = undefined; };
      resolve(db);
    };
  }).catch(error => { connection = undefined; throw error; });
  return connection;
}
function legacy(key: string): RunActionIntent | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw) as RunActionIntent;
  if (!value || typeof value.id !== "string" || !value.id || !methods.has(value.method) || !value.params || typeof value.params !== "object" || Array.isArray(value.params)) throw Error("The older saved action could not be read. Its original record is retained.");
  return value;
}
const same = (a: RunActionIntent, b: RunActionIntent) => a.method === b.method && JSON.stringify(a.params) === JSON.stringify(b.params);
type Command = { kind: "read" } | { kind: "admit"; intent: RunActionIntent } | { kind: "exact"; id: string } | { kind: "settle"; id: string; state: Operation["state"]; error?: string };

/** One strict transaction imports, selects/adopts, and settles exact IDs across tabs. */
export async function runActionJournal(key: string, command: Command): Promise<ActionSelection> {
  const old = legacy(key), db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["scopes", "operations"], "readwrite", { durability: "strict" });
    const scopes = tx.objectStore("scopes"), operations = tx.objectStore("operations");
    let result: ActionSelection, failure: unknown;
    const fail = (error: unknown) => { failure = error; tx.abort(); };
    const guarded = (fn: () => void) => () => { try { fn(); } catch (error) { fail(error); } };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure ?? tx.error ?? Error("The action journal could not be saved. Nothing new was dispatched."));
    tx.onerror = () => {};
    const request = scopes.get(key);
    request.onsuccess = guarded(() => {
      const scope: Scope = request.result ?? { key, pending: [], revision: 0 };
      const read = (id: string | undefined, done: (value: Operation | undefined) => void) => {
        if (!id) { done(undefined); return; }
        const item = operations.get([key, id]); item.onsuccess = guarded(() => done(item.result));
      };
      const finish = (selected?: Operation) => {
        read(scope.pending[0], current => read(scope.last, last => {
          if (scope.pending.length && !current) { fail(Error("A saved action record is unavailable. Keep its recovery identity and retry.")); return; }
          scopes.put(scope); result = { revision: scope.revision, current: current ?? null, last: last ?? null, selected };
        }));
      };
      const apply = () => {
        if (command.kind === "read") { finish(); return; }
        if (command.kind === "exact" || command.kind === "settle") {
          read(command.id, operation => {
            if (!operation) { fail(Error("The exact saved action is unavailable. No replacement action was submitted.")); return; }
            if (command.kind === "settle" && operation.state === "pending") {
              operation = { ...operation, state: command.state, error: command.error };
              operations.put(operation); scope.revision++;
              if (command.state !== "pending") {
                // Delayed settlement of X cannot delete/select over pending Y.
                scope.pending = scope.pending.filter(id => id !== command.id);
                scope.last = command.id;
              }
            }
            finish(operation);
          });
          return;
        }
        read(scope.pending[0], pending => read(scope.last, last => {
          if (scope.pending.length && !pending) { fail(Error("A pending action record is unavailable. Retry recovery.")); return; }
          if (pending) {
            if (!same(pending, command.intent)) { fail(Error("Confirm the earlier saved action first. Its original answer and destination are retained.")); return; }
            finish(pending); return;
          }
          // A stale answer card cannot create a second answer after the exact ACK.
          if (last?.state === "accepted" && command.intent.method === "requests.respond") { finish(last); return; }
          const operation: Operation = { ...command.intent, scope: key, state: "pending" };
          operations.add(operation); scope.pending.push(operation.id); scope.revision++; finish(operation);
        }));
      };
      if (!old) { apply(); return; }
      read(old.id, existing => {
        if (existing && !same(existing, old)) { fail(Error("An older action changed under its saved ID. Both stores are retained for recovery.")); return; }
        if (!existing) {
          operations.add({ ...old, scope: key, state: "pending" } satisfies Operation);
          scope.pending.push(old.id); scope.revision++;
        }
        // Never delete the legacy key. Existing terminal IDs act as migration
        // tombstones, so a retained legacy record cannot resurrect an old effect.
        apply();
      });
    });
  });
}
