// @ts-check
/// <reference lib="dom" />

(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();

  // ─── Helpers ───────────────────────────────────────────

  function fmt(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function fmtDuration(ms) {
    if (ms <= 0) return '0s';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return m + 'm ' + rs + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  function fmtTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function premiumCost(premiumRequests) {
    return premiumRequests * 0.04;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Color palette for bars
  const COLORS = [
    'var(--accent-blue)',
    'var(--accent-green)',
    'var(--accent-orange)',
    'var(--accent-purple)',
    'var(--accent-cyan)',
    'var(--accent-red)',
    'var(--accent)',
  ];

  function getColor(i) {
    return COLORS[i % COLORS.length];
  }

  // ─── Session List Rendering ────────────────────────────

  /**
   * Render a list of session cards into a container.
   * @param {string} containerId - DOM element id
   * @param {Array} sessions - session data array
   * @param {object|null} currentSession - the live current session (to match and mark as LIVE)
   * @param {string} emptyMsg - message when no sessions
   */
  function renderSessionList(containerId, sessions, currentSession, emptyMsg) {
    const container = document.getElementById(containerId);
    if (!sessions || sessions.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">&#x1F4AD;</div><div>' + emptyMsg + '</div></div>';
      return;
    }

    container.innerHTML = sessions.map(s => {
      const totalTokens = s.promptTokens + s.outputTokens;
      const tokenStr = totalTokens > 0 ? fmt(totalTokens) : (s.estimatedTotal > 0 ? '~' + fmt(s.estimatedTotal) : '0');
      const isLive = currentSession && currentSession.sessionId && s.sessionId && s.sessionId.startsWith(currentSession.sessionId);
      const timeStr = fmtTime(s.startTime);
      const dateStr = fmtDate(s.startTime);

      return '<div class="session-card' + (isLive ? ' session-live' : '') + '">' +
        '<div class="session-icon">&#x1F4AC;</div>' +
        '<div class="session-main">' +
          '<div class="session-title-row">' +
            '<span class="session-title">' + escapeHtml(s.title) + '</span>' +
            (isLive ? '<span class="session-badge live">Active</span>' : '') +
          '</div>' +
          '<div class="session-meta">' +
            '<span class="session-model">' + escapeHtml(s.model) + '</span>' +
            '<span class="session-sep">&middot;</span>' +
            '<span>' + s.prompts + ' prompt' + (s.prompts !== 1 ? 's' : '') + '</span>' +
            '<span class="session-sep">&middot;</span>' +
            '<span>' + tokenStr + ' tokens</span>' +
            (s.toolCalls > 0 ? '<span class="session-sep">&middot;</span><span>' + s.toolCalls + ' tools</span>' : '') +
            (s.premiumRequests > 0 ? '<span class="session-sep">&middot;</span><span class="session-premium">' + s.premiumRequests + ' premium</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="session-right">' +
          '<span class="session-time">' + dateStr + ' ' + timeStr + '</span>' +
          '<span class="session-duration">' + fmtDuration(s.duration) + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // ─── KPI Rendering ────────────────────────────────────

  function renderKPIs(totals) {
    const el = (id) => document.getElementById(id);
    const totalTokens = totals.promptTokens + totals.outputTokens || totals.estimatedTokens;
    el('kpiSessions').textContent = fmt(totals.sessions);
    el('kpiPremium').textContent = fmt(totals.premiumRequests);
    el('kpiTokens').textContent = fmt(totalTokens);
    el('kpiTools').textContent = fmt(totals.toolCalls);
    el('kpiCost').textContent = '$' + premiumCost(totals.premiumRequests).toFixed(2);
    el('kpiDuration').textContent = fmtDuration(totals.duration);
  }

  // ─── Bar List Rendering ───────────────────────────────

  function renderBarList(containerId, items, defaultColor) {
    const container = document.getElementById(containerId);
    if (!items || items.length === 0) {
      container.innerHTML = '<div class="empty-state">No data</div>';
      return;
    }
    const max = Math.max(...items.map(i => i.count), 1);
    container.innerHTML = items.map((item, idx) => {
      const pct = (item.count / max) * 100;
      const color = defaultColor || getColor(idx);
      return '<div class="bar-item">' +
        '<span class="bar-item-name" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</span>' +
        '<div class="bar-item-track">' +
          '<div class="bar-item-fill" style="width:' + pct + '%;background:' + color + '"></div>' +
        '</div>' +
        '<span class="bar-item-count">' + fmt(item.count) + '</span>' +
      '</div>';
    }).join('');
  }

  // ─── Message Handler ───────────────────────────────────

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type !== 'update') return;

    // Active sessions panel
    const activePanel = document.getElementById('activePanel');
    const activeHint = document.getElementById('activeHint');
    const activeCount = (msg.activeSessions || []).length;
    if (activeCount > 0) {
      activePanel.style.display = '';
      activeHint.textContent = activeCount + ' session' + (activeCount !== 1 ? 's' : '') + ' started since launch';
      renderSessionList('activeSessionList', msg.activeSessions, msg.current, '');
    } else if (msg.current) {
      // No sessions in recentSessions since launch, but we have a live currentSession
      activePanel.style.display = '';
      activeHint.textContent = 'Live session';
      var liveAsSession = {
        sessionId: msg.current.sessionId || '',
        id: (msg.current.sessionId || '').substring(0, 8),
        title: msg.current.title,
        model: msg.current.model,
        prompts: msg.current.prompts,
        responses: msg.current.responses,
        promptTokens: msg.current.promptTokens,
        outputTokens: msg.current.outputTokens,
        estimatedTotal: 0,
        toolCalls: msg.current.toolCalls,
        duration: msg.current.duration,
        premiumRequests: msg.current.premiumRequests,
        startTime: Date.now(),
        source: 'chatSessions',
      };
      renderSessionList('activeSessionList', [liveAsSession], msg.current, '');
    } else {
      activePanel.style.display = '';
      renderSessionList('activeSessionList', [], null, 'No active sessions \u2014 start a Copilot chat to see sessions here');
    }

    // Historical sessions panel
    renderSessionList('historySessionList', msg.historicalSessions, msg.current, 'No historical sessions found');

    var historyHint = document.getElementById('historyHint');
    var histCount = (msg.historicalSessions || []).length;
    historyHint.textContent = histCount + ' session' + (histCount !== 1 ? 's' : '') + ' from storage';

    // KPIs
    renderKPIs(msg.totals);

    // Tools + Models
    renderBarList('toolList', msg.tools);
    renderBarList('modelList', msg.models, 'var(--accent-purple)');
  });

  // ─── Refresh Button ────────────────────────────────────

  document.getElementById('refreshBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });
})();
