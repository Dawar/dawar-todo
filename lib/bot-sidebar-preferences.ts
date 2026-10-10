export const MAX_SIDEBAR_TEAMS = 256;
export type SidebarChoice = { teamId: string; collapsed: boolean; revision: number };
export type SidebarChoiceMutation = { teamId: string; collapsed: boolean; expectedRevision: number; operationId: string };
export type SidebarChoicesResponse = { version: 1; owner: string; choices: SidebarChoice[] };
export type SidebarChoiceReceipt = { version: 1; owner: string; operationId: string; applied: boolean; choice: SidebarChoice };
const id = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,100}$/.test(value);
const revision = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000_000;
export function sidebarChoice(value: unknown): value is SidebarChoice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as SidebarChoice;
  return id(v.teamId) && typeof v.collapsed === 'boolean' && revision(v.revision);
}
export function sidebarMutation(value: unknown): value is SidebarChoiceMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as SidebarChoiceMutation;
  return Object.keys(v).length === 4 && id(v.teamId) && typeof v.collapsed === 'boolean' && revision(v.expectedRevision) && v.expectedRevision < 1_000_000_000 && id(v.operationId);
}
