"use client";
import { createContext, useContext, Fragment, memo, useEffect, useState, useRef, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { LazyDetails, TextPages, ItemPages } from "./lazy-details";
import { botsClient } from "./client";
import { ReturnedArtifact } from "./returned-artifact";
import { ReturnedVisualization } from "./returned-visualization";
import { remarkVisualizations } from "./visualization-markdown";
import { MarkdownTable } from "./markdown-table";
import { MarkdownCodeBlock } from "../markdown-code-block";
import type { BotAttachment } from "../../lib/bots-types";
import { proposedPlanParts } from "../../lib/proposed-plan";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
const messageSchema = { ...defaultSchema, protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), "bot-artifact", "bot-visualization"] } };
import {
  Terminal,
  FileDiff,
  Search,
  Wrench,
  Download,
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
  download,
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
  const markdownFiles = useMemo(() => ({ botId, attachments }), [botId, attachments]);
  function markdownPage(text: string) {
    return (
      <MarkdownFiles.Provider value={markdownFiles}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkVisualizations]}
        rehypePlugins={[[rehypeSanitize, messageSchema]]}
        urlTransform={(url) =>
          url.startsWith("bot-artifact:") || url.startsWith("bot-visualization:") ? url : defaultUrlTransform(url)
        }
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
      </MarkdownFiles.Provider>
    );
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
  const running = "status" in item && item.status === "inProgress";
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
        <span>{label}</span>
        {running ? (
          <LoaderCircle size={14} className="bots-spin" />
        ) : (
          <Check size={14} />
        )}
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
  const [url, setUrl] = useState(""), [visible, setVisible] = useState(false);
  const placeholder = useRef<HTMLSpanElement>(null);
  const online = useSyncExternalStore(botsClient.subscribe, () => botsClient.online || botsClient.storageCatalogAvailable, () => false);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setVisible(true); }, { rootMargin: "200px" });
    if (placeholder.current) observer.observe(placeholder.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!online || !visible) return;
    let alive = true,
      objectUrl = "";
    void botsClient
      .download(botId, attachment.id)
      .then(({ blob }) => {
        if (alive) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [botId, attachment.id, online, visible]);
  return <span ref={placeholder}>{url ? (
    <img className="bots-attached-image" src={url} alt={attachment.name} />
  ) : (
    <span>{attachment.name}{!online ? " · reconnect to view image" : ""}</span>
  )}</span>;
}
