/* eslint-disable @next/next/no-img-element -- Remote files are downloaded as local blob URLs. */
import { useEffect, useState } from "react";
import { Paperclip } from "lucide-react";
import { botsClient as client } from "./client";

// Queue/history thumbnails are disposable; composer previews use staged bytes.
export function UploadThumbnail({ botId, attachmentId, online }: { botId: string; attachmentId?: string; online: boolean }) {
  const [preview, setPreview] = useState<{ key: string; url: string } | null>(null);
  const key = JSON.stringify([client.owner, botId, attachmentId]);
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    if (attachmentId && online) void client.download(botId, attachmentId).then(({ blob }) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setPreview({ key, url: objectUrl });
    }).catch(() => {});
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachmentId, botId, online, key]);
  return preview?.key === key ? <img src={preview.url} alt="" /> : <Paperclip size={18} aria-hidden="true" />;
}
