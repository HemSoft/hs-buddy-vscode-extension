import * as fs from 'fs';
import * as path from 'path';
import type { CopilotSession, ModelInfo, ChatSessionIncrement } from './types';

// ─── Line Classification ──────────────────────────────────

interface LineClass {
  kind: number;
  keyPath: string[];
}

function classifyLine(line: string): LineClass | null {
  const m = line.match(/^\{"kind":(\d+)/);
  if (!m) { return null; }

  const kind = parseInt(m[1]);
  const km = line.match(/"k":\[([^\]]*)\]/);
  const keyPath = km ? parseKeyArray(km[1]) : [];

  return { kind, keyPath };
}

function parseKeyArray(raw: string): string[] {
  if (!raw.trim()) { return []; }
  return raw.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
}

// ─── Result Data Extraction ───────────────────────────────

interface ResultData {
  promptTokens: number;
  outputTokens: number;
  firstProgressMs: number;
  totalElapsedMs: number;
  toolCallCount: number;
  toolNames: string[];
}

function extractResultData(line: string): ResultData | null {
  try {
    const parsed = JSON.parse(line);
    const v = parsed.v;
    if (!v) { return null; }

    const promptTokens: number = v.metadata?.promptTokens ?? v.timings?.promptTokens ?? 0;
    const outputTokens: number = v.metadata?.outputTokens ?? v.timings?.outputTokens ?? 0;
    const firstProgressMs: number = v.timings?.firstProgress ?? 0;
    const totalElapsedMs: number = v.timings?.totalElapsed ?? 0;

    let toolCallCount = 0;
    const toolNames = new Set<string>();

    for (const round of v.metadata?.toolCallRounds ?? []) {
      for (const tc of round.toolCalls ?? []) {
        toolCallCount++;
        if (tc.name) { toolNames.add(tc.name); }
      }
    }

    return { promptTokens, outputTokens, firstProgressMs, totalElapsedMs, toolCallCount, toolNames: [...toolNames] };
  } catch {
    // Fallback to regex for oversized lines
    const pt = line.match(/"promptTokens":(\d+)/);
    const ot = line.match(/"outputTokens":(\d+)/);
    if (!pt || !ot) { return null; }
    return {
      promptTokens: parseInt(pt[1]),
      outputTokens: parseInt(ot[1]),
      firstProgressMs: 0,
      totalElapsedMs: 0,
      toolCallCount: 0,
      toolNames: [],
    };
  }
}

// ─── Init Line Extraction ─────────────────────────────────

function extractSessionInit(line: string): { sessionId: string; creationDate: number; model: ModelInfo | null } | null {
  try {
    const parsed = JSON.parse(line);
    const v = parsed.v;
    if (!v) { return null; }

    const sessionId: string = v.sessionId ?? '';
    const creationDate: number = v.creationDate ?? 0;

    let model: ModelInfo | null = null;
    const sm = v.inputState?.selectedModel?.metadata;
    if (sm) {
      model = {
        id: sm.id ?? '',
        name: sm.name ?? '',
        family: sm.family ?? '',
        vendor: sm.vendor ?? '',
        multiplier: sm.multiplier ?? '1x',
        multiplierNumeric: sm.multiplierNumeric ?? 1,
        maxInputTokens: sm.maxInputTokens ?? 0,
        maxOutputTokens: sm.maxOutputTokens ?? 0,
      };
    }

    return { sessionId, creationDate, model };
  } catch {
    const sidMatch = line.match(/"sessionId":"([^"]+)"/);
    const cdMatch = line.match(/"creationDate":(\d+)/);
    return {
      sessionId: sidMatch?.[1] ?? '',
      creationDate: cdMatch ? parseInt(cdMatch[1]) : 0,
      model: null,
    };
  }
}

// ─── Title Extraction ─────────────────────────────────────

function extractTitle(line: string): string | null {
  const m = line.match(/"v":"((?:[^"\\]|\\.)*)"/);
  return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null;
}

// ─── Process a Single Line ────────────────────────────────

function processLine(line: string, increment: ChatSessionIncrement): void {
  const cls = classifyLine(line);
  if (!cls) { return; }

  if (cls.kind === 0) {
    // Session initialization
    const init = extractSessionInit(line);
    if (init) { increment.sessionInit = init; }
  } else if (cls.kind === 1 && cls.keyPath.length === 1 && cls.keyPath[0] === 'customTitle') {
    // Title update
    const title = extractTitle(line);
    if (title) { increment.titleUpdate = title; }
  } else if (cls.kind === 1 && cls.keyPath.length === 3 && cls.keyPath[2] === 'result') {
    // Request result with real token counts
    const result = extractResultData(line);
    if (result) {
      increment.completedResults.push(result);
    }
  } else if (cls.kind === 2 && cls.keyPath.length === 1 && cls.keyPath[0] === 'requests') {
    // New user request
    increment.newRequestCount++;
  }
}

// ─── Full File Parser ─────────────────────────────────────

export interface ChatSessionParseResult {
  session: CopilotSession | null;
  totalLines: number;
}

export function parseChatSessionFile(filePath: string, workspaceHash: string): ChatSessionParseResult {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { session: null, totalLines: 0 };
  }

  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) {
    return { session: null, totalLines: 0 };
  }

  // Build increment from all lines
  const increment: ChatSessionIncrement = { completedResults: [], newRequestCount: 0 };
  for (const line of lines) {
    processLine(line, increment);
  }

  // Skip empty sessions (no requests)
  if (increment.newRequestCount === 0) {
    return { session: null, totalLines: lines.length };
  }

  // Build session from accumulated data
  const init = increment.sessionInit;
  const sessionId = init?.sessionId ?? path.basename(filePath, '.jsonl');
  const creationDate = init?.creationDate ?? 0;
  const model = init?.model ?? null;
  const title = increment.titleUpdate ?? '';

  let totalPromptTokens = 0;
  let totalOutputTokens = 0;
  let totalDuration = 0;
  let totalToolCalls = 0;
  const allToolNames = new Set<string>();

  for (const r of increment.completedResults) {
    totalPromptTokens += r.promptTokens;
    totalOutputTokens += r.outputTokens;
    totalDuration += r.totalElapsedMs;
    totalToolCalls += r.toolCallCount;
    for (const name of r.toolNames) { allToolNames.add(name); }
  }

  const session: CopilotSession = {
    sessionId,
    title,
    startTime: creationDate,
    endTime: creationDate + totalDuration,
    durationMs: totalDuration,
    model,
    workspaceHash,
    promptCount: increment.newRequestCount,
    responseCount: increment.completedResults.length,
    turnCount: increment.newRequestCount,
    toolCallCount: totalToolCalls,
    toolsUsed: [...allToolNames],
    toolCallSuccessCount: totalToolCalls,
    toolCallFailureCount: 0,
    inputChars: 0,
    outputChars: 0,
    reasoningChars: 0,
    toolArgChars: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedTotalTokens: 0,
    promptTokens: totalPromptTokens,
    outputTokens: totalOutputTokens,
    source: 'chatSessions',
    linesAdded: 0,
    linesRemoved: 0,
    filesModified: 0,
    turns: [],
    events: [],
  };

  return { session, totalLines: lines.length };
}

// ─── Incremental Parser (for live watcher) ────────────────

export function parseChatSessionIncremental(
  filePath: string,
  fromByteOffset: number
): { increment: ChatSessionIncrement; newByteOffset: number } {
  const empty: ChatSessionIncrement = { completedResults: [], newRequestCount: 0 };

  let fd: number;
  let stat: fs.Stats;
  try {
    fd = fs.openSync(filePath, 'r');
    stat = fs.fstatSync(fd);
  } catch {
    return { increment: empty, newByteOffset: fromByteOffset };
  }

  if (stat.size <= fromByteOffset) {
    fs.closeSync(fd);
    return { increment: empty, newByteOffset: fromByteOffset };
  }

  const bytesToRead = stat.size - fromByteOffset;
  const buf = Buffer.alloc(bytesToRead);
  fs.readSync(fd, buf, 0, bytesToRead, fromByteOffset);
  fs.closeSync(fd);

  const newContent = buf.toString('utf8');
  const increment: ChatSessionIncrement = { completedResults: [], newRequestCount: 0 };

  for (const rawLine of newContent.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || !line.startsWith('{')) { continue; }
    processLine(line, increment);
  }

  return { increment, newByteOffset: stat.size };
}

// ─── Workspace Parser ─────────────────────────────────────

export function parseChatSessionsInWorkspace(workspaceStoragePath: string): { session: CopilotSession; totalLines: number; filePath: string }[] {
  const chatSessionsDir = path.join(workspaceStoragePath, 'chatSessions');
  if (!fs.existsSync(chatSessionsDir)) {
    return [];
  }

  const wsHash = path.basename(workspaceStoragePath);
  const results: { session: CopilotSession; totalLines: number; filePath: string }[] = [];

  let files: string[];
  try {
    files = fs.readdirSync(chatSessionsDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  for (const file of files) {
    const filePath = path.join(chatSessionsDir, file);
    const { session, totalLines } = parseChatSessionFile(filePath, wsHash);
    if (session) {
      results.push({ session, totalLines, filePath });
    }
  }

  return results;
}
