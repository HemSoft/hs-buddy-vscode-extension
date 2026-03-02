// ─── Model Info ────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  family: string;
  vendor: string;
  multiplier?: string;
  multiplierNumeric?: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

// ─── Transcript Events (all 7 types) ──────────────────────

export type TranscriptEventType =
  | 'session.start'
  | 'user.message'
  | 'assistant.turn_start'
  | 'assistant.message'
  | 'assistant.turn_end'
  | 'tool.execution_start'
  | 'tool.execution_complete';

/** Raw JSONL line from a Copilot transcript */
export interface RawTranscriptEvent {
  type: TranscriptEventType;
  data: Record<string, unknown>;
  id: string;
  timestamp: string;
  parentId: string | null;
}

// ─── Parsed Events (structured) ──────────────────────────

export interface SessionStartEvent {
  type: 'session.start';
  id: string;
  timestamp: number;
  sessionId: string;
  copilotVersion: string;
  vscodeVersion: string;
}

export interface UserMessageEvent {
  type: 'user.message';
  id: string;
  timestamp: number;
  content: string;
  contentLength: number;
}

export interface AssistantTurnStartEvent {
  type: 'assistant.turn_start';
  id: string;
  timestamp: number;
  turnId: string;
}

export interface AssistantMessageEvent {
  type: 'assistant.message';
  id: string;
  timestamp: number;
  content: string;
  contentLength: number;
  reasoningLength: number;
  toolRequests: ToolRequest[];
}

export interface ToolRequest {
  toolCallId: string;
  name: string;
  argumentsLength: number;
}

export interface AssistantTurnEndEvent {
  type: 'assistant.turn_end';
  id: string;
  timestamp: number;
  turnId: string;
}

export interface ToolExecutionStartEvent {
  type: 'tool.execution_start';
  id: string;
  timestamp: number;
  toolCallId: string;
  toolName: string;
}

export interface ToolExecutionCompleteEvent {
  type: 'tool.execution_complete';
  id: string;
  timestamp: number;
  toolCallId: string;
  success: boolean;
}

export type ParsedEvent =
  | SessionStartEvent
  | UserMessageEvent
  | AssistantTurnStartEvent
  | AssistantMessageEvent
  | AssistantTurnEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionCompleteEvent;

// ─── Turn (a sequence of model → tool calls → model) ─────

export interface Turn {
  turnId: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  assistantContentLength: number;
  assistantReasoningLength: number;
  toolCalls: ToolCallRecord[];
}

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  argumentsLength: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  success: boolean;
}

// ─── Session (full parsed session) ────────────────────────

export interface CopilotSession {
  sessionId: string;
  title: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  model: ModelInfo | null;
  /** Source workspace storage hash */
  workspaceHash: string;

  // Exact counts
  promptCount: number;
  responseCount: number;
  turnCount: number;
  toolCallCount: number;
  toolsUsed: string[];
  toolCallSuccessCount: number;
  toolCallFailureCount: number;

  // Character counts
  inputChars: number;
  outputChars: number;
  reasoningChars: number;
  toolArgChars: number;

  // Estimated token counts (via vscode.lm.countTokens or fallback)
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;

  // Real token counts (from chatSessions API data)
  promptTokens: number;
  outputTokens: number;

  // Data source format
  source: 'chatSessions' | 'transcripts';

  // Code stats (from session store enrichment)
  linesAdded: number;
  linesRemoved: number;
  filesModified: number;

  // Structured turn data
  turns: Turn[];

  // All parsed events for this session
  events: ParsedEvent[];
}

// ─── Aggregate Totals (persisted) ─────────────────────────

export interface SessionTotals {
  totalSessions: number;
  totalPrompts: number;
  totalResponses: number;
  totalTurns: number;
  totalToolCalls: number;
  totalToolCallSuccesses: number;
  totalToolCallFailures: number;
  totalInputChars: number;
  totalOutputChars: number;
  totalReasoningChars: number;
  totalToolArgChars: number;
  totalEstimatedInputTokens: number;
  totalEstimatedOutputTokens: number;
  totalEstimatedTotalTokens: number;
  totalPromptTokens: number;
  totalOutputTokens: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalFilesModified: number;
  totalDuration: number;
  modelUsage: Record<string, number>;
  toolUsage: Record<string, number>;
  lastScanTime: number;
  processedSessionIds: string[];
}

// ─── Session Store Entry (from workspace state.vscdb) ─────

export interface SessionStoreEntry {
  sessionId: string;
  title: string;
  lastMessageDate: number;
  timing: {
    created: number;
    lastRequestStarted?: number;
    lastRequestEnded?: number;
  };
  hasPendingEdits: boolean;
  isEmpty: boolean;
  isExternal: boolean;
  stats?: {
    fileCount: number;
    added: number;
    removed: number;
  };
  lastResponseState: number;
}

// ─── Interactive Session Memento (from workspace state.vscdb)

export interface InteractiveSessionEntry {
  inputText: string;
  attachments: unknown[];
  mode: { id: string; kind: string };
  selectedModel?: {
    identifier: string;
    metadata: {
      id: string;
      vendor: string;
      name: string;
      family: string;
      version: string;
      multiplier: string;
      multiplierNumeric: number;
      maxInputTokens: number;
      maxOutputTokens: number;
    };
  };
}

// ─── ChatSession Incremental Update ──────────────────────

export interface ChatSessionIncrement {
  sessionInit?: {
    sessionId: string;
    creationDate: number;
    model: ModelInfo | null;
  };
  titleUpdate?: string;
  completedResults: {
    promptTokens: number;
    outputTokens: number;
    totalElapsedMs: number;
    toolCallCount: number;
    toolNames: string[];
  }[];
  newRequestCount: number;
}
