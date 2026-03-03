import * as vscode from 'vscode';
import type { SessionTracker } from './sessionTracker';

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private static readonly viewType = 'hsBuddy.dashboard';

  private readonly panel: vscode.WebviewPanel;
  private readonly tracker: SessionTracker;
  private readonly disposables: vscode.Disposable[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    tracker: SessionTracker
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal(column);
      DashboardPanel.currentPanel.update();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      'Copilot Dashboard',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri, tracker);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    tracker: SessionTracker
  ) {
    this.panel = panel;
    this.tracker = tracker;

    this.panel.webview.html = this.getHtmlContent();
    this.update();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg: { type: string }) => {
        if (msg.type === 'refresh') {
          this.update();
        }
      },
      null,
      this.disposables
    );

    // Live updates from tracker
    this.tracker.onDidUpdate(() => {
      if (this.panel.visible) {
        this.update();
      }
    }, null, this.disposables);
  }

  public update(): void {
    const totals = this.tracker.getTotals();
    const current = this.tracker.getCurrentSession();
    const sessions = this.tracker.getRecentSessions();
    const activationTime = this.tracker.getActivationTime();

    // Helper to map a CopilotSession to a serializable object
    const mapSession = (s: (typeof sessions)[number]) => ({
      id: s.sessionId.substring(0, 8),
      sessionId: s.sessionId,
      title: s.title || 'Untitled',
      promptTokens: s.promptTokens,
      outputTokens: s.outputTokens,
      estimatedTotal: s.estimatedTotalTokens,
      toolCalls: s.toolCallCount,
      toolsUsed: s.toolsUsed,
      duration: s.durationMs,
      model: s.model?.name ?? 'Unknown',
      modelFamily: s.model?.family ?? 'unknown',
      multiplier: s.model?.multiplierNumeric ?? 1,
      prompts: s.promptCount,
      responses: s.responseCount,
      turns: s.turnCount,
      premiumRequests: s.premiumRequests,
      startTime: s.startTime,
      source: s.source,
      linesAdded: s.linesAdded,
      linesRemoved: s.linesRemoved,
    });

    // Split sessions into active (started since launch) and historical
    const sorted = [...sessions].sort((a, b) => b.startTime - a.startTime);
    const activeSessions = sorted
      .filter(s => s.startTime >= activationTime)
      .map(mapSession);
    const historicalSessions = sorted
      .filter(s => s.startTime < activationTime)
      .slice(0, 50)
      .map(mapSession);

    // Tool usage sorted
    const toolData = Object.entries(totals.toolUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, count]) => ({ name, count }));

    // Model usage sorted
    const modelData = Object.entries(totals.modelUsage)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));

    // Current session
    const currentData = current
      ? {
          sessionId: current.sessionId,
          title: current.title || 'Untitled',
          model: current.model?.name ?? 'Unknown',
          prompts: current.prompts,
          responses: current.responses,
          promptTokens: current.promptTokens,
          outputTokens: current.outputTokens,
          toolCalls: current.toolCalls,
          duration: current.durationMs,
          premiumRequests: current.premiumRequests,
          toolUsage: Object.entries(current.toolUsage)
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => ({ name, count })),
        }
      : null;

    this.panel.webview.postMessage({
      type: 'update',
      totals: {
        sessions: totals.totalSessions,
        prompts: totals.totalPrompts,
        responses: totals.totalResponses,
        turns: totals.totalTurns,
        toolCalls: totals.totalToolCalls,
        toolCallSuccesses: totals.totalToolCallSuccesses,
        toolCallFailures: totals.totalToolCallFailures,
        promptTokens: totals.totalPromptTokens,
        outputTokens: totals.totalOutputTokens,
        estimatedTokens: totals.totalEstimatedTotalTokens,
        premiumRequests: totals.totalPremiumRequests,
        linesAdded: totals.totalLinesAdded,
        linesRemoved: totals.totalLinesRemoved,
        filesModified: totals.totalFilesModified,
        duration: totals.totalDuration,
      },
      current: currentData,
      activeSessions,
      historicalSessions,
      tools: toolData,
      models: modelData,
    });
  }

  private dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private getHtmlContent(): string {
    const webview = this.panel.webview;
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'dashboard.css')
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'dashboard.js')
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link href="${cssUri.toString()}" rel="stylesheet">
  <title>Copilot Dashboard</title>
</head>
<body>
  <div class="dashboard">

    <!-- Header -->
    <header class="header">
      <div class="header-left">
        <h1>Copilot Dashboard</h1>
        <span class="subtitle">HemSoft Buddy</span>
      </div>
      <button class="refresh-btn" id="refreshBtn" title="Refresh">&#x21bb;</button>
    </header>

    <!-- Active Sessions (since launch) -->
    <section class="panel session-panel" id="activePanel">
      <h2>Active Sessions</h2>
      <p class="section-hint" id="activeHint">Sessions started since this VS Code instance launched</p>
      <div class="session-list" id="activeSessionList"></div>
    </section>

    <!-- Historical Sessions (from storage) -->
    <section class="panel session-panel" id="historyPanel">
      <h2>Session History</h2>
      <p class="section-hint" id="historyHint">Previous sessions from storage</p>
      <div class="session-list" id="historySessionList"></div>
    </section>

    <!-- Aggregate Stats -->
    <section class="panel" id="statsPanel">
      <h2>Aggregate Totals</h2>
      <div class="kpi-grid" id="kpiGrid">
        <div class="kpi-card">
          <div class="kpi-value" id="kpiSessions">0</div>
          <div class="kpi-label">Sessions</div>
        </div>
        <div class="kpi-card premium">
          <div class="kpi-value" id="kpiPremium">0</div>
          <div class="kpi-label">Premium Requests</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value" id="kpiTokens">0</div>
          <div class="kpi-label">Total Tokens</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value" id="kpiTools">0</div>
          <div class="kpi-label">Tool Calls</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value" id="kpiCost">$0.00</div>
          <div class="kpi-label">Est. Cost</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value" id="kpiDuration">0m</div>
          <div class="kpi-label">Total Duration</div>
        </div>
      </div>
    </section>

    <!-- Two-column: Tools + Models -->
    <section class="two-col">
      <div class="panel">
        <h2>Top Tools</h2>
        <div class="bar-list" id="toolList"></div>
      </div>
      <div class="panel">
        <h2>Model Usage</h2>
        <div class="bar-list" id="modelList"></div>
      </div>
    </section>

  </div>

  <script nonce="${nonce}" src="${jsUri.toString()}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
