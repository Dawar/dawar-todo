import type { TurnPlanStep } from './codex-protocol/v2/TurnPlanStep';

/** Display-only native notification snapshot; never a proposal or checklist. */
export type NativeWorkPlan = {
  steps: TurnPlanStep[]; explanation: string | null;
  totalSteps: number; completedSteps: number; complete: boolean;
};
const bytes = (value: string) => new TextEncoder().encode(value).length;
function prefix(value: string, limit: number): string {
  if (bytes(value) <= limit) return value;
  let low = 0, high = Math.min(value.length, limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(value.slice(0, middle)) <= limit) low = middle; else high = middle - 1;
  }
  // Do not leave a split surrogate in a bounded preview.
  if (low && /[\uD800-\uDBFF]/.test(value[low - 1])) low--;
  return value.slice(0, low);
}
export function nativeWorkPlan(plan: unknown, explanation: unknown, bounded = true): NativeWorkPlan | null {
  if (!Array.isArray(plan) || !plan.every(p => p && typeof p.step === 'string' && ['pending', 'inProgress', 'completed'].includes(p.status)) || explanation != null && typeof explanation !== 'string') return null;
  const text = typeof explanation === 'string' ? explanation : null;
  if (!plan.length && !text?.trim()) return null;
  let remaining = bounded ? 6000 : Infinity, complete = true;
  const take = (value: string, limit = remaining) => {
    const clipped = bounded ? prefix(value, Math.min(limit, remaining)) : value;
    remaining -= bytes(clipped); if (clipped !== value) complete = false; return clipped;
  };
  const previewExplanation = text === null ? null : take(text, bounded ? 2048 : Infinity);
  const steps: TurnPlanStep[] = [];
  for (const step of plan) {
    if (bounded && (steps.length >= 32 || remaining <= 0)) { complete = false; break; }
    steps.push({ step: take(step.step), status: step.status });
  }
  return { steps, explanation: previewExplanation, totalSteps: plan.length,
    completedSteps: plan.filter(p => p.status === 'completed').length, complete };
}
/** Stored only in the existing ephemeral live-supplement lane. */
export function workPlanSource(plan: unknown, explanation: unknown): string {
  return JSON.stringify({ version: 1, plan, explanation: explanation ?? null });
}
export function readWorkPlanSource(text: string): NativeWorkPlan | null {
  const source = JSON.parse(text) as { version?: number; plan?: unknown; explanation?: unknown };
  if (source.version !== 1) throw Error('This live Work plan snapshot is unavailable. Its native proposal remains separate.');
  return nativeWorkPlan(source.plan, source.explanation, false);
}
