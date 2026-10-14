export type SubmissionSource =
  | { kind: 'unknown' }
  | { kind: 'user' | 'system'; id: string; name: string }
  | { kind: 'bot'; id: string; name: string; color?: string; avatar?: string };
export type SubmissionAttribution = { submissionId: string; source: SubmissionSource; replyToSubmissionId?: string | null };
export type SubmissionSourceResult = SubmissionAttribution & { native: { threadId: string; turnId: string; itemId: string; clientId: string } | null };
