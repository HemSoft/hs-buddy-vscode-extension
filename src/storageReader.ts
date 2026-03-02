import * as fs from 'fs';
import * as path from 'path';

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
    const fullDir = path.join(wsRoot, dir);
    const copilotDir = path.join(fullDir, 'GitHub.copilot-chat');
    const chatSessionsDir = path.join(fullDir, 'chatSessions');
    if (fs.existsSync(copilotDir) || fs.existsSync(chatSessionsDir)) {
      result.push(fullDir);
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
