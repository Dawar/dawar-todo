"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  FolderOpen,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import type { Bot, BotTeam, BotTeamDetail } from "../../lib/bots-types";
import { botsClient as client } from "./client";
import { useTeamAction } from "./use-team-action";
import "./teams.css";
const refresh = async () => {
  await client.refresh();
};
type Action = ReturnType<typeof useTeamAction>;
function ChangeState({ action }: { action: Action }) {
  return (
    <>
      {action.error && (
        <div className="bots-teams-error" role="alert">
          {action.error}
        </div>
      )}
      {action.pending && (
        <div className="bots-teams-error">
          A team change is awaiting confirmation.
          <button
            disabled={action.busy || !client.online}
            onClick={action.retry}
          >
            Check the same change
          </button>
        </div>
      )}
      {action.blocked && !action.pending && (
        <button className="bots-team-text-button" onClick={action.recover}>
          Read saved changes
        </button>
      )}
    </>
  );
}
export function TeamAssignment({
  owner,
  bot,
  teams,
  online,
  onManage,
}: {
  owner: string;
  bot: Bot;
  teams: BotTeam[];
  online: boolean;
  onManage: () => void;
}) {
  const action = useTeamAction(owner, refresh);
  return (
    <div className="bots-team-assignment">
      <label>
        Team
        <select
          value={bot.teamId ?? ""}
          disabled={!online || action.busy || action.blocked}
          onChange={(event) =>
            void action.run("teams.assign", {
              botId: bot.id,
              teamId: event.target.value || null,
              expectedTeamId: bot.teamId ?? null,
            })
          }
        >
          <option value="">Unassigned</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <button className="bots-team-text-button" onClick={onManage}>
        <UsersRound size={15} />
        Manage teams
      </button>
      <ChangeState action={action} />
    </div>
  );
}
export function TeamsManager({
  owner,
  teams,
  bots,
  online,
  onClose,
}: {
  owner: string;
  teams: BotTeam[];
  bots: Bot[];
  online: boolean;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null),
    [creating, setCreating] = useState(false);
  const action = useTeamAction(owner, refresh),
    ref = useRef<HTMLElement>(null),
    dirty = useRef(false);
  const close = useCallback(() => {
    if (dirty.current && !window.confirm("Discard unsaved team changes?"))
      return;
    onClose();
  }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null,
      root = ref.current;
    root?.querySelector<HTMLElement>("button")?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      if (event.key !== "Tab" || !root) return;
      const items = [
        ...root.querySelectorAll<HTMLElement>(
          "button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]",
        ),
      ].filter((n) => n.getClientRects().length);
      const first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      previous?.focus();
    };
  }, [close]);
  const back = () => {
    if (dirty.current && !window.confirm("Discard unsaved team changes?"))
      return;
    dirty.current = false;
    setSelected(null);
    setCreating(false);
  };
  const reorder = (index: number, offset: number) => {
    const ids = teams.map((t) => t.id);
    [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
    void action.run("teams.reorder", {
      ids,
      revisions: teams.map((t) => ({ id: t.id, revision: t.revision })),
    });
  };
  return (
    <div className="bots-modal-backdrop bots-teams-backdrop" onClick={close}>
      <section
        className="bots-teams-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Teams"
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div className="bots-teams-symbol">
            <UsersRound size={24} />
          </div>
          <div>
            <h2>Teams</h2>
            <p>A place for bots to belong.</p>
          </div>
          <button
            className="bots-icon-button"
            aria-label="Close teams"
            onClick={close}
          >
            <X size={20} />
          </button>
        </header>
        <div className="bots-teams-body">
          <ChangeState action={action} />
          {selected || creating ? (
            <>
              <button className="bots-team-text-button" onClick={back}>
                <ArrowLeft size={16} />
                All teams
              </button>
              <TeamEditor
                key={selected ?? "new"}
                owner={owner}
                id={selected}
                bots={bots}
                teams={teams}
                online={online}
                action={action}
                onDirty={(value) => {
                  dirty.current = value;
                }}
                onCreated={() => {
                  dirty.current = false;
                  setCreating(false);
                  setSelected(null);
                }}
              />
            </>
          ) : (
            <>
              <div className="bots-teams-intro">
                <div>
                  <h3>Better together</h3>
                  <p>
                    Organize your bots. Give each team shared memory and a
                    folder for their work.
                  </p>
                </div>
                <button
                  className="bots-primary"
                  disabled={!online || action.busy || action.blocked}
                  onClick={() => setCreating(true)}
                >
                  <Plus size={16} />
                  New team
                </button>
              </div>
              <div className="bots-teams-grid">
                {teams.map((team, index) => (
                  <article className="bots-team-card" key={team.id}>
                    <button
                      className="bots-team-open"
                      onClick={() => setSelected(team.id)}
                    >
                      <span
                        className="bots-team-emblem"
                        style={{
                          color: team.color,
                          background: `${team.color}14`,
                        }}
                      >
                        <UsersRound size={25} />
                      </span>
                      <strong>{team.name}</strong>
                      <span>
                        {team.memberCount}{" "}
                        {team.memberCount === 1 ? "bot" : "bots"}
                      </span>
                      <small>
                        Shared memory & workspace
                        <ArrowUp size={13} className="bots-team-arrow" />
                      </small>
                    </button>
                    <div className="bots-team-order">
                      <span>Team order</span>
                      <button
                        title="Move team up"
                        aria-label={`Move ${team.name} up`}
                        disabled={
                          !online ||
                          action.busy ||
                          action.blocked ||
                          index === 0
                        }
                        onClick={() => reorder(index, -1)}
                      >
                        <ArrowUp size={15} />
                      </button>
                      <button
                        title="Move team down"
                        aria-label={`Move ${team.name} down`}
                        disabled={
                          !online ||
                          action.busy ||
                          action.blocked ||
                          index === teams.length - 1
                        }
                        onClick={() => reorder(index, 1)}
                      >
                        <ArrowDown size={15} />
                      </button>
                    </div>
                  </article>
                ))}
                {!teams.length && (
                  <div className="bots-teams-empty">
                    <UsersRound size={38} strokeWidth={1.3} />
                    <h3>Your first team</h3>
                    <p>
                      Try Development, Operations, or Personal. You can move
                      bots between teams whenever you like.
                    </p>
                  </div>
                )}
              </div>
              <p className="bots-teams-footnote">
                Bots keep their own conversations, settings, and personal
                memory.
              </p>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
function TeamEditor({
  owner,
  id,
  bots,
  teams,
  online,
  action,
  onDirty,
  onCreated,
}: {
  owner: string;
  id: string | null;
  bots: Bot[];
  teams: BotTeam[];
  online: boolean;
  action: Action;
  onDirty: (dirty: boolean) => void;
  onCreated: () => void;
}) {
  const [detail, setDetail] = useState<BotTeamDetail | null>(null),
    [name, setName] = useState(""),
    [color, setColor] = useState("#287a57"),
    [memory, setMemory] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(Boolean(id && online)),
    [copied, setCopied] = useState(false),
    [assignBot, setAssignBot] = useState("");
  const generation = useRef(0),
    active = useRef(true);
  const dirty = detail
    ? name !== detail.name || color !== detail.color || memory !== detail.memory
    : Boolean(name);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  const load = useCallback(async () => {
    if (!id || !client.online || client.owner !== owner) return;
    const request = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const value = await client.rpc<BotTeamDetail>("teams.read", undefined, {
        id,
      });
      if (
        !active.current ||
        client.owner !== owner ||
        request !== generation.current
      )
        return;
      setDetail(value);
      setName(value.name);
      setColor(value.color);
      setMemory(value.memory);
    } catch (reason) {
      if (active.current && request === generation.current)
        setError(
          reason instanceof Error ? reason.message : "Team could not load.",
        );
    } finally {
      if (active.current && request === generation.current) setLoading(false);
    }
  }, [id, owner]);
  useEffect(() => {
    active.current = true;
    const counter = generation;
    queueMicrotask(() => {
      if (active.current) void load();
    });
    return () => {
      active.current = false;
      counter.current++;
    };
  }, [load]);
  const locked = !online || action.busy || action.blocked || loading;
  const mutate = async (
    method: Parameters<Action["run"]>[0],
    params: Record<string, unknown>,
  ) => {
    if (await action.run(method, params)) {
      if (!active.current || client.owner !== owner) return;
      if (id) await load();
      else onCreated();
    }
  };
  const members = bots
    .filter((b) => b.teamId === id && id)
    .sort(
      (a, b) =>
        (a.teamOrder ?? 0) - (b.teamOrder ?? 0) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
  const current = teams.find((t) => t.id === id);
  const order = (index: number, offset: number) => {
    if (!detail) return;
    const ids = members.map((b) => b.id);
    [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
    void mutate("teams.orderBots", {
      id,
      ids,
      expectedRevision: current?.revision ?? detail.revision,
    });
  };
  const changing = (
    method: Parameters<Action["run"]>[0],
    params: Record<string, unknown>,
  ) => {
    if (dirty) {
      setError("Save your edits before changing team members or order.");
      return;
    }
    void mutate(method, params);
  };
  return (
    <div className="bots-team-editor">
      {id && !detail && !loading && (
        <button
          className="bots-team-text-button"
          disabled={!online || action.busy}
          onClick={() => void load()}
        >
          <RefreshCw size={15} />
          Load team
        </button>
      )}
      {error && (
        <div role="alert" className="bots-teams-error">
          {error}
        </div>
      )}
      {loading && <p className="bots-teams-footnote">Loading team…</p>}
      <form
        className="bots-team-identity"
        onSubmit={(event) => {
          event.preventDefault();
          if (id && memory !== detail?.memory) {
            setError("Save shared memory before changing the team name.");
            return;
          }
          void mutate("teams.save", {
            ...(id ? { id, expectedRevision: detail?.revision } : {}),
            name,
            color,
          });
        }}
      >
        <label>
          Team name
          <input
            autoFocus={!id}
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={locked}
          />
        </label>
        <label className="bots-team-color">
          Color
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            disabled={locked}
          />
        </label>
        <button
          className="bots-primary"
          type="submit"
          disabled={locked || !name.trim() || Boolean(id && !detail)}
        >
          <Save size={16} />
          {id ? "Save team" : "Create team"}
        </button>
      </form>
      {detail && (
        <>
          <section className="bots-team-section">
            <h3>
              <UsersRound size={18} />
              Members<span>{members.length}</span>
            </h3>
            <p>Use “Team order” in the bot list to follow this order.</p>
            <div className="bots-team-members">
              {members.map((bot, index) => (
                <div className="bots-team-member" key={bot.id}>
                  <span>
                    <strong>{bot.name}</strong>
                    {bot.archived && <small>Archived</small>}
                  </span>
                  <button
                    aria-label={`Move ${bot.name} up`}
                    disabled={locked || dirty || index === 0}
                    onClick={() => order(index, -1)}
                  >
                    <ArrowUp size={16} />
                  </button>
                  <button
                    aria-label={`Move ${bot.name} down`}
                    disabled={locked || dirty || index === members.length - 1}
                    onClick={() => order(index, 1)}
                  >
                    <ArrowDown size={16} />
                  </button>
                  <button
                    aria-label={`Remove ${bot.name} from team`}
                    title="Unassign bot"
                    disabled={locked || dirty}
                    onClick={() =>
                      changing("teams.assign", {
                        botId: bot.id,
                        teamId: null,
                        expectedTeamId: id,
                      })
                    }
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
            <form
              className="bots-team-add"
              onSubmit={(e) => {
                e.preventDefault();
                const bot = bots.find((b) => b.id === assignBot);
                if (bot)
                  changing("teams.assign", {
                    botId: bot.id,
                    teamId: id,
                    expectedTeamId: bot.teamId ?? null,
                  });
              }}
            >
              <select
                aria-label="Bot to add to team"
                value={assignBot}
                disabled={locked || dirty}
                onChange={(e) => setAssignBot(e.target.value)}
              >
                <option value="">Add a bot…</option>
                {bots
                  .filter((b) => !b.archived && b.teamId !== id)
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                      {b.teamId ? " · move to this team" : ""}
                    </option>
                  ))}
              </select>
              <button
                className="bots-icon-button"
                aria-label="Add selected bot to team"
                disabled={
                  locked ||
                  dirty ||
                  !bots.some((b) => b.id === assignBot && b.teamId !== id)
                }
              >
                <Plus size={19} />
              </button>
            </form>
          </section>
          <section className="bots-team-section">
            <h3>
              <FolderOpen size={18} />
              Shared workspace
            </h3>
            <p>
              A common folder on this machine. Team bots can use it for
              documents and work in progress.
            </p>
            <div className="bots-team-path">
              <code>{detail.workspace}</code>
              <button
                disabled={!navigator.clipboard}
                aria-label="Copy shared workspace path"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(detail.workspace)
                    .then(() => setCopied(true))
                    .catch(() =>
                      setError(
                        "Could not copy the path. Select the text to copy it.",
                      ),
                    )
                }
              >
                {copied ? <Check size={17} /> : <Copy size={17} />}
              </button>
            </div>
          </section>
          <section className="bots-team-section">
            <h3>Shared memory</h3>
            <p>
              Useful knowledge for the whole team. Bots can read and update this
              through their team tool.
            </p>
            <textarea
              aria-label="Shared team memory"
              value={memory}
              disabled={locked}
              maxLength={64000}
              rows={8}
              placeholder="Team conventions, project context, and useful references…"
              onChange={(e) => setMemory(e.target.value)}
            />
            <div className="bots-team-memory-actions">
              <button
                className="bots-primary"
                disabled={
                  locked ||
                  memory === detail.memory ||
                  name !== detail.name ||
                  color !== detail.color
                }
                onClick={() =>
                  void mutate("teams.memory", {
                    id,
                    memory,
                    expectedRevision: detail.revision,
                  })
                }
              >
                <Save size={16} />
                Save memory
              </button>
              <button
                className="bots-team-text-button"
                disabled={locked}
                onClick={() => {
                  if (
                    !dirty ||
                    window.confirm(
                      "Load the latest team and replace unsaved edits?",
                    )
                  )
                    void load();
                }}
              >
                <RefreshCw size={15} />
                Load latest
              </button>
              {dirty && <small>Unsaved edits</small>}
            </div>
          </section>
          <div className="bots-team-remove">
            <button
              disabled={locked || dirty || members.length > 0}
              onClick={() =>
                void action
                  .run("teams.delete", {
                    id,
                    expectedRevision: detail.revision,
                  })
                  .then((ok) => {
                    if (ok && active.current) onCreated();
                  })
              }
            >
              <Trash2 size={15} />
              Remove empty team
            </button>
            <small>Shared files and memory are retained.</small>
          </div>
        </>
      )}
    </div>
  );
}
