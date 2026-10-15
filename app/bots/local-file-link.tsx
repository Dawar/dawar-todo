"use client";
import { FileQuestion } from "lucide-react";
import type { ReactNode } from "react";
import type { BotAttachment } from "../../lib/bots-types";
import { matchLocalArtifact } from "../../lib/local-file-link.mjs";
import { botsClient } from "./client";
import { ReturnedArtifact } from "./returned-artifact";
import "./file-citation.css";

/**
 * A bot's link to a path on its own machine. It opens only an exactly matching
 * registered artifact of the same bot; otherwise it states that the file was not
 * shared instead of rendering a link to a nonexistent remote path.
 */
export function LocalFileLink({ botId, link, attachments, children }: {
  botId: string; link: { path: string | null; name: string }; attachments: BotAttachment[]; children?: ReactNode;
}) {
  const match = matchLocalArtifact(link, botId, attachments);
  if (match.state === "registered") return <ReturnedArtifact botId={botId} id={match.attachment.id} attachment={match.attachment}>{children}</ReturnedArtifact>;
  const bot = botsClient.snapshot?.bots.find(value => value.id === botId)?.name ?? "the bot";
  const label = typeof children === "string" && children.trim() && children !== link.path ? children : link.name;
  return <span className="bots-file-citation is-unavailable" role="note" title={link.path ?? link.name}>
    <FileQuestion size={22} strokeWidth={1.5} aria-hidden="true" />
    <span><strong>{label}</strong><small>{match.state === "ambiguous"
      ? <>Several published versions match · <a href={`/bots?bot=${encodeURIComponent(botId)}&view=attachments`}>Open attachments</a></>
      : <>Local file on {bot}&apos;s computer · not shared here. Ask {bot} to publish it.</>}</small></span>
  </span>;
}
