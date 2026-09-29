"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Search, X } from 'lucide-react';
import { botsClient as client } from './bots/client';
import { botComposers } from './bots/composer-service';
import { BotAvatar } from './bots/bot-avatar';
import { useShellNavigation } from './app-shell';
import { pendingTodoForwards, saveTodoForward, type TodoForwardIntent } from './todo-forward';
import './todo-forward.css';

export function TodoForward({ request, onClose }: { request: { id: string; text: string } | null; onClose: () => void }) {
  const [saved, setSaved] = useState<TodoForwardIntent | null>(null), [open, setOpen] = useState(false);
  const close = useCallback(() => { setOpen(false); onClose(); }, [onClose]);
  useEffect(() => {
    let active = true;
    const read = () => { if (!active) return; try { setSaved(client.owner ? pendingTodoForwards(client.owner)[0] ?? null : null); } catch { setSaved(null); } };
    try { if (Object.keys(localStorage).some(key => key.startsWith('dawar-todo-forward:v1:'))) { client.start(); read(); } } catch { /* picker exposes storage failure on action */ }
    const unsubscribe = client.subscribe(read);
    return () => { active = false; unsubscribe(); };
  }, []);
  return <>{!request && saved && <button type="button" className="todo-forward-recovery" onClick={() => setOpen(true)}>Continue saved Forward <ArrowRight size={15} /></button>}
    {(request || open && saved) && <ForwardPicker key={request?.id ?? saved!.id} request={request ?? saved!} saved={request ? null : saved} onClose={close} />}</>;
}
function ForwardPicker({ request, saved, onClose }: { request: { id: string; text: string }; saved: TodoForwardIntent | null; onClose: () => void }) {
  const [, redraw] = useState(0), [search, setSearch] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [destinationBot, setDestinationBot] = useState(saved?.botId ?? null);
  const dialog = useRef<HTMLDivElement>(null), link = useRef<HTMLAnchorElement>(null), inFlight = useRef(false), destination = useRef(saved?.botId ?? null);
  const navigate = useShellNavigation(), owner = client.owner;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { client.start(); return client.subscribe(() => redraw(value => value + 1)); }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopImmediatePropagation(); onClose(); }
      if (event.key !== 'Tab') return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,a[href]') ?? [])].filter(item => item.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); previous?.focus({ preventScroll: true }); };
  }, [onClose]);
  async function choose(botId: string) {
    if (inFlight.current || !owner || client.owner !== owner) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      if (saved && saved.owner !== owner) throw Error("Reopen this saved forward as its original owner.");
      if (destination.current && destination.current !== botId) throw Error('Continue the saved destination first. Its original draft is retained.');
      const intent: TodoForwardIntent = { id: request.id, text: request.text, owner, botId, state: 'prepared' };
      saveTodoForward(intent); destination.current = botId; setDestinationBot(botId);
      await botComposers.get(owner, botId).appendForward(intent.id, intent.text);
      saveTodoForward({ ...intent, state: 'appended' });
      if (client.owner !== owner) throw Error('The signed-in owner changed. The forward is saved for its original owner.');
      if (!mounted.current) return;
      link.current!.href = `/bots?bot=${encodeURIComponent(botId)}`;
      link.current!.click(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Forward could not finish. Retry the same saved forward.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const bots = (client.snapshot?.bots ?? []).filter(bot => !bot.archived && (!destinationBot || bot.id === destinationBot) && `${bot.name} ${bot.purpose}`.toLowerCase().includes(search.toLowerCase()));
  return createPortal(<div className="todo-forward-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={dialog} className="todo-forward-dialog" role="dialog" aria-modal="true" aria-labelledby="todo-forward-title">
    <header><div><h2 id="todo-forward-title">Forward to a bot</h2><p>Add to a draft. Send when you’re ready.</p></div><button type="button" aria-label="Close Forward" onClick={onClose}><X size={20} /></button></header>
    <label className="todo-forward-search"><Search size={18} /><input aria-label="Find a bot" placeholder="Find a bot" value={search} onChange={event => setSearch(event.target.value)} /></label>
    {!client.online && <p className="todo-forward-note">Offline · saved bots and local drafts are available.</p>}
    <div className="todo-forward-list" aria-busy={busy}>{bots.slice(0, 60).map(bot => <button type="button" key={bot.id} disabled={busy || !owner} onClick={() => void choose(bot.id)}><BotAvatar bot={bot} small /><span><strong>{bot.name}</strong><small>{bot.purpose || 'Conversation'}</small></span><ArrowRight size={18} /></button>)}
      {!bots.length && <p>{client.started && !client.snapshot ? 'Connect once to load your bots.' : 'No matching bots.'}</p>}{bots.length > 60 && <p>Search to narrow {bots.length} bots.</p>}</div>
    <footer>Existing text and files stay in your draft.</footer>{error && <p role="alert" className="todo-forward-error">{error}</p>}
    <a ref={link} hidden onClick={event => navigate(event, event.currentTarget.getAttribute('href')!)}>Open conversation</a>
  </div></div>, document.body);
}
