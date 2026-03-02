import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { CopilotSession, SessionTotals, CurrentSessionStats } from './types';
import { parseWorkspaceTranscripts } from './transcriptParser';
import { parseChatSessionsInWorkspace, parseChatSessionIncremental } from './chatSessionParser';
import { parseTranscriptIncremental } from './transcriptParser';
import { findCopilotWorkspaces, getVSCodeStoragePath } from './storageReader';
import { TranscriptWatcher } from './transcriptWatcher';
import { estimateSessionTokens, formatTokens } from './tokenEstimator';

const TOTALS_KEY = 'hsBuddy.sessionTotals';
const SESSIONS_KEY = 'hsBuddy.recentSessions';
const MAX_RECENT_SESSIONS = 100;

/**
 * Manages Copilot session discovery, real-time tracking, and persistent totals.
 */
export class SessionTracker implements vscode.Disposable {
  private totals: SessionTotals;
  private recentSessions: CopilotSession[] = [];
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private watcher: TranscriptWatcher | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  /** Byte offsets for incremental chatSession parsing */
  private readonly chatSessionByteOffsets = new Map<string, number>();
  /** Line offsets for incremental transcript parsing */
  private readonly transcriptLineOffsets = new Map<string, number>();

  /** Current active session stats (the most recently updated chatSession) */
  private currentSession: CurrentSessionStats | null = null;

  private readonly _onDidUpdate = new vscode.EventEmitter<void>();
  readonly onDidUpdate = this._onDidUpdate.event;

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    this.totals = this.loadTotals();
    this.recentSessions = this.loadRecentSessions();
    this.migrateIfNeeded();
    this.disposables.push(this._onDidUpdate);
  }

  /** Current running totals */
  getTotals(): SessionTotals {
    return this.totals;
  }

  /** Current active session stats */
  getCurrentSession(): CurrentSessionStats | null {
    return this.currentSession;
  }

  /** Most recent sessions (up to MAX_RECENT_SESSIONS) */
  getRecentSessions(): CopilotSession[] {
    return this.recentSessions;
  }

  /** Scan for new sessions across all workspaces */
  async scan(): Promise<number> {
    const storagePath = getVSCodeStoragePath();
    if (!storagePath) {
      return 0;
    }

    const workspaces = findCopilotWorkspaces(storagePath);
    let newCount = 0;

    // 1. Parse chatSessions files (current format — has real token counts)
    let latestSession: { session: CopilotSession; filePath: string } | null = null;

    for (const wsDir of workspaces) {
      const results = parseChatSessionsInWorkspace(wsDir);
      for (const { session, filePath } of results) {
        if (!this.totals.processedSessionIds.includes(session.sessionId)) {
          this.addSession(session);
          newCount++;

          // Set up byte offset for incremental parsing
          try {
            const stat = fs.statSync(filePath);
            this.chatSessionByteOffsets.set(filePath, stat.size);
          } catch { /* ignore */ }

          // Mark in watcher so it won't re-emit for existing content
          this.watcher?.markFileAsRead(filePath);
        }

        // Track the most recent session for current session display
        if (!latestSession || session.startTime > latestSession.session.startTime) {
          latestSession = { session, filePath };
        }
      }
    }

    // Set the most recent chatSession as the current session
    if (latestSession) {
      const s = latestSession.session;
      this.currentSession = {
        sessionId: s.sessionId,
        title: s.title,
        model: s.model,
        startTime: s.startTime,
        prompts: s.promptCount,
        responses: s.responseCount,
        promptTokens: s.promptTokens,
        outputTokens: s.outputTokens,
        toolCalls: s.toolCallCount,
        durationMs: s.durationMs,
        toolUsage: {},
        filePath: latestSession.filePath,
      };
      for (const tool of s.toolsUsed) {
        this.currentSession.toolUsage[tool] = (this.currentSession.toolUsage[tool] ?? 0) + 1;
      }
    }

    // 2. Parse old transcripts files (legacy format — 2 workspace hashes)
    for (const wsDir of workspaces) {
      const sessions = parseWorkspaceTranscripts(wsDir);
      for (const session of sessions) {
        if (!this.totals.processedSessionIds.includes(session.sessionId)) {
          await estimateSessionTokens(session);
          this.addSession(session);
          newCount++;

          const transcriptPath = path.join(
            wsDir, 'GitHub.copilot-chat', 'transcripts', `${session.sessionId}.jsonl`
          );
          this.watcher?.markFileAsRead(transcriptPath);

          // Set line offset for incremental parsing
          try {
            const content = fs.readFileSync(transcriptPath, 'utf8');
            this.transcriptLineOffsets.set(
              transcriptPath,
              content.split('\n').filter(l => l.trim()).length
            );
          } catch { /* ignore */ }
        }
      }
    }

    if (newCount > 0) {
      this.totals.lastScanTime = Date.now();
      await this.persist();
      this._onDidUpdate.fire();
    }

    return newCount;
  }

  /** Start the file system watcher for real-time event tracking */
  startWatcher(): void {
    if (this.watcher) {
      return;
    }

    this.watcher = new TranscriptWatcher(this.outputChannel);

    this.watcher.onFileChanged(({ filePath, isNew }) => {
      this.handleFileChanged(filePath, isNew);
    });

    // Mark all existing files as read before starting
    const storagePath = getVSCodeStoragePath();
    if (storagePath) {
      const workspaces = findCopilotWorkspaces(storagePath);
      for (const wsDir of workspaces) {
        // chatSessions files
        const chatDir = path.join(wsDir, 'chatSessions');
        try {
          for (const file of fs.readdirSync(chatDir).filter((f: string) => f.endsWith('.jsonl'))) {
            const fp = path.join(chatDir, file);
            this.watcher.markFileAsRead(fp);
            // Set byte offset to current file size
            try {
              const stat = fs.statSync(fp);
              this.chatSessionByteOffsets.set(fp, stat.size);
            } catch { /* ignore */ }
          }
        } catch { /* dir may not exist */ }

        // Legacy transcripts files
        const transcriptsDir = path.join(wsDir, 'GitHub.copilot-chat', 'transcripts');
        try {
          for (const file of fs.readdirSync(transcriptsDir).filter((f: string) => f.endsWith('.jsonl'))) {
            const fp = path.join(transcriptsDir, file);
            this.watcher.markFileAsRead(fp);
            // Set line offset to current line count
            try {
              const content = fs.readFileSync(fp, 'utf8');
              this.transcriptLineOffsets.set(fp, content.split('\n').filter(l => l.trim()).length);
            } catch { /* ignore */ }
          }
        } catch { /* dir may not exist */ }
      }
    }

    this.watcher.start();
    this.disposables.push(this.watcher);
    this.outputChannel.appendLine('[Tracker] Real-time watcher started.');
  }

  /** Start periodic scanning */
  startPeriodicScan(intervalMinutes: number = 5): void {
    if (this.scanTimer) {
      return;
    }
    this.scanTimer = setInterval(() => {
      void this.scan();
    }, intervalMinutes * 60 * 1000);
  }

  /** Stop periodic scanning */
  stopPeriodicScan(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
  }

  /** Reset all tracked data */
  async reset(): Promise<void> {
    this.totals = createEmptyTotals();
    this.recentSessions = [];
    this.chatSessionByteOffsets.clear();
    this.transcriptLineOffsets.clear();
    this.currentSession = null;
    await this.persist();
    this._onDidUpdate.fire();
  }

  /** Status bar text */
  getStatusBarText(): string {
    const t = this.totals;
    if (t.totalSessions === 0) {
      return '$(hs-buddy-icon) No sessions';
    }
    const cs = this.currentSession;
    if (cs) {
      const csTokens = cs.promptTokens + cs.outputTokens;
      return `$(hs-buddy-icon) ${cs.prompts}p ${formatTokens(csTokens)} tok | All: ${t.totalSessions} sessions`;
    }
    // Prefer real token counts, fall back to estimated
    const totalTokens = t.totalPromptTokens + t.totalOutputTokens > 0
      ? t.totalPromptTokens + t.totalOutputTokens
      : t.totalEstimatedTotalTokens;
    return `$(hs-buddy-icon) ${t.totalSessions} sessions | ${formatTokens(totalTokens)} tokens`;
  }

  /** Status bar tooltip */
  getStatusBarTooltip(): string {
    const t = this.totals;
    if (t.totalSessions === 0) {
      return 'HemSoft Buddy \u2014 No sessions tracked yet. Click to scan.';
    }

    const duration = formatDuration(t.totalDuration);
    const topModel = getTopEntry(t.modelUsage);
    const topTool = getTopEntry(t.toolUsage);
    const hasRealTokens = t.totalPromptTokens + t.totalOutputTokens > 0;

    const lines: string[] = [];

    // Current session section
    const cs = this.currentSession;
    if (cs) {
      const csTokens = cs.promptTokens + cs.outputTokens;
      const csDur = formatDuration(cs.durationMs);
      const csModel = cs.model?.name ?? 'Unknown';
      const csTopTool = getTopEntry(cs.toolUsage);
      lines.push(
        `\u25B6 Current Session`,
        `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
        `${cs.title || 'Untitled'}`,
        `Model: ${csModel}`,
        `Prompts: ${cs.prompts} | Responses: ${cs.responses}`,
        `Tokens: ${formatTokens(csTokens)} (in: ${formatTokens(cs.promptTokens)} | out: ${formatTokens(cs.outputTokens)})`,
        `Tool Calls: ${cs.toolCalls}`,
        `Duration: ${csDur}`,
      );
      if (csTopTool) {
        lines.push(`Top Tool: ${csTopTool}`);
      }
      lines.push(``, `\u25A0 All Sessions`);
    } else {
      lines.push(`HemSoft Buddy \u2014 Copilot Sessions`);
    }

    lines.push(
      `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
      `Sessions: ${t.totalSessions} | Turns: ${t.totalTurns}`,
      `Prompts: ${t.totalPrompts} | Responses: ${t.totalResponses}`,
    );

    if (hasRealTokens) {
      lines.push(`Tokens: ${formatTokens(t.totalPromptTokens + t.totalOutputTokens)} (in: ${formatTokens(t.totalPromptTokens)} | out: ${formatTokens(t.totalOutputTokens)})`);
    } else {
      lines.push(`Est. Tokens: ~${formatTokens(t.totalEstimatedTotalTokens)} (in: ~${formatTokens(t.totalEstimatedInputTokens)} | out: ~${formatTokens(t.totalEstimatedOutputTokens)})`);
    }

    lines.push(
      `Tool Calls: ${t.totalToolCalls} (${t.totalToolCallSuccesses} ok / ${t.totalToolCallFailures} fail)`,
      `Code: +${t.totalLinesAdded} / -${t.totalLinesRemoved} (${t.totalFilesModified} files)`,
      `Duration: ${duration}`,
    );

    if (topModel) {
      lines.push(`Top Model: ${topModel}`);
    }
    if (topTool) {
      lines.push(`Top Tool: ${topTool}`);
    }

    if (t.lastScanTime > 0) {
      lines.push(`Last Scan: ${new Date(t.lastScanTime).toLocaleTimeString()}`);
    }

    return lines.join('\n');
  }

  /** Build Quick Pick items for session history */
  getHistoryQuickPickItems(): vscode.QuickPickItem[] {
    if (this.recentSessions.length === 0) {
      return [{ label: '$(info) No sessions recorded yet', description: 'Run a scan first' }];
    }

    return this.recentSessions
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, 20)
      .map(s => {
        const date = new Date(s.startTime).toLocaleDateString();
        const time = new Date(s.startTime).toLocaleTimeString();
        const duration = formatDuration(s.durationMs);
        const model = s.model ? s.model.name : 'Unknown';
        const toolInfo = s.toolCallCount > 0
          ? `${s.toolCallCount} tools (${s.toolCallSuccessCount}/${s.toolCallFailureCount})`
          : 'no tools';
        const tokens = s.promptTokens + s.outputTokens > 0
          ? formatTokens(s.promptTokens + s.outputTokens)
          : `~${formatTokens(s.estimatedTotalTokens)}`;
        return {
          label: `$(comment-discussion) ${s.title || 'Untitled'}`,
          description: `${model} \u00B7 ${s.promptCount}p ${s.turnCount}t \u00B7 ${toolInfo} \u00B7 ${tokens} tok`,
          detail: `${date} ${time} \u00B7 ${duration} \u00B7 +${s.linesAdded}/-${s.linesRemoved} lines`,
        };
      });
  }

  /** Export all session data as JSON */
  getExportData(): string {
    // Strip raw events from export to keep size manageable
    const exportSessions = this.recentSessions.map(s => {
      const { events, ...rest } = s;
      return rest;
    });

    return JSON.stringify(
      {
        exportDate: new Date().toISOString(),
        totals: this.totals,
        recentSessions: exportSessions,
      },
      null,
      2
    );
  }

  dispose(): void {
    this.stopPeriodicScan();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  // ─── Private ──────────────────────────────────────────

  private handleFileChanged(filePath: string, isNew: boolean): void {
    if (isNew) {
      this.outputChannel.appendLine(`[Tracker] New session file: ${path.basename(filePath)}`);
    }

    if (filePath.includes(`${path.sep}chatSessions${path.sep}`)) {
      this.handleChatSessionFileChange(filePath);
    } else if (filePath.includes(`${path.sep}transcripts${path.sep}`)) {
      this.handleTranscriptFileChange(filePath);
    }
  }

  private handleChatSessionFileChange(filePath: string): void {
    const byteOffset = this.chatSessionByteOffsets.get(filePath) ?? 0;
    const { increment, newByteOffset } = parseChatSessionIncremental(filePath, byteOffset);
    this.chatSessionByteOffsets.set(filePath, newByteOffset);

    // Process session init
    if (increment.sessionInit) {
      const sid = increment.sessionInit.sessionId;
      if (sid && !this.totals.processedSessionIds.includes(sid)) {
        this.totals.totalSessions++;
        this.totals.processedSessionIds.push(sid);
        this.outputChannel.appendLine(`[Live] Session started: ${sid.substring(0, 8)}...`);

        if (increment.sessionInit.model) {
          const key = increment.sessionInit.model.family;
          this.totals.modelUsage[key] = (this.totals.modelUsage[key] ?? 0) + 1;
        }
      }

      // Initialize or switch current session
      this.currentSession = {
        sessionId: sid,
        title: '',
        model: increment.sessionInit.model,
        startTime: increment.sessionInit.creationDate,
        prompts: 0,
        responses: 0,
        promptTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        durationMs: 0,
        toolUsage: {},
        filePath,
      };
    }

    // Auto-associate with current session if it's the same file
    if (!this.currentSession || this.currentSession.filePath !== filePath) {
      // Different file being updated — switch to it if we don't have a current session
      if (!this.currentSession) {
        this.currentSession = {
          sessionId: filePath,
          title: '',
          model: null,
          startTime: Date.now(),
          prompts: 0,
          responses: 0,
          promptTokens: 0,
          outputTokens: 0,
          toolCalls: 0,
          durationMs: 0,
          toolUsage: {},
          filePath,
        };
      }
    }

    // Process title update
    if (increment.titleUpdate) {
      this.outputChannel.appendLine(`[Live] Title: ${increment.titleUpdate.substring(0, 50)}`);
      if (this.currentSession?.filePath === filePath) {
        this.currentSession.title = increment.titleUpdate;
      }
    }

    // Process new requests (user prompts)
    if (increment.newRequestCount > 0) {
      this.totals.totalPrompts += increment.newRequestCount;
      this.totals.totalTurns += increment.newRequestCount;
      if (this.currentSession?.filePath === filePath) {
        this.currentSession.prompts += increment.newRequestCount;
      }
      this.outputChannel.appendLine(`[Live] ${increment.newRequestCount} new request(s)`);
    }

    // Process completed results with real token counts
    for (const result of increment.completedResults) {
      this.totals.totalResponses++;
      this.totals.totalPromptTokens += result.promptTokens;
      this.totals.totalOutputTokens += result.outputTokens;
      this.totals.totalToolCalls += result.toolCallCount;
      this.totals.totalDuration += result.totalElapsedMs;

      for (const name of result.toolNames) {
        this.totals.toolUsage[name] = (this.totals.toolUsage[name] ?? 0) + 1;
      }
      this.totals.totalToolCallSuccesses += result.toolCallCount;

      // Update current session stats
      if (this.currentSession?.filePath === filePath) {
        this.currentSession.responses++;
        this.currentSession.promptTokens += result.promptTokens;
        this.currentSession.outputTokens += result.outputTokens;
        this.currentSession.toolCalls += result.toolCallCount;
        this.currentSession.durationMs += result.totalElapsedMs;
        for (const name of result.toolNames) {
          this.currentSession.toolUsage[name] = (this.currentSession.toolUsage[name] ?? 0) + 1;
        }
      }

      this.outputChannel.appendLine(
        `[Live] Result: ${result.promptTokens} prompt + ${result.outputTokens} output tokens, ${result.toolCallCount} tool calls, ${(result.totalElapsedMs / 1000).toFixed(1)}s`
      );
    }

    if (increment.newRequestCount > 0 || increment.completedResults.length > 0 || increment.titleUpdate) {
      void this.persist();
      this._onDidUpdate.fire();
    }
  }

  private handleTranscriptFileChange(filePath: string): void {
    const lineOffset = this.transcriptLineOffsets.get(filePath) ?? 0;
    const { events, newOffset } = parseTranscriptIncremental(filePath, lineOffset);
    this.transcriptLineOffsets.set(filePath, newOffset);

    if (events.length === 0) { return; }

    const sessionId = path.basename(filePath, '.jsonl');

    for (const evt of events) {
      switch (evt.type) {
        case 'session.start':
          if (!this.totals.processedSessionIds.includes(evt.sessionId)) {
            this.totals.totalSessions++;
            this.totals.processedSessionIds.push(evt.sessionId);
          }
          this.outputChannel.appendLine(`[Live] Transcript session: ${sessionId.substring(0, 8)}...`);
          break;
        case 'user.message':
          this.totals.totalPrompts++;
          this.totals.totalInputChars += evt.contentLength;
          break;
        case 'assistant.turn_start':
          this.totals.totalTurns++;
          break;
        case 'assistant.message':
          this.totals.totalResponses++;
          this.totals.totalOutputChars += evt.contentLength;
          this.totals.totalReasoningChars += evt.reasoningLength;
          break;
        case 'tool.execution_start':
          this.totals.totalToolCalls++;
          if (evt.toolName) {
            this.totals.toolUsage[evt.toolName] = (this.totals.toolUsage[evt.toolName] ?? 0) + 1;
          }
          break;
        case 'tool.execution_complete':
          if (evt.success) { this.totals.totalToolCallSuccesses++; }
          else { this.totals.totalToolCallFailures++; }
          break;
      }
    }

    void this.persist();
    this._onDidUpdate.fire();
  }

  private addSession(session: CopilotSession): void {
    this.totals.totalSessions++;
    this.totals.totalPrompts += session.promptCount;
    this.totals.totalResponses += session.responseCount;
    this.totals.totalTurns += session.turnCount;
    this.totals.totalToolCalls += session.toolCallCount;
    this.totals.totalToolCallSuccesses += session.toolCallSuccessCount;
    this.totals.totalToolCallFailures += session.toolCallFailureCount;
    this.totals.totalInputChars += session.inputChars;
    this.totals.totalOutputChars += session.outputChars;
    this.totals.totalReasoningChars += session.reasoningChars;
    this.totals.totalToolArgChars += session.toolArgChars;
    this.totals.totalEstimatedInputTokens += session.estimatedInputTokens;
    this.totals.totalEstimatedOutputTokens += session.estimatedOutputTokens;
    this.totals.totalEstimatedTotalTokens += session.estimatedTotalTokens;
    this.totals.totalPromptTokens += session.promptTokens;
    this.totals.totalOutputTokens += session.outputTokens;
    this.totals.totalLinesAdded += session.linesAdded;
    this.totals.totalLinesRemoved += session.linesRemoved;
    this.totals.totalFilesModified += session.filesModified;
    this.totals.totalDuration += session.durationMs;
    this.totals.processedSessionIds.push(session.sessionId);

    // Track model usage
    if (session.model) {
      const key = session.model.family;
      this.totals.modelUsage[key] = (this.totals.modelUsage[key] ?? 0) + 1;
    }

    // Track tool usage
    for (const tool of session.toolsUsed) {
      this.totals.toolUsage[tool] = (this.totals.toolUsage[tool] ?? 0) + 1;
    }

    // Add to recent sessions (capped)
    this.recentSessions.unshift(session);
    if (this.recentSessions.length > MAX_RECENT_SESSIONS) {
      this.recentSessions = this.recentSessions.slice(0, MAX_RECENT_SESSIONS);
    }
  }

  private async persist(): Promise<void> {
    // Strip events from persisted sessions to save storage
    const persistSessions = this.recentSessions.map(s => ({
      ...s,
      events: [],
      turns: s.turns.map(t => ({ ...t })),
    }));
    await this.globalState.update(TOTALS_KEY, this.totals);
    await this.globalState.update(SESSIONS_KEY, persistSessions);
  }

  private loadTotals(): SessionTotals {
    const stored = this.globalState.get<Partial<SessionTotals>>(TOTALS_KEY);
    if (!stored) {
      return createEmptyTotals();
    }
    // Merge with defaults so new fields added in later versions get zero instead of undefined
    return { ...createEmptyTotals(), ...stored };
  }

  private loadRecentSessions(): CopilotSession[] {
    return this.globalState.get<CopilotSession[]>(SESSIONS_KEY) ?? [];
  }

  /**
   * Detect totals persisted by an older version that lacks new fields.
   * If sessions were tracked but turns/tokens are still 0, clear
   * processedSessionIds to force a full rescan with the new parser.
   */
  private migrateIfNeeded(): void {
    const t = this.totals;
    if (t.processedSessionIds.length > 0 && t.totalTurns === 0 && t.totalEstimatedTotalTokens === 0) {
      this.outputChannel.appendLine(
        `[Tracker] Migrating ${t.processedSessionIds.length} sessions — clearing for full rescan with new data model.`
      );
      this.totals = createEmptyTotals();
      this.recentSessions = [];
    }
  }
}

// ─── Utility ──────────────────────────────────────────────

function createEmptyTotals(): SessionTotals {
  return {
    totalSessions: 0,
    totalPrompts: 0,
    totalResponses: 0,
    totalTurns: 0,
    totalToolCalls: 0,
    totalToolCallSuccesses: 0,
    totalToolCallFailures: 0,
    totalInputChars: 0,
    totalOutputChars: 0,
    totalReasoningChars: 0,
    totalToolArgChars: 0,
    totalEstimatedInputTokens: 0,
    totalEstimatedOutputTokens: 0,
    totalEstimatedTotalTokens: 0,
    totalPromptTokens: 0,
    totalOutputTokens: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    totalFilesModified: 0,
    totalDuration: 0,
    modelUsage: {},
    toolUsage: {},
    lastScanTime: 0,
    processedSessionIds: [],
  };
}

function formatDuration(ms: number): string {
  if (ms <= 0) {
    return '0s';
  }
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function getTopEntry(record: Record<string, number>): string | null {
  const entries = Object.entries(record);
  if (entries.length === 0) {
    return null;
  }
  entries.sort((a, b) => b[1] - a[1]);
  return `${entries[0][0]} (${entries[0][1]})`;
}
