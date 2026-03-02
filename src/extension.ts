import * as vscode from 'vscode';
import { SessionTracker } from './sessionTracker';
import { formatTokens } from './tokenEstimator';

let tracker: SessionTracker;

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('HemSoft Buddy');
  outputChannel.appendLine('HemSoft Buddy is now active.');

  // Initialize session tracker with output channel for logging
  tracker = new SessionTracker(context.globalState, outputChannel);

  // Status bar item with live data
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'hs-buddy.showMenu';
  updateStatusBar(statusBarItem);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Update status bar when tracker data changes
  tracker.onDidUpdate(() => updateStatusBar(statusBarItem));

  // Start the filesystem watcher for real-time event tracking
  tracker.startWatcher();

  // Run initial scan on activation
  void tracker.scan().then(count => {
    if (count > 0) {
      outputChannel.appendLine(`Found ${count} new Copilot sessions.`);
    }
  });

  // Start periodic scanning
  const scanInterval = vscode.workspace.getConfiguration('hsBuddy').get<number>('scanIntervalMinutes', 5);
  tracker.startPeriodicScan(scanInterval);

  // Quick Pick menu command
  context.subscriptions.push(
    vscode.commands.registerCommand('hs-buddy.showMenu', async () => {
      const selection = await vscode.window.showQuickPick(
        [
          { label: '$(pulse) View Totals', description: 'See running totals across all sessions', id: 'totals' },
          { label: '$(history) Session History', description: 'Browse past sessions', id: 'sessionHistory' },
          { label: '$(sync) Scan Now', description: 'Scan for new Copilot sessions', id: 'scan' },
          { label: '$(export) Export Session Data', description: 'Export sessions to JSON file', id: 'export' },
          { label: '$(trash) Reset Data', description: 'Clear all tracked session data', id: 'reset' },
          { label: '$(gear) Settings', description: 'Configure HemSoft Buddy', id: 'settings' },
        ],
        { placeHolder: 'HemSoft Buddy - Copilot Sessions' }
      );

      if (selection) {
        switch (selection.id) {
          case 'totals':
            await showTotalsPanel(tracker);
            break;
          case 'sessionHistory':
            await showSessionHistory(tracker);
            break;
          case 'scan':
            await runManualScan(tracker, outputChannel);
            break;
          case 'export':
            await exportSessionData(tracker);
            break;
          case 'reset':
            await resetSessionData(tracker);
            break;
          case 'settings':
            vscode.commands.executeCommand('workbench.action.openSettings', 'hsBuddy');
            break;
        }
      }
    })
  );

  // Keep hello world for verification
  context.subscriptions.push(
    vscode.commands.registerCommand('hs-buddy.helloWorld', () => {
      vscode.window.showInformationMessage('Hello from HemSoft Buddy!');
    })
  );
}

export function deactivate() {
  tracker?.dispose();
}

function updateStatusBar(item: vscode.StatusBarItem): void {
  item.text = tracker.getStatusBarText();
  item.tooltip = tracker.getStatusBarTooltip();
}

async function showTotalsPanel(t: SessionTracker): Promise<void> {
  const totals = t.getTotals();
  if (totals.totalSessions === 0) {
    vscode.window.showInformationMessage('No sessions tracked yet. Click "Scan Now" to discover sessions.');
    return;
  }

  const hasRealTokens = totals.totalPromptTokens + totals.totalOutputTokens > 0;

  const lines = [
    `**Copilot Session Totals**`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Sessions | ${totals.totalSessions} |`,
    `| Turns | ${totals.totalTurns} |`,
    `| Prompts | ${totals.totalPrompts} |`,
    `| Responses | ${totals.totalResponses} |`,
  ];

  if (hasRealTokens) {
    lines.push(
      `| Tokens (total) | ${formatTokens(totals.totalPromptTokens + totals.totalOutputTokens)} |`,
      `| Tokens (input) | ${formatTokens(totals.totalPromptTokens)} |`,
      `| Tokens (output) | ${formatTokens(totals.totalOutputTokens)} |`,
    );
  } else {
    lines.push(
      `| Est. Tokens (total) | ~${formatTokens(totals.totalEstimatedTotalTokens)} |`,
      `| Est. Tokens (input) | ~${formatTokens(totals.totalEstimatedInputTokens)} |`,
      `| Est. Tokens (output) | ~${formatTokens(totals.totalEstimatedOutputTokens)} |`,
    );
  }

  lines.push(
    `| Tool Calls | ${totals.totalToolCalls} (${totals.totalToolCallSuccesses} ok / ${totals.totalToolCallFailures} fail) |`,
    `| Lines Added | +${totals.totalLinesAdded} |`,
    `| Lines Removed | -${totals.totalLinesRemoved} |`,
    `| Files Modified | ${totals.totalFilesModified} |`,
    ``,
  );

  if (hasRealTokens) {
    lines.push(`> *Token counts from Copilot API usage data (chatSessions).*`);
  } else {
    lines.push(
      `> *Token estimates based on visible transcript text (~4 chars/token).*`,
      `> *Actual usage is higher — system prompts, file context, and tool results are not captured in transcripts.*`,
    );
  }
  lines.push(``);

  // Model usage breakdown
  const modelEntries = Object.entries(totals.modelUsage).sort((a, b) => b[1] - a[1]);
  if (modelEntries.length > 0) {
    lines.push(`**Model Usage**`);
    lines.push(``);
    lines.push(`| Model | Sessions |`);
    lines.push(`|-------|----------|`);
    for (const [model, count] of modelEntries) {
      lines.push(`| ${model} | ${count} |`);
    }
    lines.push(``);
  }

  // Top tools
  const toolEntries = Object.entries(totals.toolUsage).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (toolEntries.length > 0) {
    lines.push(`**Top Tools**`);
    lines.push(``);
    lines.push(`| Tool | Calls |`);
    lines.push(`|------|-------|`);
    for (const [tool, count] of toolEntries) {
      lines.push(`| ${tool} | ${count} |`);
    }
  }

  const doc = await vscode.workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function showSessionHistory(t: SessionTracker): Promise<void> {
  const items = t.getHistoryQuickPickItems();
  await vscode.window.showQuickPick(items, {
    placeHolder: 'Session History (most recent first)',
    matchOnDescription: true,
    matchOnDetail: true,
  });
}

async function runManualScan(t: SessionTracker, outputChannel: vscode.OutputChannel): Promise<void> {
  const count = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Scanning for Copilot sessions...' },
    () => t.scan()
  );

  if (count > 0) {
    vscode.window.showInformationMessage(`Found ${count} new Copilot session(s).`);
    outputChannel.appendLine(`Manual scan: found ${count} new sessions.`);
  } else {
    vscode.window.showInformationMessage('No new sessions found.');
  }
}

async function exportSessionData(t: SessionTracker): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`copilot-sessions-${new Date().toISOString().split('T')[0]}.json`),
    filters: { 'JSON Files': ['json'] },
  });

  if (uri) {
    const data = Buffer.from(t.getExportData(), 'utf8');
    await vscode.workspace.fs.writeFile(uri, data);
    vscode.window.showInformationMessage(`Session data exported to ${uri.fsPath}`);
  }
}

async function resetSessionData(t: SessionTracker): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    'Reset all tracked session data? This cannot be undone.',
    { modal: true },
    'Reset'
  );

  if (confirm === 'Reset') {
    await t.reset();
    vscode.window.showInformationMessage('Session data has been reset.');
  }
}
