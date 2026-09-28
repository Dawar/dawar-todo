"use client";
import { ArrowDown, ArrowUp, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { Bot, BotQueuedSubmission } from '../../lib/bots-types';
import { canMoveQueued, queueEditable, queueResumeBlocked, queueStatus } from './queue-state';
import { useQueueAction } from './use-queue-action';
import { UploadThumbnail } from './upload-thumbnail';
import './prompt-queue.css';

export function PromptQueue({ owner, bot, items, online, canEdit, onEdit, refresh }: {
  owner: string; bot: Bot; items: BotQueuedSubmission[]; online: boolean; canEdit: boolean;
  onEdit: (item: BotQueuedSubmission) => void; refresh: () => Promise<void>;
}) {
  const action = useQueueAction(owner, bot.id, refresh);
  if (!items.length && !action.pending && !action.error) return null;
  const locked = action.busy || action.blocked;
  const move = (index: number, direction: number) => {
    if (!canMoveQueued(items, index, direction)) return;
    const ids = items.map(item => item.id), other = index + direction;
    [ids[index], ids[other]] = [ids[other], ids[index]];
    action.run('queue.reorder', { ids });
  };
  return <section className="bots-prompt-queue bots-queue-panel" aria-label="Queued messages">
    <header><strong>Queued next{items.length > 0 && <span>{items.length}</span>}</strong><button type="button" aria-label="Refresh queue status" disabled={!online || action.busy} onClick={() => void refresh()}><RefreshCw size={15} /></button></header>
    {!online && <p className="bots-queue-explanation">Saved queue. Reconnect to check its current status.</p>}
    {bot.queuePaused && items.length > 0 && <div className="bots-queue-paused"><span>{queueResumeBlocked(items) ? 'Review the messages below before resuming.' : 'Queue paused.'}</span><button type="button" disabled={!online || locked || queueResumeBlocked(items)} onClick={() => action.run('queue.resume')}>Resume queue</button></div>}
    {action.pending && <div className="bots-queue-action-note" role="status"><p>{action.busy ? 'Waiting for confirmation…' : action.notSaved ? 'This queue action is waiting to be saved on your device.' : 'A queue action still needs confirmation. Check the same action before making another change.'}</p><button type="button" disabled={!online || action.busy} onClick={action.retry}>Retry same action</button></div>}
    {action.error && <div className="bots-queue-action-note is-error" role="alert"><p>{action.error}</p>{!action.pending && action.blocked && <button type="button" onClick={action.recover}>Read saved action again</button>}</div>}
    {items.map((item, index) => {
      const status = queueStatus(item, bot.queuePaused);
      const mutable = queueEditable(item) && !locked;
      return <article className="bots-prompt-queue-item" key={item.id}>
        <span className="bots-queue-number">{index + 1}</span>
        <div className="bots-queue-content"><span>{item.input.flatMap(input => input.type === 'text' && !input.text.startsWith('Attached file: ') ? [input.text] : []).join('\n') || 'Attachments'}</span>
          <p className={`bots-queue-status${status.attention ? ' needs-attention' : ''}`}><strong>{status.label}</strong><span>{status.description}</span></p>
          {item.error && <p className="bots-queue-item-error">{item.error}</p>}
          {item.attachments.length > 0 && <div className="bots-queue-attachments">{item.attachments.map(file => <span key={file.id} title={file.name}>{file.mimeType.startsWith('image/') && <UploadThumbnail botId={bot.id} attachmentId={file.id} online={online} />}{file.name}</span>)}</div>}
        </div>
        <div className="bots-queue-actions">
          <button type="button" aria-label={`Edit queued message ${index + 1}`} disabled={!canEdit || !mutable} onClick={() => onEdit(item)}><Pencil size={15} /></button>
          <button type="button" aria-label={`Move queued message ${index + 1} up`} disabled={!online || locked || !canMoveQueued(items,index,-1)} onClick={() => move(index,-1)}><ArrowUp size={15} /></button>
          <button type="button" aria-label={`Move queued message ${index + 1} down`} disabled={!online || locked || !canMoveQueued(items,index,1)} onClick={() => move(index,1)}><ArrowDown size={15} /></button>
          <button type="button" aria-label={`Remove queued message ${index + 1}`} disabled={!online || !mutable} onClick={() => action.run('queue.delete', { id: item.id, ...(item.revision === undefined ? {} : { expectedRevision: item.revision }) })}><Trash2 size={15} /></button>
        </div>
      </article>;
    })}
  </section>;
}
