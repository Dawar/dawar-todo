"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BotAdminAction, BotAdminRequest } from "../../lib/bot-admin-types";
import { botsClient as client, BotRpcError } from "./client";
import { clearBotAdminAction, readBotAdminAction, saveBotAdminAction, type SavedBotAdminAction } from "./bot-admin-action";
import "./bot-admin.css";

export function ProvisioningAction({ action }: { action: BotAdminAction }) {
  if (action.kind === "createBot") return <><strong>Create {action.name}</strong><p>{action.purpose || "No purpose supplied"}</p></>;
  if (action.kind === "saveTeam") return <><strong>{action.id ? "Update" : "Create"} team: {action.name}</strong><p>Color {action.color}{action.id ? ` · ${action.id} · revision ${action.expectedRevision}` : ""}</p></>;
  return <><strong>Assign bot {action.botId}</strong><p>From {action.expectedTeamId || "Unassigned"} to {action.teamId || "Unassigned"}</p><small>Source revision {action.sourceTeamRevision ?? "—"} · destination revision {action.teamRevision ?? "—"}</small></>;
}
export function BotAdminApprovals({ owner, botId, botName, online }: { owner: string; botId: string; botName: string; online: boolean }) {
  const [saved] = useState(() => { try { return { pending: typeof window === "undefined" ? null : readBotAdminAction(owner, botId), error: "" }; } catch (e) { return { pending: null, error: (e as Error).message }; } });
  const [rows, setRows] = useState<BotAdminRequest[]>([]), [error, setError] = useState(saved.error), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(Boolean(saved.error));
  const [pending, setPending] = useState<SavedBotAdminAction | null>(saved.pending), [confirmed, setConfirmed] = useState<string[]>([]);
  const active = useRef(false), epoch = useRef(0), fetching = useRef<Promise<void> | null>(null);
  const valid = useCallback(() => active.current && client.owner === owner, [owner]);
  const refresh = useCallback(() => {
    if (!online || !valid()) return Promise.resolve();
    if (fetching.current) return fetching.current;
    const generation = epoch.current;
    const task = client.rpc<{ requests: BotAdminRequest[] }>("botAdmin.list", botId, {}).then(result => {
      if (valid() && generation === epoch.current) {
        setRows(result.requests.filter(r => r.botId === botId));
        // Fresh revisions require a fresh unchecked owner confirmation.
        setConfirmed([]);
      }
    }).catch(e => { if (valid() && generation === epoch.current) setError(e instanceof Error ? e.message : "Could not load provisioning requests."); });
    fetching.current = task;
    void task.finally(() => { if (fetching.current === task) fetching.current = null; });
    return task;
  }, [botId, online, valid]);
  useEffect(() => {
    active.current = true; epoch.current++;
    void refresh();
    const event = (e: { type: string; botId?: string }) => { if (e.type === "bot.admin" && e.botId === botId) void refresh(); };
    client.events.add(event);
    return () => { active.current = false; client.events.delete(event); };
  }, [owner, botId, refresh]);
  const submit = async (action: SavedBotAdminAction) => {
    if (busy || !online || !valid()) return;
    const generation = epoch.current, current = () => valid() && generation === epoch.current;
    setBusy(true); setError("");
    try {
      const result = await client.rpc<{ request: BotAdminRequest }>("botAdmin.control", botId, action.params, action.operationId);
      if (result.request.id !== action.params.id || result.request.botId !== botId || result.request.specHash !== action.params.specHash) throw Error("The decision acknowledgement is incomplete. Check the same decision.");
      clearBotAdminAction(action); // scoped journal, even if this view was closed
      if (current()) { setPending(null); await refresh(); }
    } catch (e) {
      if (e instanceof BotRpcError && e.outcome === "rejected") {
        try { clearBotAdminAction(action); if (current()) setPending(null); } catch { /* Preserve the original storage record. */ }
      }
      if (current()) setError(e instanceof Error ? e.message : "Decision unconfirmed. Check the same decision.");
    } finally { if (current()) setBusy(false); }
  };
  const decide = (row: BotAdminRequest, decision: "approve" | "revoke") => {
    if (pending || busy || blocked || !valid() || !online || decision === "approve" && !confirmed.includes(`${row.id}:${row.revision}`)) return;
    const a: SavedBotAdminAction = { owner, botId, operationId: crypto.randomUUID(), params: { id: row.id, expectedRevision: row.revision, specHash: row.specHash, decision } };
    try { saveBotAdminAction(a); setPending(a); void submit(a); } catch (e) { setBlocked(true); setError((e as Error).message); }
  };
  return <section className="bots-admin-approvals" aria-label="Bot and team setup approvals"><header><h3>Bot and team setup</h3><button disabled={!online || busy} onClick={() => void refresh()}>Refresh</button></header>
    <p>{botName} can request bot creation. Team changes require a configured lead. Approval covers only the actions below for one hour. It does not start them automatically.</p>
    {error && <p role="alert">{error}</p>}
    {pending && <p role="status">A decision is awaiting confirmation. <button disabled={!online || busy || blocked} onClick={() => void submit(pending)}>Check the same decision</button></p>}
    {!rows.length && <p>No provisioning requests.</p>}
    {rows.map(row => <article key={row.id}><h4>{row.createCount ? `${row.createCount} new ${row.createCount === 1 ? "bot" : "bots"}` : "Team setup"} · {row.actionCount} {row.actionCount === 1 ? "action" : "actions"}</h4>
      <small>Caller: {row.botId} · Execution: {row.executionOperationId}</small>
      <ol>{row.actions.map((a, i) => <li key={i}><ProvisioningAction action={a} /></li>)}</ol>
      {row.creationDefaults && <p>New bots: {row.creationDefaults.model} · {row.creationDefaults.effort} · Fast {row.creationDefaults.serviceTier === "priority" ? "on" : "off"} · burst {row.creationDefaults.burstQuietSeconds}s</p>}
      <p role="status">{row.state}{row.approval && ` · expires ${new Date(row.approval.expiresAt).toLocaleString()}`}</p>
      {row.error && <p>{row.error}</p>}
      {!!row.steps.length && <p>{row.steps.filter(s => s.state === "complete").length} of {row.actionCount} confirmed. Unknown steps keep their original identities.</p>}
      {row.state === "pending" && row.allowedCaller && <><label><input type="checkbox" checked={confirmed.includes(`${row.id}:${row.revision}`)} disabled={!online || busy || Boolean(pending) || blocked} onChange={e => setConfirmed(prev => e.target.checked ? [...prev, `${row.id}:${row.revision}`] : prev.filter(id => id !== `${row.id}:${row.revision}`))} />I approve these exact actions by {botName}.</label><button disabled={!online || busy || Boolean(pending) || blocked || !confirmed.includes(`${row.id}:${row.revision}`)} onClick={() => decide(row, "approve")}>Approve for one hour</button></>}
      {row.approval && !row.approval.revokedAt && row.state !== "complete" && <><button disabled={!online || busy || Boolean(pending) || blocked} onClick={() => decide(row, "revoke")}>Revoke unused approval</button><small>Revocation blocks new actions. It cannot undo an action already started.</small></>}
    </article>)}
  </section>;
}
