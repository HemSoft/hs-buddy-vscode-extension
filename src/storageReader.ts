import * as fs from 'fs';
import * as path from 'path';
import type { CopilotSession, ModelInfo, SessionStoreEntry, InteractiveSessionEntry } from './types';

/** Minimal SQLite reader is not available in extension runtime.
 *  We parse the session store index and interactive session memento
 *  from VS Code's globalState/workspaceState instead.
 *
 *  This module enriches transcript-parsed sessions with metadata from
 *  workspace state.vscdb files using a lightweight approach:
 *  read the JSON files that Copilot writes alongside the DB.
 */

/**
 * Finds all workspace storage directories that have Copilot chat data.
 */
export function findCopilotWorkspaces(vsCodeStoragePath: string): string[] {
  const wsRoot = path.join(vsCodeStoragePath, 'workspaceStorage');
  if (!fs.existsSync(wsRoot)) {
    return [];
  }

  const result: string[] = [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(wsRoot);
  } catch {
    return [];
  }

  for (const dir of dirs) {
    const copilotDir = path.join(wsRoot, dir, 'GitHub.copilot-chat');
    if (fs.existsSync(copilotDir)) {
      result.push(path.join(wsRoot, dir));
    }
  }

  return result;
}

/**
 * Resolves the VS Code user data path (handles both stable and insiders).
 */
export function getVSCodeStoragePath(): string {
  const appData = process.env.APPDATA;
  if (!appData) {
    return '';
  }

  // Try Insiders first, then stable
  const insidersPath = path.join(appData, 'Code - Insiders', 'User');
  if (fs.existsSync(insidersPath)) {
    return insidersPath;
  }

  const stablePath = path.join(appData, 'Code', 'User');
  if (fs.existsSync(stablePath)) {
    return stablePath;
  }

  return '';
}

/**
 * Extracts model info from interactive session entries.
 * Reads the memento/interactive-session data that Copilot stores.
 */
export function extractModelFromInteractiveSession(entries: InteractiveSessionEntry[]): ModelInfo | null {
  for (const entry of entries) {
    if (entry.selectedModel?.metadata) {
      const m = entry.selectedModel.metadata;
      return {
        id: m.id,
        name: m.name,
        family: m.family,
        vendor: m.vendor,
        multiplier: m.multiplier || '1x',
        multiplierNumeric: m.multiplierNumeric || 1,
        maxInputTokens: m.maxInputTokens || 0,
        maxOutputTokens: m.maxOutputTokens || 0,
      };
    }
  }
  return null;
}

/**
 * Enriches parsed sessions with session store metadata (title, stats).
 */
export function enrichSessionsFromStore(
  sessions: CopilotSession[],
  storeEntries: Record<string, SessionStoreEntry>
): void {
  for (const session of sessions) {
    // Try to find matching store entry by sessionId
    const entry = storeEntries[session.sessionId];
    if (entry) {
      if (entry.title) {
        session.title = entry.title;
      }
      if (entry.timing?.created && session.startTime === 0) {
        session.startTime = entry.timing.created;
      }
      if (entry.timing?.lastRequestEnded) {
        session.endTime = Math.max(session.endTime, entry.timing.lastRequestEnded);
      }
      if (entry.stats) {
        session.linesAdded = entry.stats.added || 0;
        session.linesRemoved = entry.stats.removed || 0;
        session.filesModified = entry.stats.fileCount || 0;
      }
    }
  }
}

/**
 * Gets the workspace folder path from a workspace.json file.
 */
export function getWorkspacePath(workspaceStorageDir: string): string | null {
  const wsJson = path.join(workspaceStorageDir, 'workspace.json');
  try {
    const content = JSON.parse(fs.readFileSync(wsJson, 'utf8'));
    if (content.folder) {
      return decodeURIComponent(content.folder.replace('file:///', ''));
    }
  } catch {
    // ignore
  }
  return null;
}
