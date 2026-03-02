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
    if (ms < 1000) return ms + 'ms';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return m + 'm ' + rs + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function fmtTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  /** Estimate cost: rough per-model pricing */
  function estimateCost(promptTokens, outputTokens) {
    // Claude Sonnet 4 pricing as default estimate ($/1M tokens)
    const inputRate = 3.0;
    const outputRate = 15.0;
    return (promptTokens * inputRate + outputTokens * outputRate) / 1e6;
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

  // ─── Render Functions ──────────────────────────────────

  function renderKPIs(totals) {
    const el = (id) => document.getElementById(id);
    const totalTokens = totals.promptTokens + totals.outputTokens || totals.estimatedTokens;
    el('kpiSessions').textContent = fmt(totals.sessions);
    el('kpiTokens').textContent = fmt(totalTokens);
    el('kpiTools').textContent = fmt(totals.toolCalls);
    el('kpiCost').textContent = '$' + estimateCost(totals.promptTokens, totals.outputTokens).toFixed(2);
    el('kpiCode').textContent = '+' + fmt(totals.linesAdded) + ' / -' + fmt(totals.linesRemoved);
    el('kpiDuration').textContent = fmtDuration(totals.duration);
  }

  function renderCurrentSession(current) {
    const section = document.getElementById('currentSession');
    const toolsPanel = document.getElementById('csToolsPanel');
    if (!current) {
      section.style.display = 'none';
      toolsPanel.style.display = 'none';
      return;
    }

    section.style.display = 'flex';
    document.getElementById('csTitle').textContent = current.title;
    document.getElementById('csModel').textContent = current.model;
    document.getElementById('csPrompts').textContent = String(current.prompts);
    document.getElementById('csResponses').textContent = String(current.responses);
    document.getElementById('csTokens').textContent = fmt(current.promptTokens + current.outputTokens);
    document.getElementById('csTools').textContent = String(current.toolCalls);
    document.getElementById('csDuration').textContent = fmtDuration(current.duration);

    if (current.toolUsage && current.toolUsage.length > 0) {
      toolsPanel.style.display = 'block';
      renderBarList('csToolList', current.toolUsage, 'var(--accent-cyan)');
    } else {
      toolsPanel.style.display = 'none';
    }
  }

  function renderTokenChart(sessions) {
    const container = document.getElementById('tokenChart');
    if (!sessions || sessions.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">&#x1F4CA;</div><div>No session data yet</div></div>';
      return;
    }

    const barWidth = 28;
    const barGap = 4;
    const chartHeight = 180;
    const labelHeight = 40;
    const topPad = 10;
    const totalWidth = Math.max(sessions.length * (barWidth + barGap) + 40, container.clientWidth);

    // Find max tokens for scaling
    const maxTokens = Math.max(...sessions.map(s => s.promptTokens + s.outputTokens || s.estimatedTotal), 1);

    let svg = `<svg width="${totalWidth}" height="${chartHeight + labelHeight + topPad}" xmlns="http://www.w3.org/2000/svg">`;

    // Grid lines
    for (let i = 0; i <= 4; i++) {
      const y = topPad + (chartHeight / 4) * i;
      const val = fmt(Math.round(maxTokens * (1 - i / 4)));
      svg += `<line x1="35" y1="${y}" x2="${totalWidth}" y2="${y}" stroke="rgba(128,128,128,0.12)" stroke-width="1"/>`;
      svg += `<text x="30" y="${y + 4}" fill="var(--text-muted)" font-size="9" text-anchor="end" font-family="var(--vscode-font-family)">${val}</text>`;
    }

    sessions.forEach((s, i) => {
      const x = 40 + i * (barWidth + barGap);
      const total = s.promptTokens + s.outputTokens || s.estimatedTotal;
      const fullH = (total / maxTokens) * chartHeight;
      const promptH = total > 0 ? (s.promptTokens / total) * fullH : 0;
      const outputH = fullH - promptH;

      const yBase = topPad + chartHeight - fullH;

      // Output tokens (bottom, blue)
      svg += `<rect class="chart-bar" x="${x}" y="${yBase + promptH}" width="${barWidth}" height="${Math.max(outputH, 0)}" rx="2" fill="var(--accent-blue)" opacity="0.85"
        data-idx="${i}"/>`;

      // Prompt tokens (top, green)
      svg += `<rect class="chart-bar" x="${x}" y="${yBase}" width="${barWidth}" height="${Math.max(promptH, 0)}" rx="2" fill="var(--accent-green)" opacity="0.85"
        data-idx="${i}"/>`;

      // Label
      const label = s.id;
      svg += `<text x="${x + barWidth / 2}" y="${topPad + chartHeight + 14}" fill="var(--text-muted)" font-size="9" text-anchor="middle" font-family="var(--vscode-font-family)" transform="rotate(-35, ${x + barWidth / 2}, ${topPad + chartHeight + 14})">${escapeHtml(label)}</text>`;
    });

    // Legend
    const lx = totalWidth - 200;
    svg += `<rect x="${lx}" y="${topPad}" width="10" height="10" rx="2" fill="var(--accent-green)" opacity="0.85"/>`;
    svg += `<text x="${lx + 14}" y="${topPad + 9}" fill="var(--text-muted)" font-size="10" font-family="var(--vscode-font-family)">Prompt</text>`;
    svg += `<rect x="${lx + 70}" y="${topPad}" width="10" height="10" rx="2" fill="var(--accent-blue)" opacity="0.85"/>`;
    svg += `<text x="${lx + 84}" y="${topPad + 9}" fill="var(--text-muted)" font-size="10" font-family="var(--vscode-font-family)">Output</text>`;

    svg += `</svg>`;
    container.innerHTML = svg;

    // Tooltip on hover
    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    tooltip.style.display = 'none';
    document.body.appendChild(tooltip);

    container.addEventListener('mouseover', (e) => {
      const bar = e.target.closest('.chart-bar');
      if (!bar) { tooltip.style.display = 'none'; return; }
      const idx = parseInt(bar.getAttribute('data-idx'));
      const s = sessions[idx];
      if (!s) return;
      const total = s.promptTokens + s.outputTokens;
      tooltip.innerHTML = `
        <div class="tt-title">${escapeHtml(s.title)}</div>
        <div class="tt-row"><span class="tt-label">Model</span><span>${escapeHtml(s.model)}</span></div>
        <div class="tt-row"><span class="tt-label">Prompt</span><span>${fmt(s.promptTokens)}</span></div>
        <div class="tt-row"><span class="tt-label">Output</span><span>${fmt(s.outputTokens)}</span></div>
        <div class="tt-row"><span class="tt-label">Total</span><span>${fmt(total)}</span></div>
        <div class="tt-row"><span class="tt-label">Tools</span><span>${s.toolCalls}</span></div>
        <div class="tt-row"><span class="tt-label">Duration</span><span>${fmtDuration(s.duration)}</span></div>
      `;
      tooltip.style.display = 'block';
    });

    container.addEventListener('mousemove', (e) => {
      tooltip.style.left = (e.pageX + 12) + 'px';
      tooltip.style.top = (e.pageY - 8) + 'px';
    });

    container.addEventListener('mouseout', (e) => {
      if (!e.target.closest('.chart-bar')) {
        tooltip.style.display = 'none';
      }
    });
  }

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
      return `<div class="bar-item">
        <span class="bar-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        <div class="bar-item-track">
          <div class="bar-item-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        <span class="bar-item-count">${fmt(item.count)}</span>
      </div>`;
    }).join('');
  }

  function renderTimeline(sessions) {
    const container = document.getElementById('sessionTimeline');
    if (!sessions || sessions.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">&#x23F3;</div><div>No sessions tracked yet</div></div>';
      return;
    }

    // Show most recent first
    const sorted = [...sessions].reverse().slice(0, 20);

    container.innerHTML = sorted.map(s => {
      const total = s.promptTokens + s.outputTokens;
      const tokenStr = total > 0 ? fmt(total) + ' tok' : '~' + fmt(s.estimatedTotal) + ' tok';
      const timeStr = fmtDate(s.startTime) + ' ' + fmtTime(s.startTime);

      return `<div class="timeline-item">
        <div class="tl-time">${timeStr}</div>
        <div class="tl-dot source-${s.source}"></div>
        <div class="tl-content">
          <div class="tl-title">${escapeHtml(s.title)}</div>
          <div class="tl-meta">
            <span class="tl-tag">${escapeHtml(s.model)}</span>
            <span>${s.prompts}p ${s.turns}t</span>
            <span>${s.toolCalls} tools</span>
            <span>${fmtDuration(s.duration)}</span>
            ${s.linesAdded || s.linesRemoved ? `<span>+${s.linesAdded}/-${s.linesRemoved}</span>` : ''}
          </div>
        </div>
        <div class="tl-tokens">${tokenStr}</div>
      </div>`;
    }).join('');
  }

  // ─── Message Handler ───────────────────────────────────

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type !== 'update') return;

    renderKPIs(msg.totals);
    renderCurrentSession(msg.current);
    renderTokenChart(msg.sessions);
    renderBarList('toolList', msg.tools);
    renderBarList('modelList', msg.models, 'var(--accent-purple)');
    renderTimeline(msg.sessions);
  });

  // ─── Refresh Button ────────────────────────────────────

  document.getElementById('refreshBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });
})();
