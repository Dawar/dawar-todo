"use client";
import { createContext, useContext, Fragment, memo, useEffect, useState, useRef, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { LazyDetails, TextPages, ItemPages } from "./lazy-details";
import { botsClient } from "./client";
import { Button } from "@/components/ui/button";
import { ReturnedArtifact } from "./returned-artifact";
import { ReturnedVisualization } from "./returned-visualization";
import { remarkVisualizations } from "./visualization-markdown";
import { MarkdownTable } from "./markdown-table";
import { MarkdownCodeBlock } from "../markdown-code-block";
import type { BotAttachment } from "../../lib/bots-types";
import { proposedPlanParts } from "../../lib/proposed-plan";
import type { NativeWorkPlan } from '../../lib/native-work-plan';
import './native-work-plan.css';
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
const messageSchema = { ...defaultSchema, protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), "bot-artifact", "bot-visualization"] } };
import {
  Terminal,
  FileDiff,
  Search,
  Wrench,
  CircleAlert,
  Check,
  LoaderCircle,
} from "lucide-react";
import type { ThreadItem } from "../../lib/codex-protocol/v2/ThreadItem";

const renderMarkdownTable: Components["table"] = ({ children }) => <MarkdownTable>{children}</MarkdownTable>;
const MarkdownFiles = createContext<{ botId: string; attachments: BotAttachment[] }>({ botId: "", attachments: [] });
const MarkdownLink: Components["a"] = ({ href, children }) => {
  const { botId, attachments } = useContext(MarkdownFiles);
  if (href?.startsWith("bot-visualization:")) return <ReturnedVisualization botId={botId} reference={href.slice(18)} attachments={attachments} />;
  if (href?.startsWith("bot-artifact:")) return <ReturnedArtifact botId={botId} id={href.slice(13)} attachment={attachments.find(file => file.id === href.slice(13))}>{children}</ReturnedArtifact>;
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
};
// Stable Markdown adapters retain an open viewer when message metadata updates.
const markdownComponents: Components = { table: renderMarkdownTable, pre: MarkdownCodeBlock, a: MarkdownLink };
function MessageMarkdown({ text, botId, attachments }: { text: string; botId: string; attachments: BotAttachment[] }) {
  const files = useMemo(() => ({ botId, attachments }), [botId, attachments]);
  return <MarkdownFiles.Provider value={files}><ReactMarkdown remarkPlugins={[remarkGfm, remarkVisualizations]}
    rehypePlugins={[[rehypeSanitize, messageSchema]]}
    urlTransform={url => url.startsWith('bot-artifact:') || url.startsWith('bot-visualization:') ? url : defaultUrlTransform(url)}
    components={markdownComponents}>{text}</ReactMarkdown></MarkdownFiles.Provider>;
}
export function WorkPlanMessage({ plan, botId, attachments, turnStatus }: { plan: NativeWorkPlan; botId: string; attachments: BotAttachment[]; turnStatus?: string }) {
  const markdown = (text: string) => <MessageMarkdown text={text} botId={botId} attachments={attachments}/>;
  return <section className="bots-native-work-plan" aria-label="Native Work plan">
    {plan.explanation?.trim() && <div className="bots-message-markdown"><TextPages text={plan.explanation} render={markdown}/></div>}
    {!!plan.steps.length && <div role="list" className="bots-work-plan-steps"><ItemPages items={plan.steps} size={8} render={(step, index) => <div role="listitem" key={index}>
      <span className="bots-work-plan-status" data-status={step.status}>{step.status === 'completed' ? 'Completed' : step.status === 'inProgress' ? 'In progress' : 'Pending'}</span>
      <div className="bots-message-markdown"><TextPages text={step.step} render={markdown}/></div>
    </div>}/></div>}
    {!plan.complete && <p className="bots-system-note">Partial plan · {plan.steps.length} of {plan.totalSteps} steps shown.</p>}
    {turnStatus && turnStatus !== 'inProgress' && <p className="bots-system-note">Turn {turnStatus} · last recorded plan.</p>}
  </section>;
}

function ProposedPlanText({ text, partial, nativePlan = false, render }: {
  text: string; partial: boolean; nativePlan?: boolean; render: (text: string) => ReactNode;
}) {
  const parts = useMemo(() => proposedPlanParts(text, partial), [text, partial]);
  return <TextPages text={text} render={(page, offset) => parts.flatMap(part => {
    const start = Math.max(part.start, offset), end = Math.min(part.end, offset + page.length);
    if (start >= end && !(part.kind === "plan" && part.start === part.end && part.start >= offset && part.start <= offset + page.length)) return [];
    const body = render(text.slice(start, Math.max(start, end)));
    return [part.kind === "plan" && !nativePlan ? <div key={part.key} className="bots-plan">
      <span>Proposed plan</span><div className="bots-message-markdown">{body}</div>
    </div> : <Fragment key={part.key}>{body}</Fragment>];
  })} />;
}

function BotMessage({
  item,
  botId,
  attachments,
  inWorkLog = false,
  partial = false,
}: {
  item: ThreadItem;
  botId: string;
  attachments: BotAttachment[];
  download: (id: string) => void;
  inWorkLog?: boolean;
  partial?: boolean;
}) {
  function markdownPage(text: string) {
    return <MessageMarkdown text={text} botId={botId} attachments={attachments}/>;
  }
  function markdown(value: string) { return <TextPages text={value} render={markdownPage} />; }
  // Worker callbacks are internal supervision, not messages authored by Dawar.
  if (
    item.type === "userMessage" &&
    item.clientId?.startsWith("manager-notice:")
  )
    return null;
  if (item.type === "userMessage")
    return (
      <div className="bots-message bots-user">
        <div className="bots-bubble">
          {item.clientId?.startsWith("schedule:") && (
            <small>Scheduled task</small>
          )}
          {<ItemPages items={item.content} render={(c, i) =>
            c.type === "text" ? (
              <TextPages key={i} text={c.text} render={(text) => <p>{text}</p>} />
            ) : c.type === "localImage" &&
              attachments.find((a) => a.path === c.path) ? (
              <AttachmentImage
                key={i}
                botId={botId}
                attachment={attachments.find((a) => a.path === c.path)!}
              />
            ) : (
              <p key={i} className="bots-input-file">
                {c.type === "localImage" || c.type === "image"
                  ? "Image attached"
                  : c.type === "skill"
                    ? `$${c.name}`
                    : "File attached"}
              </p>
            )
          } />}
        </div>
      </div>
    );
  if (item.type === "agentMessage")
    return (
      <div
        className={`bots-message bots-agent ${item.phase === "commentary" ? "is-commentary" : ""}`}
      >
        <div className="bots-message-markdown"><ProposedPlanText text={item.text} partial={partial} render={markdownPage} /></div>
      </div>
    );
  if (item.type === "plan")
    return (
      <div className="bots-plan">
        <span>Proposed plan</span>
        <div className="bots-message-markdown"><ProposedPlanText text={item.text} partial={partial} nativePlan render={markdownPage} /></div>
      </div>
    );
  if (item.type === "reasoning")
    return item.summary.some(text => text.trim()) ? (
      inWorkLog ? (
        <div className="bots-reasoning">
          <span>Thinking</span>
          <div className="bots-message-markdown">
            {markdown(item.summary.join("\n\n"))}
          </div>
        </div>
      ) : (
        <LazyDetails summary="Thinking">{() => <>
          <div className="bots-message-markdown">
            {markdown(item.summary.join("\n\n"))}
          </div>
        </>}</LazyDetails>
      )
    ) : null;
  if (item.type === "contextCompaction")
    return (
      <div className="bots-system-note">Conversation context compacted</div>
    );
  const command = item.type === "commandExecution",
    diff = item.type === "fileChange",
    search = item.type === "webSearch";
  const label = command
    ? item.command
    : diff
      ? `${item.changes.length} file ${item.changes.length === 1 ? "change" : "changes"}`
      : search
        ? item.query
        : item.type === "mcpToolCall"
          ? `${item.server} · ${item.tool}`
          : item.type === "dynamicToolCall"
            ? item.tool
            : item.type.replace(/([a-z])([A-Z])/g, "$1 $2");
  const toolBody = () => command ? (
        <>
          <TextPages text={item.aggregatedOutput || "Waiting for output…"} render={(text) => <pre>{text}</pre>} />
          {item.exitCode !== null && <small>Exit code {item.exitCode}</small>}
        </>
      ) : diff ? (
        <ItemPages items={item.changes} size={5} render={(change, i) => (
          <div key={i}>
            <strong>{change.path}</strong>
            <TextPages text={change.diff} render={(text) => <pre>{text}</pre>} />
          </div>
        )} />
      ) : (
        <TextPages text={JSON.stringify(item, null, 2)} render={(text) => <pre>{text}</pre>} />
      );
  if (inWorkLog) return <div className="bots-tool">{toolBody()}</div>;
  const status = "status" in item ? item.status : null;
  const running = status === "inProgress";
  const failed = status === "failed" || status === "declined" || status === "interrupted" ||
    (command && item.exitCode !== null && item.exitCode !== 0) || (item.type === "dynamicToolCall" && item.success === false);
  return (
    <LazyDetails summary={<>
        {command ? (
          <Terminal size={15} />
        ) : diff ? (
          <FileDiff size={15} />
        ) : search ? (
          <Search size={15} />
        ) : (
          <Wrench size={15} />
        )}
        <span title={label}>{label}</span>
        {running ? (
          <LoaderCircle size={14} className="bots-spin" aria-label="In progress" />
        ) : failed ? (
          <CircleAlert size={14} className="text-destructive" aria-label={status === "declined" ? "Declined" : status === "interrupted" ? "Interrupted" : "Failed"} />
        ) : status === "completed" ? <Check size={14} aria-label="Completed" /> : null}
      </>}>{toolBody}
    </LazyDetails>
  );
}

const MemoBotMessage = memo(BotMessage);
export { MemoBotMessage as BotMessage };

export function AttachmentImage({
  botId,
  attachment,
}: {
  botId: string;
  attachment: BotAttachment;
}) {
  const owner = useSyncExternalStore(botsClient.subscribe, () => botsClient.owner, () => "");
  const online = useSyncExternalStore(botsClient.subscribe, () => botsClient.online || botsClient.storageCatalogAvailable, () => false);
  return <AttachmentImageContent key={JSON.stringify([owner, botId, attachment.id, online])}
    owner={owner} online={online} botId={botId} attachment={attachment} />;
}

function AttachmentImageContent({ owner, online, botId, attachment }: {
  owner: string; online: boolean; botId: string; attachment: BotAttachment;
}) {
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; url?: string; failed?: boolean } | null>(null);
  const placeholder = useRef<HTMLSpanElement>(null);
  const key = JSON.stringify([owner, botId, attachment.id, online, attempt]);
  const current = result?.key === key ? result : null;
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setVisible(true); }, { rootMargin: "200px" });
    if (placeholder.current) observer.observe(placeholder.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!owner || !online || !visible) return;
    let alive = true;
    let objectUrl = "";
    const controller = new AbortController();
    void botsClient.download(botId, attachment.id, owner, controller.signal)
      .then(({ blob }) => {
        if (!alive || botsClient.owner !== owner) return;
        objectUrl = URL.createObjectURL(blob);
        setResult({ key, url: objectUrl });
      })
      .catch(() => {
        if (alive && botsClient.owner === owner) setResult({ key, failed: true });
      });
    return () => {
      alive = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [owner, botId, attachment.id, online, visible, key]);
  return <span ref={placeholder} className="bots-attachment-image-frame">{current?.url ? (
    <img className="bots-attached-image" src={current.url} alt={attachment.name}
      onError={() => setResult({ key, failed: true })} />
  ) : (
    <span className="bots-attachment-image-state">
      <span>{attachment.name}</span>
      <span className="text-muted-foreground text-xs" role="status">
        {!owner || !online ? "Reconnect to view image" : current?.failed ? "Image unavailable" : visible ? "Loading image…" : "Image"}
      </span>
      {owner && online && current?.failed && <Button type="button" variant="outline" size="sm"
        onClick={() => setAttempt(value => value + 1)}>Retry image</Button>}
    </span>
  )}</span>;
}
