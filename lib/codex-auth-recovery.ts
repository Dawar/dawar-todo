export const isCodexAuthError = (value: unknown): boolean => typeof value === 'string' && /access token could not be refreshed|refresh token (?:has already been used|is invalid|expired)|refresh_token_(?:reused|invalidated)|not authenticated with (?:chatgpt|codex)/i.test(value);
export type CodexAuthRecoveryState = {
  status: 'unknown' | 'connected' | 'needs-sign-in' | 'starting' | 'pending' | 'unconfirmed' | 'verify' | 'expired' | 'cancelled';
  recovered?: boolean; checkedAt?: string; loginId?: string | null;
  verificationUrl?: string; userCode?: string; expiresAt?: number;
};
