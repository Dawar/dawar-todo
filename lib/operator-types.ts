export type OperatorBot = { id: string; name: string; avatar?: unknown; extension?: number; purpose?: string };
export type OperatorInputQuestion = {
  key: string; requestId: string; threadId: string; turnId: string; itemId: string; version: string;
  kind: 'blocking' | 'async'; isBlocking: boolean; createdAt: string; answerState: string; voiceAnswerable: boolean;
  questions: Array<{ id: string; header: string; question: string; isOther: boolean; isSecret: boolean;
    options: Array<{ label: string; description: string }> | null }>;
};
export type OperatorContext = {
  callId: string; segmentId: string; bot: OperatorBot | null;
  activity: { state: string; paused: boolean; activeTurnId: string | null; goal?: { objective: string; status: string } | null } | null;
  reference?: Record<string, string>;
  recent: Array<{ role: string; text: string }>;
  observedAt?: string;
  selectionRevision?: number;
  pendingQuestions?: OperatorInputQuestion[];
  progress?: Array<{ id: string; turnId: string; text: string; phase?: string | null }>;
};
export type OperatorRequest = {
  id: string; callId: string; segmentId: string; bot: OperatorBot; text: string; createdAt: string;
  nativeOperationId: string; turnId: string | null; state: string; error: string | null; paused: boolean;
  progress: Array<{ id: string; text: string; phase: string | null }>;
  results: Array<{ id: string; text: string; phase: string | null }>;
  questions: Array<{ key: string; method: string; params: { questions?: Array<{ id: string; question: string; options?: Array<{ label: string }> }> } }>;
};
export type OperatorSegment = {
  id: string; callId: string; botId: string | null; bot: OperatorBot | null; createdAt: string; endedAt?: string | null;
  requests: OperatorRequest[];
  transcriptCursor?: string | null; requestCursor?: string | null;
  transcript: Array<{ id: string; role: string; content: string; createdAt: string }>;
};
export type OperatorView = { callId: string; segmentId: string; endedAt: string | null; segments: OperatorSegment[]; requests: OperatorRequest[] };
