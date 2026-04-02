export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ModelUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  messages: number;
}

export interface SessionStats {
  sessionId: string;
  totalInput: number;
  totalOutput: number;
  totalCacheCreation: number;
  totalCacheRead: number;
  messageCount: number;
  subagentInput: number;
  subagentOutput: number;
  subagentCacheCreation: number;
  subagentCacheRead: number;
  subagentMessageCount: number;
  lastUpdated: Date;
  // Current context = last message's input + cache_read + cache_creation (full context sent)
  lastInputTokens: number;
  lastCacheReadTokens: number;
  lastCacheCreationTokens: number;
  // Cost tracking: per-model usage breakdown
  modelUsage: Record<string, ModelUsage>;
}

export interface SessionMeta {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: string;
  entrypoint: string;
}

export interface JournalEntry {
  type: string;
  message?: {
    usage?: TokenUsage;
    model?: string;
    [key: string]: unknown;
  };
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  [key: string]: unknown;
}

export function emptyStats(sessionId: string): SessionStats {
  return {
    sessionId,
    totalInput: 0,
    totalOutput: 0,
    totalCacheCreation: 0,
    totalCacheRead: 0,
    messageCount: 0,
    subagentInput: 0,
    subagentOutput: 0,
    subagentCacheCreation: 0,
    subagentCacheRead: 0,
    subagentMessageCount: 0,
    lastUpdated: new Date(),
    lastInputTokens: 0,
    lastCacheReadTokens: 0,
    lastCacheCreationTokens: 0,
    modelUsage: {},
  };
}
