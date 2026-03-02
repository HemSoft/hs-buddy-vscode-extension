import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedEvent } from './types';
import { parseTranscriptIncremental } from './transcriptParser';
import { findCopilotWorkspaces, getVSCodeStoragePath } from './storageReader';

/**
 * Watches transcript directories for new/changed JSONL files
 * and emits parsed events in real time as Copilot writes them.
 */
export class TranscriptWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watchers: fs.FSWatcher[] = [];

  /** Tracks how many lines we've already parsed per file */
  private readonly fileOffsets = new Map<string, number>();

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
   * Start watching all transcript directories.
   */
  start(): void {
    const storagePath = getVSCodeStoragePath();
    if (!storagePath) {
      this.outputChannel.appendLine('[Watcher] Could not find VS Code storage path.');
      return;
    }

    const workspaces = findCopilotWorkspaces(storagePath);
    for (const wsDir of workspaces) {
      this.watchTranscriptDir(wsDir);
    }

    this.outputChannel.appendLine(`[Watcher] Watching ${workspaces.length} workspace transcript dirs.`);
  }

  private watchTranscriptDir(workspaceStoragePath: string): void {
    const transcriptsDir = path.join(workspaceStoragePath, 'GitHub.copilot-chat', 'transcripts');

    // Create the directory watch even if it doesn't exist yet
    // (it gets created when the first session starts)
    if (!fs.existsSync(transcriptsDir)) {
      // Watch the parent dir for the transcripts folder to appear
      const parentDir = path.join(workspaceStoragePath, 'GitHub.copilot-chat');
      if (!fs.existsSync(parentDir)) {
        return;
      }
      try {
        const parentWatcher = fs.watch(parentDir, (_eventType, filename) => {
          if (filename === 'transcripts' && fs.existsSync(transcriptsDir)) {
            this.watchJsonlFiles(transcriptsDir);
            parentWatcher.close();
          }
        });
        this.watchers.push(parentWatcher);
      } catch {
        // Directory may not be watchable
      }
      return;
    }

    this.watchJsonlFiles(transcriptsDir);
  }

  private watchJsonlFiles(transcriptsDir: string): void {
    try {
      const watcher = fs.watch(transcriptsDir, (eventType, filename) => {
        if (!filename?.endsWith('.jsonl')) {
          return;
        }
        const filePath = path.join(transcriptsDir, filename);
        if (eventType === 'rename') {
          // New file created
          if (fs.existsSync(filePath)) {
            this._onNewFile.fire(filePath);
            this.processFileChanges(filePath);
          }
        } else if (eventType === 'change') {
          this.processFileChanges(filePath);
        }
      });
      this.watchers.push(watcher);
    } catch {
      // May fail if directory becomes unavailable
    }
  }

  private processFileChanges(filePath: string): void {
    const currentOffset = this.fileOffsets.get(filePath) ?? 0;
    const { events, newOffset } = parseTranscriptIncremental(filePath, currentOffset);

    if (events.length > 0) {
      this.fileOffsets.set(filePath, newOffset);
      const sessionId = path.basename(filePath, '.jsonl');
      this._onNewEvents.fire({ filePath, sessionId, events });
    } else {
      // Update offset even if no parseable events (could be partial lines)
      this.fileOffsets.set(filePath, newOffset);
    }
  }

  /**
   * Mark a file as fully read up to its current length.
   * Called after initial scan to avoid re-emitting existing events.
   */
  markFileAsRead(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lineCount = content.split('\n').filter(l => l.trim()).length;
      this.fileOffsets.set(filePath, lineCount);
    } catch {
      // Ignore
    }
  }

  dispose(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // Ignore
      }
    }
    this.watchers.length = 0;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
