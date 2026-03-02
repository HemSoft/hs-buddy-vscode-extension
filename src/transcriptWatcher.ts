import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findCopilotWorkspaces, getVSCodeStoragePath } from './storageReader';

/** Poll interval for checking session file changes (ms) */
const POLL_INTERVAL_MS = 2000;

/**
 * Polls chatSessions/ and transcripts/ directories for new/changed JSONL files.
 * Emits file change events — parsing is handled by the tracker.
 *
 * Uses polling instead of fs.watch for reliability on Windows.
 * Re-discovers workspace dirs each poll cycle so new workspaces
 * (e.g. Extension Development Host) are picked up automatically.
 */
export class TranscriptWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  /** Tracks file sizes for change detection */
  private readonly fileSizes = new Map<string, number>();

  private readonly _onFileChanged = new vscode.EventEmitter<{ filePath: string; isNew: boolean }>();
  readonly onFileChanged = this._onFileChanged.event;

  constructor(private readonly outputChannel: vscode.OutputChannel) {
    this.disposables.push(this._onFileChanged);
  }

  start(): void {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.outputChannel.appendLine(`[Watcher] Polling session dirs every ${POLL_INTERVAL_MS}ms.`);
  }

  private poll(): void {
    const storagePath = getVSCodeStoragePath();
    if (!storagePath) { return; }

    const workspaces = findCopilotWorkspaces(storagePath);
    for (const wsDir of workspaces) {
      this.pollDirectory(path.join(wsDir, 'chatSessions'));
      this.pollDirectory(path.join(wsDir, 'GitHub.copilot-chat', 'transcripts'));
    }
  }

  private pollDirectory(dir: string): void {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    } catch {
      return;
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }

      const known = this.fileSizes.get(filePath);
      if (known === undefined) {
        this.fileSizes.set(filePath, stat.size);
        this._onFileChanged.fire({ filePath, isNew: true });
      } else if (stat.size > known) {
        this.fileSizes.set(filePath, stat.size);
        this._onFileChanged.fire({ filePath, isNew: false });
      }
    }
  }

  /**
   * Mark a file's current size as known to prevent re-emitting for existing data.
   */
  markFileAsRead(filePath: string): void {
    try {
      const stat = fs.statSync(filePath);
      this.fileSizes.set(filePath, stat.size);
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
