"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import { botsClient as client } from './bots/client';
import { botComposers } from './bots/composer-service';
import { BotDestinationList } from './bot-destination-list';
import { useShellNavigation } from './app-shell';
import { pendingTodoForwards, saveTodoForward, type TodoForwardIntent } from './todo-forward';
import './todo-forward.css';
import { ControlledDialog } from '@/components/ui/controlled-dialog';
import { Input } from '@/components/ui/input';

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
  return <>{!request && saved && <button type="button" className="todo-forward-recovery" onClick={() => setOpen(true)}>Open saved draft <ArrowRight size={15} /></button>}
    {(request || open && saved) && <ForwardPicker key={request?.id ?? saved!.id} request={request ?? saved!} saved={request ? null : saved} onClose={close} />}</>;
}
function ForwardPicker({ request, saved, onClose }: { request: { id: string; text: string }; saved: TodoForwardIntent | null; onClose: () => void }) {
  const [, redraw] = useState(0), [search, setSearch] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [destinationBot, setDestinationBot] = useState(saved?.botId ?? null);
  const link = useRef<HTMLAnchorElement>(null), inFlight = useRef(false), destination = useRef(saved?.botId ?? null);
  const navigate = useShellNavigation(), owner = client.owner;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { client.start(); return client.subscribe(() => redraw(value => value + 1)); }, []);
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
  return <ControlledDialog title="Forward to a bot" description="Add to a draft. Send when you’re ready." onClose={onClose} className="todo-forward-dialog z-[120]" overlayClassName="z-[120]">
    <label className="todo-forward-search"><Search size={18} /><Input aria-label="Find a bot" placeholder="Find a bot" value={search} onChange={event => setSearch(event.target.value)} /></label>
    {!client.online && <p className="todo-forward-note">Offline · saved bots and local drafts are available.</p>}
    <BotDestinationList bots={bots} busy={busy} disabled={busy || !owner} onChoose={id => void choose(id)} emptyMessage={client.started && !client.snapshot ? 'Connect once to load your bots.' : 'No matching bots.'} />
    <footer>Existing text and files stay in your draft.</footer>{error && <p role="alert" className="todo-forward-error">{error}</p>}
    <a ref={link} hidden onClick={event => navigate(event, event.currentTarget.getAttribute('href')!)}>Open conversation</a>
  </ControlledDialog>;
}
