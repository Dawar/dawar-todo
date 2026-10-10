"use client";
import { portableHeaders } from "../../lib/portable-csrf";
import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Phone, PhoneOff, Square, VolumeX, X } from 'lucide-react';
import type { OperatorBot, OperatorContext, OperatorSegment, OperatorView } from '../../lib/operator-types';
import { OperatorVoiceEvents, type OperatorRealtimeEvent } from '../../lib/operator-voice-events';
import { BotMessage } from './message';
import { botsClient } from './client';
import { registerPwaUpdateGuard } from '../pwa-update';
import './operator-call.css';

async function api<T>(url: string, input?: Record<string, unknown>, method = 'POST'): Promise<T> {
  const response = await fetch(url, { method, headers: portableHeaders(input?{'Content-Type':'application/json'}:undefined), ...(input?{body:JSON.stringify(input)}:{}), cache: 'no-store' });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || 'The call action could not be confirmed.');
  return body;
}

export function OperatorCallCard({ segment: initial, bodyOnly = false }: { segment: OperatorSegment; bodyOnly?: boolean }) {
  const [olderRows, setOlderRows] = useState<Partial<OperatorSegment>>({}), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const segment = { ...initial, ...olderRows,
    requests: [...new Map([...(olderRows.requests ?? []), ...initial.requests].map(row => [row.id, row])).values()],
    transcript: [...new Map([...(olderRows.transcript ?? []), ...initial.transcript].map(row => [row.id, row])).values()],
  };
  async function older(kind: 'transcript' | 'request') {
    if (!segment.botId || loading) return;
    setLoading(true); setError('');
    try {
      const page = await botsClient.rpc<OperatorSegment>('operator.segment', segment.botId, { segmentId: segment.id,
        ...(kind === 'transcript' ? { beforeTranscript: segment.transcriptCursor } : { beforeRequest: segment.requestCursor }) });
      setOlderRows(current => ({ ...current, ...(kind === 'transcript' ? { transcript: [...page.transcript, ...segment.transcript], transcriptCursor: page.transcriptCursor }
        : { requests: [...page.requests, ...segment.requests], requestCursor: page.requestCursor }) }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Older call history is unavailable.'); }
    finally { setLoading(false); }
  }
  const latest = initial.requests.at(-1);
  const body = <div className="operator-call-card-body">
      {error && <p role="alert">{error}</p>}
      {segment.transcript.length > 0 && <details><summary>Voice transcript</summary>{segment.transcriptCursor && <button disabled={loading} onClick={() => void older('transcript')}>Earlier transcript</button>}{segment.transcript.map(message => <p key={message.id} className={message.role === 'user' ? 'operator-human' : ''}><small>{message.role === 'user' ? 'You' : 'Voice'}</small>{message.content}</p>)}</details>}
      {segment.requestCursor && <button disabled={loading} onClick={() => void older('request')}>Earlier submitted work</button>}
      {segment.requests.map(request => <section key={request.id} className="operator-request">
        <div className="operator-request-state"><strong>{request.state === 'completed' ? 'Native result' : request.state.replaceAll('-', ' ')}</strong>{request.paused && <span>Automatic intake paused</span>}</div>
        <p>{request.text}</p>
        {request.error && <p role="alert">{request.error}</p>}
        {request.questions.length > 0 && <p>Input is needed in {request.bot.name}’s conversation.</p>}
        <a className="operator-conversation-link" href={`/bots?bot=${encodeURIComponent(request.bot.id)}`}>Open bot conversation</a>
        {[...request.progress, ...request.results].map(message => <BotMessage key={message.id} botId={request.bot.id} attachments={[]} download={() => {}} item={{ type: 'agentMessage', id: message.id, text: message.text, phase: message.phase === 'final_answer' ? 'final_answer' : 'commentary', memoryCitation: null, delivery: null, questions: null }} />)}
      </section>)}
      {!segment.requests.length && !segment.transcript.length && <p className="operator-muted">No work submitted in this segment.</p>}
    </div>;
  if (bodyOnly) return body;
  return <details className="operator-call-card">
    <summary><Phone size={16} aria-hidden="true" /><strong>{segment.bot?.name ?? 'Operator'}</strong><span>{latest?.state === 'completed' ? 'Result ready' : latest?.state.replaceAll('-', ' ') ?? (segment.endedAt ? 'Call ended' : 'Voice conversation')}</span><time>{new Date(segment.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></summary>
    {body}
  </details>;
}

export function OperatorSegmentBody({ botId, segmentId, onOpenCalls }: { botId: string; segmentId: string; onOpenCalls?: () => void }) {
  const [segment, setSegment] = useState<OperatorSegment | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void botsClient.rpc<OperatorSegment>('operator.segment', botId, { segmentId }).then(value => { if (active) setSegment(value); }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Call segment unavailable.'); });
    return () => { active = false; };
  }, [botId, segmentId]);
  return <>{error && <p role="alert">{error}</p>}{segment ? <OperatorCallCard segment={segment} bodyOnly /> : !error && <p className="operator-muted">Loading call segment…</p>}{onOpenCalls && <button onClick={onOpenCalls}>All calls for this bot</button>}</>;
}

export function OperatorCallHistory({ owner, botId, online }: { owner: string; botId: string; online: boolean }) {
  const [cards, setCards] = useState<OperatorSegment[]>([]), [error, setError] = useState(''), [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(false);
  async function older() {
    if (!cursor || loading) return; setLoading(true);
    try { const result = await botsClient.rpc<{ cards: OperatorSegment[]; nextCursor: string | null }>('operator.cards', botId, { before: cursor }); setCards(current => [...current, ...result.cards]); setCursor(result.nextCursor); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Older calls are unavailable.'); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    let active = true;
    if (online) void botsClient.rpc<{ cards: OperatorSegment[]; nextCursor: string | null }>('operator.cards', botId).then(result => { if (active) { setCards(result.cards); setCursor(result.nextCursor); setError(''); } }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Call history is unavailable.'); });
    return () => { active = false; };
  }, [owner, botId, online]);
  return <div className="operator-call-history"><h3>Calls</h3>{error && <p role="alert">{error}</p>}{cards.map(segment => <OperatorCallCard key={segment.id} segment={segment} />)}{cursor && <button disabled={loading || !online} onClick={() => void older()}>Earlier calls</button>}{!cards.length && !error && <p className="operator-muted">Call conversations and submitted bot work appear here.</p>}</div>;
}

type RealtimeEvent = OperatorRealtimeEvent & { transcript?: string };
type Start = { sessionId: string; clientSecret: string; operator: OperatorContext };
export function OperatorQuestionContext({ context }: { context: OperatorContext }) {
  const requests = context.pendingQuestions ?? [];
  if (!requests.length) return null;
  return <details className="operator-call-card"><summary>Input needed · {requests.reduce((n, r) => n + r.questions.length, 0)} questions</summary>
    <div className="operator-call-card-body"><p>Tell Operator your answer. It will use the current question controls in {context.bot?.name}’s conversation.</p>
      {requests.map(request => <section key={request.key}>{request.questions.map(question => <div key={question.id}>
        <p><strong>{question.question}</strong></p>{question.options?.length ? <ol>{question.options.map(option => <li key={option.label}>{option.label}{option.description && <small>{option.description}</small>}</li>)}</ol> : null}
      </div>)}{!request.voiceAnswerable && <p>Use the normal bot controls for this private input.</p>}
        {['dispatching', 'prepared'].includes(request.answerState) && <p>The original answer is unconfirmed. Do not send it again.</p>}</section>)}
    </div></details>;
}

export function OperatorCallDialog({ bot, bots, onClose }: { bot: OperatorBot | null; bots: OperatorBot[]; onClose: () => void }) {
  const [status, setStatus] = useState('Ready to call'), [error, setError] = useState(''), [muted, setMuted] = useState(false), [selected, setSelected] = useState<OperatorContext | null>(null), [view, setView] = useState<OperatorView | null>(null);
  const [connected, setConnected] = useState(false);
  const [starting, setStarting] = useState(false), [changing, setChanging] = useState(false);
  const dialog = useRef<HTMLElement | null>(null);
  const session = useRef<string | null>(null), pc = useRef<RTCPeerConnection | null>(null), stream = useRef<MediaStream | null>(null), channel = useRef<RTCDataChannel | null>(null), audio = useRef<HTMLAudioElement | null>(null);
  const ended = useRef(false), voice = useRef<OperatorVoiceEvents | null>(null), tools = useRef(Promise.resolve()), alive = useRef(true);
  const startingRef = useRef(false);
  const polling = useRef(false), queuedTools = useRef(new Set<string>()), lastSpeech = useRef(0);
  useEffect(() => registerPwaUpdateGuard('operator-call', async () => {
    if (startingRef.current || session.current && !ended.current) throw Error('Finish the voice call before refreshing.');
  }), []);
  const send = (event: Record<string, unknown>) => { if (channel.current?.readyState !== 'open') return false; channel.current.send(JSON.stringify(event)); return true; };
  useEffect(() => { voice.current = new OperatorVoiceEvents(event => { if (channel.current?.readyState !== "open") return false; channel.current.send(JSON.stringify(event)); return true; }); }, []);
  async function refresh() {
    if (!session.current || ended.current || polling.current) return;
    const id = session.current, attention = voice.current;
    polling.current = true;
    try {
      const result = await api<{ operator?: OperatorContext; operatorView?: OperatorView }>(`/api/talk/sessions/${id}`, { action: 'heartbeat' }, 'PATCH');
      if (!alive.current || ended.current || session.current !== id || voice.current !== attention) return;
      attention!.heartbeat(result);
      if (result.operator) setSelected(voice.current!.context);
      if (result.operatorView) setView(result.operatorView);
    } catch (cause) { if (alive.current && session.current === id && voice.current === attention && !ended.current) setError(cause instanceof Error ? cause.message : 'Call readback is unavailable.'); }
    finally { polling.current = false; }
  }
  async function tool(name: string, args: Record<string, unknown>, callId: string) {
    const id = session.current, attention = voice.current;
    if (!id || ended.current) throw new Error('The voice connection has ended.');
    const body = await api<{ result: Record<string, unknown> }>(`/api/talk/sessions/${id}/tools`, { callId, name, arguments: args });
    if (ended.current || session.current !== id || voice.current !== attention) throw new Error('The original call ended. Track the original action receipt; do not resubmit.');
    attention!.apply(body.result);
    if (body.result.operator) setSelected(voice.current!.context);
    return body.result;
  }
  async function transcript(event: RealtimeEvent, role: 'user' | 'assistant') {
    const id = session.current, itemId = event.item_id;
    if (!id || !itemId || !event.transcript?.trim()) return;
    const segmentId = voice.current!.segment(itemId);
    try { await api(`/api/talk/sessions/${id}/events`, { realtimeItemId: itemId, role, content: event.transcript, metadata: { operatorSegmentId: segmentId } }); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'The transcript could not be saved.'); }
  }
  function event(raw: string) {
    let value: RealtimeEvent;
    try { value = JSON.parse(raw); } catch { return; }
    if (!voice.current!.observe(value)) return;
    if (value.type?.includes('input_audio_transcription.completed')) { lastSpeech.current = Date.now(); void transcript(value, 'user'); }
    if (value.type?.includes('output_audio_transcript.done')) void transcript(value, 'assistant');
    if (value.type === 'input_audio_buffer.speech_started') setStatus('Listening');
    if (value.type === 'response.created') setStatus('Speaking');
    if (value.type === 'error') setError(value.error?.message || 'The voice provider returned an error.');
    if (value.type !== 'response.done') return;
    setStatus('Listening');
    const calls = value.response?.output?.filter(item => item.type === 'function_call' && item.call_id && !queuedTools.current.has(item.call_id)) ?? [];
    for (const call of calls) queuedTools.current.add(call.call_id!);
    if (!calls.length) return;
    const id = session.current, attention = voice.current;
    const current = () => !ended.current && session.current === id && voice.current === attention;
    tools.current = tools.current.then(async () => {
      for (const call of calls) {
        if (!current()) return;
        let output: Record<string, unknown>;
        try { output = await tool(call.name!, JSON.parse(call.arguments || '{}') as Record<string, unknown>, call.call_id!); }
        catch (cause) { output = { error: cause instanceof Error ? cause.message : 'Original delivery is unconfirmed. Track it before retrying.' }; }
        if (!current()) return;
        if (!send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) } })) {
          setError('Voice output is unconfirmed. Submitted bot work retains its original receipt; do not resubmit.'); return;
        }
      }
      if (current()) attention!.respond();
    });
  }
  async function end() {
    if (ended.current) return; ended.current = true; voice.current?.close();
    const id = session.current; session.current = null;
    channel.current?.close(); pc.current?.close(); stream.current?.getTracks().forEach(track => track.stop());
    audio.current?.pause(); if (audio.current) audio.current.srcObject = null;
    if (alive.current) { setConnected(false); setStatus('Call ended — bot work continues'); }
    if (id) {
      try { const result = await api<{ operatorEnded?: boolean }>(`/api/talk/sessions/${id}`, { action: 'end', reason: 'operator-hangup' }, 'PATCH'); if (result.operatorEnded === false && alive.current) setError('Audio ended. The call record end is unconfirmed; submitted bot work was retained.'); }
      catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Call end could not be recorded. Bot work was retained.'); }
    }
  }
  async function start() {
    if (startingRef.current || session.current) return;
    voice.current = new OperatorVoiceEvents(send); queuedTools.current.clear(); tools.current = Promise.resolve();
    startingRef.current = true; setMuted(false); setStarting(true); setError(''); setStatus('Connecting'); ended.current = false;
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current || ended.current) { mic.getTracks().forEach(track => track.stop()); return; }
      stream.current = mic;
      const data = await api<Start>('/api/talk/sessions', { operator: true, botId: bot?.id ?? null });
      session.current = data.sessionId;
      if (!alive.current || ended.current) { ended.current = false; await end(); return; }
      if (!data.operator) throw new Error('The named-bot voice bridge is not active yet.');
      voice.current!.context = data.operator; setSelected(data.operator);
      const peer = new RTCPeerConnection(); pc.current = peer;
      mic.getTracks().forEach(track => peer.addTrack(track, mic));
      const speaker = new Audio(); speaker.autoplay = true; audio.current = speaker;
      peer.ontrack = value => { speaker.srcObject = value.streams[0]; void speaker.play().catch(() => { if (alive.current) setError('Tap Enable speaker to allow audio playback.'); }); };
      const dataChannel = peer.createDataChannel('oai-events'); channel.current = dataChannel;
      dataChannel.addEventListener('message', value => { if (channel.current === dataChannel && !ended.current) event(String(value.data)); });
      const opened = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The voice data channel did not open.')), 15000);
        dataChannel.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        dataChannel.addEventListener('close', () => { clearTimeout(timer); reject(new Error('The voice channel closed before connection.')); }, { once: true });
      });
      void opened.catch(() => {}); // SDP failure can occur before the data channel settles.
      const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
      const answer = await fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST', headers: { Authorization: `Bearer ${data.clientSecret}`, 'Content-Type': 'application/sdp' }, body: offer.sdp, signal: AbortSignal.timeout(15000) });
      if (!answer.ok) throw new Error('The voice provider could not connect this call.');
      await peer.setRemoteDescription({ type: 'answer', sdp: await answer.text() }); await opened;
      if (ended.current || !alive.current) return;
      lastSpeech.current = Date.now(); setConnected(true); setStatus('Listening');
      voice.current!.respond({ instructions: 'Greet exactly: Operator. If a bot is connected, briefly identify it from the confirmed context. Then listen.' });
      peer.onconnectionstatechange = () => { if (peer.connectionState === 'failed' && !ended.current) { setError('The voice connection dropped. Submitted bot work continues; track its original receipt.'); void end(); } };
      await refresh();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'The call could not start.'); await end(); }
    finally { startingRef.current = false; if (alive.current) setStarting(false); }
  }
  async function select(botId: string | null) {
    const scope = voice.current!.context;
    if (!scope || changing) return;
    setChanging(true); setError('');
    try { await tool('operator_connect_bot', { bot_id: botId, segment_id: scope.segmentId }, `ui_switch_${crypto.randomUUID()}`); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Bot switch was not confirmed.'); }
    finally { setChanging(false); }
  }
  async function stop() {
    const scope = voice.current!.context;
    if (!scope?.bot) return;
    try { await tool('operator_stop_bot', { segment_id: scope.segmentId }, `ui_stop_${crypto.randomUUID()}`); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Stop is unconfirmed.'); }
  }
  const cleanup = useRef<null | (() => Promise<void>)>(null);
  useEffect(() => { cleanup.current = end; });
  useEffect(() => {
    alive.current = true;
    const timer = setInterval(() => { if (session.current && Date.now() - lastSpeech.current > 15 * 60000) void cleanup.current?.(); else void refresh(); }, 10000);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    const key = (value: KeyboardEvent) => {
      if (value.key === 'Escape') { value.preventDefault(); void cleanup.current?.().then(onClose); }
      if (value.key !== 'Tab') return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]') ?? [])].filter(node => node.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (value.shiftKey && document.activeElement === first) { value.preventDefault(); last?.focus(); }
      else if (!value.shiftKey && document.activeElement === last) { value.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { alive.current = false; clearInterval(timer); document.removeEventListener('keydown', key); void cleanup.current?.(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  // All call lifetime state is held in refs. This effect owns teardown once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const active = !!selected && connected;
  return <div className="operator-backdrop"><section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="operator-title" className="operator-dialog">
    <header><div><span className="operator-muted">Voice</span><h2 id="operator-title">{selected?.bot?.name ?? bot?.name ?? 'Operator'}</h2></div><button className="bots-icon-button" aria-label="Close call" onClick={() => void end().then(onClose)}><X size={20} /></button></header>
    <div className="operator-status" role="status"><span className={active ? 'is-connected' : ''} />{status}</div>
    {error && <div role="alert" className="operator-error">{error}{error.includes("Enable speaker") && <button onClick={() => void audio.current?.play()}>Enable speaker</button>}</div>}
    {active && <label className="operator-route">Connected to<select value={selected.bot?.id ?? ''} disabled={changing} onChange={value => void select(value.target.value || null)}><option value="">Operator</option>{bots.map(value => <option key={value.id} value={value.id}>{value.name}{value.extension ? ` · #${value.extension}` : ''}</option>)}</select></label>}
    <div className="operator-controls">
      {!active ? <button disabled={starting} onClick={() => void start()}><Phone size={18} />{starting ? 'Connecting…' : 'Start call'}</button> : <>
        <button aria-pressed={muted} onClick={() => { const next = !muted; stream.current?.getAudioTracks().forEach(track => { track.enabled = !next; }); setMuted(next); }}>{muted ? <MicOff size={18} /> : <Mic size={18} />}{muted ? 'Unmute' : 'Mute'}</button>
        <button onClick={() => send({ type: 'response.cancel' })}><VolumeX size={18} />Stop speaking</button>
        {selected.bot && <button className="operator-stop" onClick={() => void stop()}><Square size={16} />Stop bot</button>}
        <button onClick={() => void end()}><PhoneOff size={18} />Hang up</button>
      </>}
    </div>
    <p className="operator-muted operator-call-note">Bot work stays in its conversation and continues after the call. Stop bot pauses automatic intake.</p>
    {selected && <OperatorQuestionContext context={selected} />}
    <div className="operator-segments">{view?.segments.map(segment => <OperatorCallCard key={segment.id} segment={segment} />)}</div>
  </section></div>;
}
