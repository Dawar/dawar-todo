import { isCodexAuthError } from './codex-auth-recovery.ts';

export type NativeRecoveryKind = 'external-writer' | 'native-sign-in' | 'native-system-error' | 'native-state';
export type NativeRecoveryObservation = { kind: NativeRecoveryKind; checkedAt: string; retryAt: string | null };

// Classify only errors from the native current-state reconciliation path.
// Message text and historical operation failures do not establish ownership.
export function nativeRecoveryKind(error: unknown): NativeRecoveryKind {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/already has an active writer|thread.*(?:has|held by|owned by).*another.*writer/i.test(text)) return 'external-writer';
  if (isCodexAuthError(text)) return 'native-sign-in';
  if (/Codex reports a thread system error/i.test(text)) return 'native-system-error';
  return 'native-state';
}
