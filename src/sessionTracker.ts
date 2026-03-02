import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { CopilotSession, SessionTotals, ParsedEvent } from './types';
import { parseWorkspaceTranscripts } from './transcriptParser';
import { findCopilotWorkspaces, getVSCodeStoragePath } from './storageReader';
import { TranscriptWatcher } from './transcriptWatcher';
import { estimateSessionTokens, estimateTokensFromChars, formatTokens } from './tokenEstimator';

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

  /** Live session data from watcher (not yet fully parsed) */
  private readonly liveSessionEvents = new Map<string, ParsedEvent[]>();

  private readonly _onDidUpdate = new vscode.EventEmitter<void>();
  readonly onDidUpdate = this._onDidUpdate.event;

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    this.totals = this.loadTotals();
    this.recentSessions = this.loadRecentSessions();
    this.disposables.push(this._onDidUpdate);
  }

  /** Current running totals */
  getTotals(): SessionTotals {
    return this.totals;
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
    const newSessions: CopilotSession[] = [];

    for (const wsDir of workspaces) {
      const sessions = parseWorkspaceTranscripts(wsDir);
      for (const session of sessions) {
        if (!this.totals.processedSessionIds.includes(session.sessionId)) {
          newSessions.push(session);
          newCount++;
        }
      }
    }

    // Estimate tokens for new sessions (batch, using LM API if available)
    for (const session of newSessions) {
      await estimateSessionTokens(session);
      this.addSession(session);

      // Mark file as read so watcher doesn't re-emit
      if (this.watcher) {
        const storagePath2 = getVSCodeStoragePath();
        if (storagePath2) {
          const transcriptPath = path.join(
            storagePath2, 'workspaceStorage', session.workspaceHash,
            'GitHub.copilot-chat', 'transcripts', `${session.sessionId}.jsonl`
          );
          this.watcher.markFileAsRead(transcriptPath);
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

    this.watcher.onNewEvents(({ sessionId, events }) => {
      this.handleLiveEvents(sessionId, events);
    });

    this.watcher.onNewFile(filePath => {
      this.outputChannel.appendLine(`[Tracker] New transcript file: ${path.basename(filePath)}`);
    });

    // Mark all existing files as read before starting
    const storagePath = getVSCodeStoragePath();
    if (storagePath) {
      const workspaces = findCopilotWorkspaces(storagePath);
      for (const wsDir of workspaces) {
        const transcriptsDir = path.join(wsDir, 'GitHub.copilot-chat', 'transcripts');
        try {
          const files = fs.readdirSync(transcriptsDir).filter((f: string) => f.endsWith('.jsonl'));
          for (const file of files) {
            this.watcher.markFileAsRead(path.join(transcriptsDir, file));
          }
        } catch {
          // Directory may not exist
        }
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
    this.liveSessionEvents.clear();
    await this.persist();
    this._onDidUpdate.fire();
  }

  /** Status bar text */
  getStatusBarText(): string {
    const t = this.totals;
    if (t.totalSessions === 0) {
      return '$(hs-buddy-icon) No sessions';
    }
    return `$(hs-buddy-icon) ${t.totalSessions} sessions | ~${formatTokens(t.totalEstimatedTotalTokens)} tokens`;
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

    const lines = [
      `HemSoft Buddy \u2014 Copilot Sessions`,
      `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
      `Sessions: ${t.totalSessions} | Turns: ${t.totalTurns}`,
      `Prompts: ${t.totalPrompts} | Responses: ${t.totalResponses}`,
      `Est. Tokens: ~${formatTokens(t.totalEstimatedTotalTokens)} (in: ~${formatTokens(t.totalEstimatedInputTokens)} | out: ~${formatTokens(t.totalEstimatedOutputTokens)})`,
      `Tool Calls: ${t.totalToolCalls} (${t.totalToolCallSuccesses} ok / ${t.totalToolCallFailures} fail)`,
      `Code: +${t.totalLinesAdded} / -${t.totalLinesRemoved} (${t.totalFilesModified} files)`,
      `Duration: ${duration}`,
    ];

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
        return {
          label: `$(comment-discussion) ${s.title || 'Untitled'}`,
          description: `${model} \u00B7 ${s.promptCount}p ${s.turnCount}t \u00B7 ${toolInfo} \u00B7 ~${formatTokens(s.estimatedTotalTokens)} tok`,
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

  private handleLiveEvents(sessionId: string, events: ParsedEvent[]): void {
    // Accumulate events for the session
    const existing = this.liveSessionEvents.get(sessionId) ?? [];
    existing.push(...events);
    this.liveSessionEvents.set(sessionId, existing);

    // Log notable events
    for (const evt of events) {
      switch (evt.type) {
        case 'session.start':
          this.outputChannel.appendLine(`[Live] Session started: ${sessionId}`);
          break;
        case 'user.message':
          this.outputChannel.appendLine(`[Live] User prompt in ${sessionId.substring(0, 8)}...`);
          break;
        case 'tool.execution_start':
          this.outputChannel.appendLine(`[Live] Tool: ${evt.toolName} in ${sessionId.substring(0, 8)}...`);
          break;
        case 'tool.execution_complete':
          this.outputChannel.appendLine(`[Live] Tool done: ${evt.success ? 'ok' : 'FAIL'} in ${sessionId.substring(0, 8)}...`);
          break;
        case 'assistant.turn_end':
          this.outputChannel.appendLine(`[Live] Turn ended in ${sessionId.substring(0, 8)}...`);
          break;
      }
    }

    // Update live counters for status bar (fast, no LM API call)
    this.updateLiveCounters(events);
    this._onDidUpdate.fire();
  }

  private updateLiveCounters(events: ParsedEvent[]): void {
    for (const evt of events) {
      switch (evt.type) {
        case 'user.message':
          this.totals.totalPrompts++;
          this.totals.totalInputChars += evt.contentLength;
          this.totals.totalEstimatedInputTokens += estimateTokensFromChars(evt.contentLength);
          this.totals.totalEstimatedTotalTokens += estimateTokensFromChars(evt.contentLength);
          break;

        case 'assistant.message':
          this.totals.totalResponses++;
          this.totals.totalOutputChars += evt.contentLength;
          this.totals.totalReasoningChars += evt.reasoningLength;
          this.totals.totalToolArgChars += evt.toolRequests.reduce((s, r) => s + r.argumentsLength, 0);
          {
            const outChars = evt.contentLength + evt.reasoningLength +
              evt.toolRequests.reduce((s, r) => s + r.argumentsLength, 0);
            this.totals.totalEstimatedOutputTokens += estimateTokensFromChars(outChars);
            this.totals.totalEstimatedTotalTokens += estimateTokensFromChars(outChars);
          }
          break;

        case 'assistant.turn_start':
          this.totals.totalTurns++;
          break;

        case 'tool.execution_start':
          this.totals.totalToolCalls++;
          if (evt.toolName) {
            this.totals.toolUsage[evt.toolName] = (this.totals.toolUsage[evt.toolName] ?? 0) + 1;
          }
          break;

        case 'tool.execution_complete':
          if (evt.success) {
            this.totals.totalToolCallSuccesses++;
          } else {
            this.totals.totalToolCallFailures++;
          }
          break;

        case 'session.start':
          // Only count as new session if not already processed
          if (!this.totals.processedSessionIds.includes(evt.sessionId)) {
            this.totals.totalSessions++;
            this.totals.processedSessionIds.push(evt.sessionId);
          }
          break;
      }
    }

    // Debounce persist
    void this.persist();
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
    return this.globalState.get<SessionTotals>(TOTALS_KEY) ?? createEmptyTotals();
  }

  private loadRecentSessions(): CopilotSession[] {
    return this.globalState.get<CopilotSession[]>(SESSIONS_KEY) ?? [];
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
