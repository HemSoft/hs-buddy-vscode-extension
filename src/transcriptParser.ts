import * as fs from 'fs';
import * as path from 'path';
import type {
  RawTranscriptEvent,
  ParsedEvent,
  SessionStartEvent,
  UserMessageEvent,
  AssistantTurnStartEvent,
  AssistantMessageEvent,
  AssistantTurnEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionCompleteEvent,
  ToolRequest,
  CopilotSession,
  Turn,
  ToolCallRecord,
} from './types';

// ─── Event Parsing ────────────────────────────────────────

function parseRawEvent(raw: RawTranscriptEvent): ParsedEvent | null {
  const ts = new Date(raw.timestamp).getTime();

  switch (raw.type) {
    case 'session.start': {
      const d = raw.data as { sessionId?: string; copilotVersion?: string; vscodeVersion?: string };
      return {
        type: 'session.start',
        id: raw.id,
        timestamp: ts,
        sessionId: d.sessionId ?? '',
        copilotVersion: d.copilotVersion ?? '',
        vscodeVersion: d.vscodeVersion ?? '',
      } satisfies SessionStartEvent;
    }

    case 'user.message': {
      const d = raw.data as { content?: string };
      const content = d.content ?? '';
      return {
        type: 'user.message',
        id: raw.id,
        timestamp: ts,
        content,
        contentLength: content.length,
      } satisfies UserMessageEvent;
    }

    case 'assistant.turn_start': {
      const d = raw.data as { turnId?: string };
      return {
        type: 'assistant.turn_start',
        id: raw.id,
        timestamp: ts,
        turnId: d.turnId ?? '0',
      } satisfies AssistantTurnStartEvent;
    }

    case 'assistant.message': {
      const d = raw.data as {
        content?: string;
        reasoningText?: string;
        toolRequests?: { toolCallId?: string; name?: string; arguments?: string }[];
      };
      const content = d.content ?? '';
      const reasoning = d.reasoningText ?? '';
      const toolRequests: ToolRequest[] = (d.toolRequests ?? []).map(tr => ({
        toolCallId: tr.toolCallId ?? '',
        name: tr.name ?? '',
        argumentsLength: (tr.arguments ?? '').length,
      }));

      return {
        type: 'assistant.message',
        id: raw.id,
        timestamp: ts,
        content,
        contentLength: content.length,
        reasoningLength: reasoning.length,
        toolRequests,
      } satisfies AssistantMessageEvent;
    }

    case 'assistant.turn_end': {
      const d = raw.data as { turnId?: string };
      return {
        type: 'assistant.turn_end',
        id: raw.id,
        timestamp: ts,
        turnId: d.turnId ?? '0',
      } satisfies AssistantTurnEndEvent;
    }

    case 'tool.execution_start': {
      const d = raw.data as { toolCallId?: string; toolName?: string };
      return {
        type: 'tool.execution_start',
        id: raw.id,
        timestamp: ts,
        toolCallId: d.toolCallId ?? '',
        toolName: d.toolName ?? '',
      } satisfies ToolExecutionStartEvent;
    }

    case 'tool.execution_complete': {
      const d = raw.data as { toolCallId?: string; success?: boolean };
      return {
        type: 'tool.execution_complete',
        id: raw.id,
        timestamp: ts,
        toolCallId: d.toolCallId ?? '',
        success: d.success ?? false,
      } satisfies ToolExecutionCompleteEvent;
    }

    default:
      return null;
  }
}

// ─── Turn Assembly ────────────────────────────────────────

function assembleSessionTurns(events: ParsedEvent[]): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: Partial<Turn> | null = null;
  const toolStartMap = new Map<string, ToolExecutionStartEvent>();

  for (const evt of events) {
    switch (evt.type) {
      case 'assistant.turn_start':
        currentTurn = {
          turnId: evt.turnId,
          startTime: evt.timestamp,
          endTime: 0,
          durationMs: 0,
          assistantContentLength: 0,
          assistantReasoningLength: 0,
          toolCalls: [],
        };
        break;

      case 'assistant.message':
        if (currentTurn) {
          currentTurn.assistantContentLength =
            (currentTurn.assistantContentLength ?? 0) + evt.contentLength;
          currentTurn.assistantReasoningLength =
            (currentTurn.assistantReasoningLength ?? 0) + evt.reasoningLength;
        }
        break;

      case 'tool.execution_start':
        toolStartMap.set(evt.toolCallId, evt);
        break;

      case 'tool.execution_complete': {
        const start = toolStartMap.get(evt.toolCallId);
        if (currentTurn && start) {
          const tc: ToolCallRecord = {
            toolCallId: evt.toolCallId,
            toolName: start.toolName,
            argumentsLength: 0,
            startTime: start.timestamp,
            endTime: evt.timestamp,
            durationMs: evt.timestamp - start.timestamp,
            success: evt.success,
          };
          currentTurn.toolCalls?.push(tc);
          toolStartMap.delete(evt.toolCallId);
        }
        break;
      }

      case 'assistant.turn_end':
        if (currentTurn) {
          currentTurn.endTime = evt.timestamp;
          currentTurn.durationMs = evt.timestamp - (currentTurn.startTime ?? 0);
          turns.push(currentTurn as Turn);
          currentTurn = null;
        }
        break;
    }
  }

  // Attach argument lengths from assistant.message toolRequests
  const argLengthMap = new Map<string, number>();
  for (const evt of events) {
    if (evt.type === 'assistant.message') {
      for (const tr of evt.toolRequests) {
        argLengthMap.set(tr.toolCallId, tr.argumentsLength);
      }
    }
  }
  for (const turn of turns) {
    for (const tc of turn.toolCalls) {
      tc.argumentsLength = argLengthMap.get(tc.toolCallId) ?? 0;
    }
  }

  return turns;
}

// ─── Session Parsing ──────────────────────────────────────

function parseTranscriptFile(filePath: string, workspaceHash: string): CopilotSession | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) {
    return null;
  }

  const events: ParsedEvent[] = [];
  for (const line of lines) {
    let raw: RawTranscriptEvent;
    try {
      raw = JSON.parse(line) as RawTranscriptEvent;
    } catch {
      continue;
    }
    const parsed = parseRawEvent(raw);
    if (parsed) {
      events.push(parsed);
    }
  }

  if (events.length === 0) {
    return null;
  }

  // Extract session-level data
  let sessionId = path.basename(filePath, '.jsonl');
  let startTime = 0;
  let endTime = 0;
  let promptCount = 0;
  let responseCount = 0;
  let inputChars = 0;
  let outputChars = 0;
  let reasoningChars = 0;
  let toolArgChars = 0;
  let toolCallCount = 0;
  let toolCallSuccessCount = 0;
  let toolCallFailureCount = 0;
  const toolsUsed = new Set<string>();

  for (const evt of events) {
    if (evt.timestamp > endTime) {
      endTime = evt.timestamp;
    }

    switch (evt.type) {
      case 'session.start':
        if (evt.sessionId) {
          sessionId = evt.sessionId;
        }
        startTime = evt.timestamp;
        break;

      case 'user.message':
        promptCount++;
        inputChars += evt.contentLength;
        break;

      case 'assistant.message':
        responseCount++;
        outputChars += evt.contentLength;
        reasoningChars += evt.reasoningLength;
        for (const tr of evt.toolRequests) {
          toolArgChars += tr.argumentsLength;
        }
        break;

      case 'tool.execution_start':
        toolCallCount++;
        if (evt.toolName) {
          toolsUsed.add(evt.toolName);
        }
        break;

      case 'tool.execution_complete':
        if (evt.success) {
          toolCallSuccessCount++;
        } else {
          toolCallFailureCount++;
        }
        break;
    }
  }

  if (startTime === 0) {
    startTime = endTime;
  }

  const turns = assembleSessionTurns(events);
  const durationMs = Math.max(0, endTime - startTime);

  return {
    sessionId,
    title: '',
    startTime,
    endTime,
    durationMs,
    model: null,
    workspaceHash,
    promptCount,
    responseCount,
    turnCount: turns.length,
    toolCallCount,
    toolsUsed: [...toolsUsed],
    toolCallSuccessCount,
    toolCallFailureCount,
    inputChars,
    outputChars,
    reasoningChars,
    toolArgChars,
    // Token estimates will be filled in by SessionTracker
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedTotalTokens: 0,
    promptTokens: 0,
    outputTokens: 0,
    source: 'transcripts',
    linesAdded: 0,
    linesRemoved: 0,
    filesModified: 0,
    turns,
    events,
  };
}

/**
 * Parse all transcript files in a workspace storage directory.
 */
export function parseWorkspaceTranscripts(workspaceStoragePath: string): CopilotSession[] {
  const transcriptsDir = path.join(workspaceStoragePath, 'GitHub.copilot-chat', 'transcripts');
  if (!fs.existsSync(transcriptsDir)) {
    return [];
  }

  const sessions: CopilotSession[] = [];
  const wsHash = path.basename(workspaceStoragePath);

  let files: string[];
  try {
    files = fs.readdirSync(transcriptsDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  for (const file of files) {
    const session = parseTranscriptFile(path.join(transcriptsDir, file), wsHash);
    if (session && session.promptCount > 0) {
      sessions.push(session);
    }
  }

  return sessions;
}

/**
 * Incrementally parse only new lines appended to a transcript file.
 * Returns new events since the given line offset.
 */
export function parseTranscriptIncremental(
  filePath: string,
  fromLineOffset: number
): { events: ParsedEvent[]; newOffset: number } {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { events: [], newOffset: fromLineOffset };
  }

  const allLines = content.split('\n').filter(l => l.trim());
  const newEvents: ParsedEvent[] = [];

  for (let i = fromLineOffset; i < allLines.length; i++) {
    let raw: RawTranscriptEvent;
    try {
      raw = JSON.parse(allLines[i]) as RawTranscriptEvent;
    } catch {
      continue;
    }
    const parsed = parseRawEvent(raw);
    if (parsed) {
      newEvents.push(parsed);
    }
  }

  return { events: newEvents, newOffset: allLines.length };
}
