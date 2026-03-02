import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedEvent } from './types';
import { parseTranscriptIncremental } from './transcriptParser';
import { findCopilotWorkspaces, getVSCodeStoragePath } from './storageReader';

/** Poll interval for checking transcript changes (ms) */
const POLL_INTERVAL_MS = 2000;

/**
 * Polls transcript directories for new/changed JSONL files
 * and emits parsed events in real time as Copilot writes them.
 *
 * Uses polling instead of fs.watch for reliability on Windows.
 * Re-discovers workspace dirs each poll cycle so new workspaces
 * (e.g. Extension Development Host) are picked up automatically.
 */
export class TranscriptWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  /** Tracks line offset and file size per file for change detection */
  private readonly fileState = new Map<string, { size: number; lineOffset: number }>();

  private readonly _onNewEvents = new vscode.EventEmitter<{
    filePath: string;
    sessionId: string;
    events: ParsedEvent[];
  }>();
  readonly onNewEvents = this._onNewEvents.event;

  private readonly _onNewFile = new vscode.EventEmitter<string>();
  readonly onNewFile = this._onNewFile.event;

  constructor(private readonly outputChannel: vscode.OutputChannel) {
    this.disposables.push(this._onNewEvents, this._onNewFile);
  }

  /**
   * Start polling all transcript directories.
   */
  start(): void {
    // Run first poll immediately
    this.poll();
    // Then poll every POLL_INTERVAL_MS
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.outputChannel.appendLine(`[Watcher] Polling transcript dirs every ${POLL_INTERVAL_MS}ms.`);
  }

  /**
   * Single poll cycle: discover all transcript dirs and check for changes.
   */
  private poll(): void {
    const storagePath = getVSCodeStoragePath();
    if (!storagePath) {
      return;
    }

    const workspaces = findCopilotWorkspaces(storagePath);
    for (const wsDir of workspaces) {
      this.pollTranscriptDir(wsDir);
    }
  }

  private pollTranscriptDir(workspaceStoragePath: string): void {
    const transcriptsDir = path.join(
      workspaceStoragePath, 'GitHub.copilot-chat', 'transcripts'
    );

    let files: string[];
    try {
      files = fs.readdirSync(transcriptsDir).filter(f => f.endsWith('.jsonl'));
    } catch {
      return; // Directory doesn't exist yet
    }

    for (const file of files) {
      const filePath = path.join(transcriptsDir, file);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }

      const known = this.fileState.get(filePath);

      if (!known) {
        // First time seeing this file — if not pre-marked, it's genuinely new
        this._onNewFile.fire(filePath);
        this.fileState.set(filePath, { size: stat.size, lineOffset: 0 });
        this.processFileChanges(filePath);
      } else if (stat.size > known.size) {
        // File grew — process new lines
        known.size = stat.size;
        this.processFileChanges(filePath);
      }
    }
  }

  private processFileChanges(filePath: string): void {
    const state = this.fileState.get(filePath);
    const currentOffset = state?.lineOffset ?? 0;
    const { events, newOffset } = parseTranscriptIncremental(filePath, currentOffset);

    if (state) {
      state.lineOffset = newOffset;
    }

    if (events.length > 0) {
      const sessionId = path.basename(filePath, '.jsonl');
      this._onNewEvents.fire({ filePath, sessionId, events });
    }
  }

  /**
   * Mark a file as fully read up to its current size and line count.
   * Called after initial scan to avoid re-emitting existing events.
   */
  markFileAsRead(filePath: string): void {
    try {
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const lineCount = content.split('\n').filter(l => l.trim()).length;
      this.fileState.set(filePath, { size: stat.size, lineOffset: lineCount });
    } catch {
      // Ignore
    }
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  dispose(): void {
    this.stop();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
