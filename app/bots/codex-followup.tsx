"use client";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { CornerDownRight } from 'lucide-react';
import '@/components/ai-elements/ai-elements.css';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { BotComposer } from './composer-controller';
import { draftReviewFingerprint } from './draft-store';
import type { CodexFollowup } from '../../lib/codex-followup';
import './codex-followup.css';

export type FollowupSource = { botId: string; threadId: string; turnId: string; itemId: string };
type Request = FollowupSource & { prompt: string; draft: string };
type Actions = { reason: (source?: FollowupSource) => string; select: (prompt: string, source: FollowupSource) => void };
const ActionsContext = createContext<Actions | null>(null);
const fingerprint = (composer: BotComposer) => draftReviewFingerprint(composer.record);

/** Uses only existing draft editing/persistence; no submission or native RPC. */
export function FollowupComposerProvider({ owner, botId, threadId, composer, disabled, focus, children }: {
  owner: string; botId: string; threadId?: string | null; composer: BotComposer | null; disabled: boolean; focus: () => void; children: ReactNode;
}) {
  const [choice, setChoice] = useState<Request | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const alive = useRef(true), working = useRef(false), current = useRef({ owner, botId, threadId, composer, disabled, focus });
  useLayoutEffect(() => { current.current = { owner, botId, threadId, composer, disabled, focus }; }, [owner, botId, threadId, composer, disabled, focus]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reason = (source?: FollowupSource) => {
    if (!source || !source.threadId || !source.turnId || !source.itemId || source.botId !== botId || source.threadId !== threadId) return 'This shortcut belongs to another or unavailable conversation.';
    if (!composer || composer.owner !== owner || composer.botId !== botId || !composer.canUseOwner || !composer.ready) return 'The composer is unavailable.';
    if (disabled || composer.committing || composer.operation || composer.storageError || composer.draft.queueId) return 'Finish the current input or reconnect before preparing a follow-up.';
    if (busy || choice) return 'Finish the current follow-up choice first.';
    return '';
  };
  const valid = (request: Request, controller: BotComposer) => {
    const now = current.current;
    return alive.current && now.owner === owner && now.botId === request.botId && now.threadId === request.threadId && now.composer === controller &&
      !now.disabled && controller.canUseOwner && controller.ready && !controller.committing && !controller.operation && !controller.storageError &&
      !controller.draft.queueId && fingerprint(controller) === request.draft;
  };
  async function apply(request: Request, append: boolean) {
    const controller = current.current.composer;
    if (!controller || working.current || !valid(request, controller)) { setError('The conversation or draft changed. Choose the shortcut again; your draft is retained.'); setChoice(null); return; }
    working.current = true; setBusy(true); setError('');
    const text = append && controller.draft.text ? `${controller.draft.text}\n${request.prompt}` : request.prompt;
    setChoice(null);
    try {
      await controller.prefillText(text, request.draft, () => {
        const now = current.current;
        return alive.current && now.owner === owner && now.composer === controller && now.botId === request.botId &&
          now.threadId === request.threadId && !now.disabled;
      });
      const now = current.current;
      if (alive.current && now.owner === owner && now.composer === controller && now.botId === request.botId && now.threadId === request.threadId) now.focus();
    } catch (failure) { if (alive.current) setError((failure as Error).name === 'DraftChangedError'
      ? 'The conversation or draft changed. Choose the shortcut again; your draft is retained.'
      : 'Follow-up text is retained in the draft. Retry saving through the composer before closing it.'); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  const actions: Actions = { reason, select: (prompt, source) => {
    if (reason(source)) return;
    const controller = current.current.composer!;
    const request = { ...source, prompt, draft: fingerprint(controller) };
    setError('');
    if (controller.draft.text) setChoice(request);
    else void apply(request, false);
  } };
  return <ActionsContext.Provider value={actions}>{children}
    {error && <p className="bots-error" role="alert">{error}</p>}
    <Dialog open={Boolean(choice)} onOpenChange={open => { if (!open && !busy) { setChoice(null); setError(''); } }}>
      <DialogContent><DialogHeader><DialogTitle>Prepare follow-up</DialogTitle><DialogDescription>Your composer already contains text. Append the follow-up or replace the text. Attachments and the reply stay in place.</DialogDescription></DialogHeader>
        {choice && <div className="bots-followup-preview">{choice.prompt}</div>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setChoice(null)}>Cancel</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => { if (choice) void apply(choice, false); }}>Replace text</Button>
          <Button type="button" disabled={busy} onClick={() => { if (choice) void apply(choice, true); }}>Append to draft</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </ActionsContext.Provider>;
}

export function CodexFollowupButton({ shortcut, source, partial }: { shortcut: CodexFollowup; source?: FollowupSource; partial: boolean }) {
  const actions = useContext(ActionsContext);
  const reason = partial ? 'Available when this reply finishes.' : actions?.reason(source) ?? 'Open this conversation with its composer to prepare the follow-up.';
  return <Button type="button" variant="outline" className="bots-codex-followup ai-suggestion" disabled={Boolean(reason)} title={reason || 'Fill the composer for review'}
    aria-label={`Prepare follow-up: ${shortcut.label}`} onClick={() => { if (source && !reason) actions?.select(shortcut.prompt, source); }}>
    <CornerDownRight size={14} aria-hidden="true"/>{shortcut.label}</Button>;
}
