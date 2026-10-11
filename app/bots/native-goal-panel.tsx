'use client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/native-select';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Target, RefreshCw, Pause, Play, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Bot, BotSnapshot } from './single-thread-contract';
import type { BotAdmissionWork } from '../../lib/bot-work-view';
import type { BotOperations } from '../../lib/bots-operations';
import { botsClient as client } from './client';
import { useRunAction } from './run-action';
import { goalControlBlock, goalFingerprint, goalLabels, goalObservation, goalScope, goalTime } from './native-goal-state';
import './native-goal.css';

type Props = { owner: string; bot: Bot; work?: BotAdmissionWork; online: boolean; snapshot?: BotSnapshot | null };
type Form = { kind: 'edit' | 'create' | 'clear'; fingerprint: string; objective: string; budgetMode: 'keep' | 'set' | 'remove'; budget: string };
export function GoalIndicator({ bot, work, onOpen }: { bot: Bot; work?: BotAdmissionWork; onOpen: () => void }) {
  const goal = goalObservation(bot, work).goal;
  return <Button variant="ghost" size="icon" className="bots-goal-indicator" type="button" aria-label={`Goals${goal ? `: ${goalLabels[goal.status]}` : ''}`} onClick={onOpen} title="Goal"><Target size={17} aria-hidden="true" />{goal && <span className={`bots-goal-dot is-${goal.status}`} aria-hidden="true" />}</Button>;
}
export function NativeGoalPanel({ owner, bot, work, online, snapshot }: Props) {
  const action = useRunAction(owner, bot.id, goalScope(bot.threadId)), id = useId();
  const mainStop = useRunAction(owner, bot.id, 'stop:main'), allStop = useRunAction(owner, bot.id, 'stop:all'), intakeResume = useRunAction(owner, bot.id, 'work:resume');
  const [form, setForm] = useState<Form | null>(null), [error, setError] = useState(''), [refreshing, setRefreshing] = useState(false), [clock, setClock] = useState(() => Date.now());
  const heading = useRef<HTMLHeadingElement>(null), objectiveInput = useRef<HTMLTextAreaElement>(null), budgetInput = useRef<HTMLInputElement>(null);
  const [invalidField, setInvalidField] = useState<'objective' | 'budget' | null>(null);
  const scope = JSON.stringify([owner, bot.id, bot.threadId]), currentScope = useRef(scope), refreshGeneration = useRef(0);
  useLayoutEffect(() => { currentScope.current = scope; return () => { currentScope.current = ''; }; }, [scope]);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => () => { refreshGeneration.current++; }, [scope]);
  const observed = goalObservation(bot, work, clock), goal = observed.goal;
  const supported = snapshot?.capabilities?.nativeGoals === 1 && bot.executionMode === 'single-thread';
  const savedControl = [mainStop, allStop, intakeResume].some(value => value.intent || value.busy || !value.ready);
  const block = savedControl ? 'Confirm saved Stop or automatic-intake controls before changing the goal.' : goalControlBlock(snapshot, bot, online, clock), locked = Boolean(block || action.intent || action.busy || !action.ready || refreshing || client.owner !== owner);
  const fingerprint = goalFingerprint(bot, work);
  const stillHere = () => currentScope.current === scope && client.owner === owner && client.snapshot?.bots.some(value => value.id === bot.id && value.threadId === bot.threadId);
  const fresh = () => {
    const latest = client.snapshot?.bots.find(value => value.id === bot.id);
    if (!stillHere() || !latest) throw Error('The selected conversation changed. No goal action was sent.');
    const reason = goalControlBlock(client.snapshot, latest, client.online);
    if (reason) throw Error(reason);
    if (goalFingerprint(latest, client.snapshot?.workByBot?.find(value => value.botId === bot.id)) !== (form?.fingerprint ?? fingerprint)) throw Error('The native goal changed. Close this editor and review the latest goal before making a change.');
  };
  const perform = async (method: 'goals.set' | 'goals.clear', params: BotOperations['goals.set']['params'] = {}) => {
    try {
      fresh(); setError(''); setInvalidField(null);
      await action.perform(method, params);
      if (stillHere()) { setForm(null); heading.current?.focus({ preventScroll: true }); }
    } catch (reason) { if (stillHere()) setError(reason instanceof Error ? reason.message : 'Goal action is unconfirmed.'); }
  };
  const refresh = async () => {
    if (refreshing || !online || !supported || !bot.threadId || client.owner !== owner || action.busy) return;
    const generation = ++refreshGeneration.current;
    setRefreshing(true); setError('');
    try {
      // Explicit user read only. The bridge fences this observation against
      // newer native events; snapshot refresh retains the client's seq fences.
      await client.rpc('goals.read', bot.id, {}, undefined, { owner, managed: true });
      if (generation !== refreshGeneration.current || !stillHere()) return;
      await client.refresh();
      if (generation === refreshGeneration.current && stillHere()) setClock(Date.now());
    } catch (reason) { if (generation === refreshGeneration.current && stillHere()) setError(reason instanceof Error ? reason.message : 'The native goal could not be refreshed.'); }
    finally { if (generation === refreshGeneration.current && stillHere()) setRefreshing(false); }
  };
  const open = (kind: Form['kind']) => { setError(''); setInvalidField(null); setForm({ kind, fingerprint, objective: goal?.objective ?? '', budgetMode: 'keep', budget: goal?.tokenBudget?.toString() ?? '' }); };
  const cancel = () => { setForm(null); setInvalidField(null); setError(''); heading.current?.focus({ preventScroll: true }); };
  const submit = (event: React.FormEvent) => {
    event.preventDefault(); if (!form || locked) return;
    const objective = form.objective.trim();
    if (!objective || objective.length > 4000) { setError('Enter an objective of 1–4,000 characters.'); setInvalidField('objective'); objectiveInput.current?.focus(); return; }
    const params: BotOperations['goals.set']['params'] = { objective, ...(form.kind === 'create' ? { status: 'active' } : {}) };
    if (form.budgetMode === 'set') {
      const budget = Number(form.budget);
      if (!/^\d+$/.test(form.budget) || !Number.isSafeInteger(budget) || budget <= 0) { setError('Enter a positive whole-number token budget.'); setInvalidField('budget'); budgetInput.current?.focus(); return; }
      params.tokenBudget = budget;
    } else if (form.budgetMode === 'remove') params.tokenBudget = null;
    void perform('goals.set', params);
  };
  const resume = goal && ['paused', 'blocked', 'usageLimited', 'budgetLimited'].includes(goal.status);
  const budgetBlocked = goal?.status === 'budgetLimited' && (goal.tokenBudget === undefined || goal.tokensUsed === undefined || goal.tokenBudget !== null && goal.tokenBudget <= goal.tokensUsed);
  return <section className="bots-goal-panel" aria-labelledby={`${id}-title`}>
    <header><div><Target size={20} aria-hidden="true" /><h3 ref={heading} tabIndex={-1} id={`${id}-title`}>Goal</h3></div><Button variant="outline" type="button" disabled={!supported || !online || !bot.threadId || bot.archived || refreshing || action.busy || client.owner !== owner} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden="true" />{refreshing ? 'Refreshing…' : 'Refresh'}</Button></header>
    {!supported ? <p>Goals are unavailable on this service.</p> : <>
      <p className="bots-goal-description">An objective for this conversation, carried across turns.</p>
      {goal ? <>
        <span className={`bots-goal-state is-${goal.status}`} role="status">{goalLabels[goal.status]}</span>
        <p className="bots-goal-objective">{goal.objective.length <= 360 ? goal.objective : `${goal.objective.slice(0, 360)}…`}</p>
        {goal.objective.length > 360 && <details><summary>Full objective</summary><p className="bots-goal-objective">{goal.objective}</p></details>}
        <dl className="bots-goal-accounting"><div><dt>Tokens used</dt><dd>{goal.tokensUsed === undefined ? 'Unavailable' : goal.tokensUsed.toLocaleString()}</dd></div><div><dt>Token budget</dt><dd>{goal.tokenBudget === undefined ? 'Unavailable' : goal.tokenBudget === null ? 'No token budget' : goal.tokenBudget.toLocaleString()}</dd></div><div><dt>Time used</dt><dd>{goalTime(goal.timeUsedSeconds)}</dd></div></dl>
        {goal.status === 'blocked' && <p>Review the conversation before resuming this blocked goal.</p>}
        {goal.status === 'usageLimited' && <p>Codex paused this goal for usage limits. Resume deliberately when usage is available.</p>}
        {goal.status === 'budgetLimited' && <p>The goal reached its token budget. Edit or remove that budget, then explicitly resume.</p>}
        {goal.status === 'complete' && <p>Codex reports this objective complete.</p>}
      </> : <p className="bots-goal-empty">{observed.known ? 'No goal in this conversation.' : 'Goal state has not been confirmed. Refresh to read the native objective.'}</p>}
      <p className="bots-goal-observation">{!online ? 'Offline · last saved status' : observed.stale ? 'Status may be out of date' : 'Updated'}{observed.observedAt && <> · <time dateTime={observed.observedAt}>{new Date(observed.observedAt).toLocaleString()}</time></>}</p>
      {block && <p className="bots-goal-hint" role="status">{block}</p>}
      {!form && <div className="bots-goal-actions">
        {!goal && <Button variant="outline" type="button" disabled={locked || !observed.known} onClick={() => open('create')}><Plus size={15} />Create goal</Button>}
        {goal && <><Button variant="outline" type="button" disabled={locked} onClick={() => open('edit')}><Pencil size={15} />Edit</Button>{goal.status === 'active' && <Button variant="outline" type="button" disabled={locked} onClick={() => void perform('goals.set', { status: 'paused' })}><Pause size={15} />Pause goal</Button>}{resume && <Button variant="outline" type="button" disabled={locked || Boolean(budgetBlocked)} onClick={() => void perform('goals.set', { status: 'active' })}><Play size={15} />Resume goal</Button>}<Button variant="outline" type="button" disabled={locked} onClick={() => open('clear')}><Trash2 size={15} />Clear</Button></>}
      </div>}
      {form?.kind === 'clear' ? <div className="bots-goal-confirm" role="group" aria-label="Confirm clearing goal"><p>Clear this goal? This removes the current objective from the conversation. It does not stop a running turn or change automatic intake.</p><Button variant="destructive" type="button" disabled={locked} onClick={() => void perform('goals.clear')}>Clear goal</Button><Button variant="outline" type="button" autoFocus disabled={action.busy} onClick={cancel}>Cancel</Button></div> : form && <form onSubmit={submit} className="bots-goal-form">
        <label htmlFor={`${id}-objective`}>Objective</label><Textarea ref={objectiveInput} aria-invalid={invalidField === 'objective' || undefined} aria-describedby={invalidField === 'objective' ? `${id}-error` : undefined} id={`${id}-objective`} value={form.objective} maxLength={4000} rows={5} disabled={action.busy || Boolean(action.intent)} onChange={event => { setForm({ ...form, objective: event.target.value }); if (invalidField === 'objective') { setInvalidField(null); setError(''); } }} autoFocus />
        {invalidField === 'objective' && <p id={`${id}-error`} className="bots-goal-error" role="alert">{error}</p>}
        <label htmlFor={`${id}-budget-mode`}>Token budget</label><NativeSelect id={`${id}-budget-mode`} disabled={action.busy || Boolean(action.intent)} value={form.budgetMode} onChange={event => { setForm({ ...form, budgetMode: event.target.value as Form['budgetMode'] }); if (invalidField === 'budget') { setInvalidField(null); setError(''); } }}><option value="keep">{form.kind === 'create' ? 'No token budget' : 'Keep current budget'}</option><option value="set">Set a token budget</option>{form.kind === 'edit' && <option value="remove">Remove token budget</option>}</NativeSelect>
        {form.budgetMode === 'set' && <><label htmlFor={`${id}-budget`}>Maximum tokens</label><Input ref={budgetInput} aria-invalid={invalidField === 'budget' || undefined} aria-describedby={invalidField === 'budget' ? `${id}-error` : undefined} id={`${id}-budget`} inputMode="numeric" pattern="[0-9]+" value={form.budget} disabled={action.busy || Boolean(action.intent)} onChange={event => { setForm({ ...form, budget: event.target.value }); if (invalidField === 'budget') { setInvalidField(null); setError(''); } }} />{invalidField === 'budget' && <p id={`${id}-error`} className="bots-goal-error" role="alert">{error}</p>}</>}
        {form.kind === 'create' && <p>Creating an active goal allows Codex to continue it when the native thread is eligible.</p>}
        <div className="bots-goal-actions"><Button type="submit" disabled={locked}>{form.kind === 'create' ? 'Create goal' : 'Save changes'}</Button><Button variant="outline" type="button" disabled={action.busy} onClick={cancel}>Cancel</Button></div>
      </form>}
      {!action.intent && action.accepted && <p className="bots-goal-observation" role="status">Goal change confirmed.</p>}
    </>}
    {action.intent && <div className="bots-goal-recovery" role="status"><p>A goal change is awaiting confirmation.</p><Button variant="outline" type="button" disabled={Boolean(block) || !online || action.busy || refreshing || client.owner !== owner} onClick={() => void action.retry().catch(() => {})}>{action.busy ? 'Checking…' : 'Check goal change'}</Button></div>}
    {!invalidField && (error || action.error) && <p id={`${id}-error`} className="bots-goal-error" role="alert">{error || action.error}</p>}
  </section>;
}
