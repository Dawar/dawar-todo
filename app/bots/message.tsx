"use client";
import { memo, useEffect, useState, useRef, useSyncExternalStore } from "react";
import { LazyDetails, TextPages, ItemPages } from "./lazy-details";
import { botsClient } from "./client";
import { ReturnedArtifact } from "./returned-artifact";
import { MarkdownTable } from "./markdown-table";
import type { BotAttachment } from "../../lib/bots-types";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
const messageSchema = { ...defaultSchema, protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), "bot-artifact"] } };
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

function BotMessage({
  item,
  download,
  botId,
  attachments,
  inWorkLog = false,
}: {
  item: ThreadItem;
  botId: string;
  attachments: BotAttachment[];
  download: (id: string) => void;
  inWorkLog?: boolean;
}) {
  function markdown(value: string) {
    return <TextPages text={value} render={(text) => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, messageSchema]]}
        urlTransform={(url) =>
          url.startsWith("bot-artifact:") ? url : defaultUrlTransform(url)
        }
        components={{
          table: renderMarkdownTable,
          a: ({ href, children }) =>
            href?.startsWith("bot-artifact:") ? (
              <ReturnedArtifact botId={botId} id={href.slice(13)} attachment={attachments.find((file) => file.id === href.slice(13))}>{children}</ReturnedArtifact>
            ) : (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    )} />;
  }
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
        <div className="bots-message-markdown">{markdown(item.text)}</div>
      </div>
    );
  if (item.type === "plan")
    return (
      <div className="bots-plan">
        <span>Proposed plan</span>
        <div className="bots-message-markdown">{markdown(item.text)}</div>
      </div>
    );
  if (item.type === "reasoning")
    return item.summary.length ? (
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

function AttachmentImage({
  botId,
  attachment,
}: {
  botId: string;
  attachment: BotAttachment;
}) {
  const [url, setUrl] = useState(""), [visible, setVisible] = useState(false);
  const placeholder = useRef<HTMLSpanElement>(null);
  const online = useSyncExternalStore(botsClient.subscribe, () => botsClient.online, () => false);
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
