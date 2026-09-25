"use client";
import { useEffect, useState } from "react";
import { botsClient } from "./client";
import type { BotAttachment } from "../../lib/bots-types";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
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

export function BotMessage({
  item,
  download,
  botId,
  attachments,
}: {
  item: ThreadItem;
  botId: string;
  attachments: BotAttachment[];
  download: (id: string) => void;
}) {
  function markdown(value: string) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        urlTransform={(url) =>
          url.startsWith("bot-artifact:") ? url : defaultUrlTransform(url)
        }
        components={{
          a: ({ href, children }) =>
            href?.startsWith("bot-artifact:") ? (
              <button
                className="bots-artifact-link"
                onClick={() => download(href.slice(13))}
              >
                <Download size={15} />
                {children}
              </button>
            ) : (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
        }}
      >
        {value}
      </ReactMarkdown>
    );
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
          {item.content.map((c, i) =>
            c.type === "text" ? (
              <p key={i}>{c.text}</p>
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
            ),
          )}
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
      <details className="bots-tool">
        <summary>Thinking</summary>
        <div className="bots-message-markdown">
          {markdown(item.summary.join("\n\n"))}
        </div>
      </details>
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
  const running = "status" in item && item.status === "inProgress";
  return (
    <details className="bots-tool">
      <summary>
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
      </summary>
      {command ? (
        <>
          <pre>{item.aggregatedOutput || "Waiting for output…"}</pre>
          {item.exitCode !== null && <small>Exit code {item.exitCode}</small>}
        </>
      ) : diff ? (
        item.changes.map((change, i) => (
          <div key={i}>
            <strong>{change.path}</strong>
            <pre>{change.diff}</pre>
          </div>
        ))
      ) : (
        <pre>{JSON.stringify(item, null, 2)}</pre>
      )}
    </details>
  );
}

function AttachmentImage({
  botId,
  attachment,
}: {
  botId: string;
  attachment: BotAttachment;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
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
  }, [botId, attachment.id]);
  return url ? (
    <img className="bots-attached-image" src={url} alt={attachment.name} />
  ) : (
    <span>{attachment.name}</span>
  );
}
