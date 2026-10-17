/**
 * Token Watcher — Menubar App Renderer
 *
 * Self-contained vanilla JavaScript application.
 * Uses the quotaApi exposed via Electron contextBridge.
 * No framework dependencies — just DOM APIs.
 */

(function () {
  "use strict";

  const api = window.quotaApi;
  if (!api) {
    document.getElementById("root").innerHTML =
      '<div class="empty-state"><div class="icon">⚠</div><div class="text">quotaApi not available</div><div class="hint">This app must run inside the Electron shell.</div></div>';
    return;
  }

  // ===========================================================================
  // State
  // ===========================================================================
  let activeTab = 0;
  let quotaProviderFilter = "all";
  let quotaData = null;
  let tokenData = null;
  let alerts = [];
  let budgetState = null;
  let historyReadError = null;
  let pricingOverrides = [];
  let pricingSnapshot = null;
  let apikeyStatus = null;
  let isLoading = false;
  let toastTimer = null;
  let showAllModels = false;
  let theme = "light";
  let showMergedTokens = false;
  let mergedTokenData = null;
  let historyProviders = [];
  let historyProvidersLoaded = false;
  let historyProvider = null;
  let historyDays = 7;
  let historyQuota = [];
  let historyAccounting = [];
  let historyAccount = "all";
  let historyWindow = null;
  let resetEvents = [];
  let resetStatus = "";
  let historyResets = [];
  let historySourceModels = [];
  let historyGroupBy = "All";
  let historyBurningSessions = [];
  let historyBurningWindowLabel = "";

  // ===========================================================================
  // DOM helpers
  // ===========================================================================
  const $ = (sel, parent) => (parent || document).querySelector(sel);
  const $$ = (sel, parent) => [...(parent || document).querySelectorAll(sel)];
  const el = (tag, attrs, ...children) => {
    const e = document.createElement(tag);
    if (attrs)
      Object.entries(attrs).forEach(([k, v]) => {
        if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "className") e.className = v;
        else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
        else if (k === "disabled") {
          if (v) e.setAttribute("disabled", "");
        } else e.setAttribute(k, v);
      });
    children.forEach((c) => {
      if (c == null) return;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
  };

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function formatNumber(n) {
    if (n == null) return "0";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
    return String(Math.round(n));
  }

  function showToast(msg, type) {
    const existing = $(".toast");
    if (existing) existing.remove();
    if (toastTimer) clearTimeout(toastTimer);
    const toast = el(
      "div",
      { className: "toast " + (type === "error" ? "toast-error" : "toast-success") },
      msg,
    );
    document.body.appendChild(toast);
    toastTimer = setTimeout(() => toast.remove(), 3000);
  }

  // Global Escape key handler – closes the topmost modal overlay
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const overlays = $$(".modal-overlay");
    if (overlays.length > 0) overlays[overlays.length - 1].remove();
  });

  // ===========================================================================
  // API calls
  // ===========================================================================
  async function refreshQuota() {
    setLoading(true);
    try {
      receiveQuotaSnapshot(await api.quota.fetch(true));
    } catch (e) {
      showToast(e.message, "error");
    }
    setLoading(false);
    renderContent();
  }

  function receiveQuotaSnapshot(snapshot) {
    if (quotaData && snapshot.revision < quotaData.revision) return;
    quotaData = snapshot;
    if (activeTab === 0) renderContent();
  }

  async function fetchTokens(explicitWindow) {
    setLoading(true);
    try {
      const window = explicitWindow || "week";
      tokenData = await api.tokens.query({ window });
    } catch (e) {
      showToast(e.message, "error");
    }
    setLoading(false);
    renderTokenUsage();
  }

  async function fetchMergedTokens() {
    setLoading(true);
    try {
      mergedTokenData = await api.tokens.merged();
      showMergedTokens = true;
    } catch (e) {
      showToast(e.message, "error");
    }
    setLoading(false);
    renderTokenUsage();
  }

  async function loadAlerts() {
    try {
      alerts = await api.alerts.list();
      receiveBudgetState(await api.alerts.state());
    } catch (e) {
      /* ignore */
    }
    if (activeTab === 2) renderAlerts();
  }

  function receiveBudgetState(state) {
    if (budgetState && state.revision < budgetState.revision) return;
    budgetState = state;
    if (state.evaluatedAt !== null) alerts = state.rules;
    if (activeTab === 2) renderAlerts();
  }

  async function loadPricing() {
    try {
      const data = await api.pricing.list();
      pricingOverrides = data.overrides || [];
      pricingSnapshot = data.snapshot;
    } catch (e) {
      /* ignore */
    }
    if (activeTab === 3) renderPricing();
  }

  async function loadApikeyStatus() {
    try {
      apikeyStatus = await api.apikeys.status();
    } catch (e) {
      /* ignore */
    }
    if (activeTab === 4) renderApiKeys();
  }

  async function loadHistory() {
    historyReadError = null;
    try {
      if (!historyProvidersLoaded) {
        historyProviders = await api.dashboardHistory.listProviders();
        historyProvidersLoaded = true;
        if (!historyProvider && historyProviders.length > 0) historyProvider = historyProviders[0];
      }

      resetEvents = api.resets ? await api.resets.events() : [];
      resetStatus = api.resets ? await api.resets.status() : "";
      if (historyProvider) {
        const [quota, resets, accounting] = await Promise.all([
          api.dashboardHistory.quotaHistory(historyProvider, historyDays),
          api.dashboardHistory.weeklyResets(
            historyProvider,
            Math.max(1, Math.ceil(historyDays / 7)),
          ),
          api.dashboardHistory.accountingHistory(historyProvider, historyDays),
        ]);
        historyQuota = quota || [];
        historyResets = resets || [];
        historyAccounting = accounting || [];
      } else {
        historyQuota = [];
        historyResets = [];
        historyAccounting = [];
      }

      // Source-grouped model cost breakdown over the selected range - reuses
      // the exact same aggregation + source labels as the Tokens tab, rather
      // than the DB-backed (canonical-provider-only) breakdown, so "sort by
      // source" (opencode/claudecode/copilot/...) actually has something to
      // sort by.
      const untilMs = Date.now();
      const sinceMs = untilMs - historyDays * 24 * 60 * 60 * 1000;
      const usage = await api.tokens.query({ sinceMs, untilMs });
      historySourceModels = (usage.aggregate && usage.aggregate.bySourceModel) || [];

      await loadHistoryBurningSessions();
    } catch (e) {
      historyReadError = "History unavailable: local observations could not be read";
    }
    if (activeTab === 5) renderHistory();
  }

  function findActiveBurnWindow() {
    // A local rolling lookback, never presented as a provider's fixed window.
    return { sinceMs: Date.now() - 5 * 60 * 60 * 1000, label: "Last 5 Hours" };
  }

  async function loadHistoryBurningSessions() {
    const windowInfo = findActiveBurnWindow();
    historyBurningWindowLabel = windowInfo.label;
    try {
      const usage = await api.tokens.query({ sinceMs: windowInfo.sinceMs, untilMs: Date.now() });
      historyBurningSessions = (usage.aggregate && usage.aggregate.bySession) || [];
    } catch (e) {
      historyBurningSessions = [];
    }
  }

  function setLoading(v) {
    isLoading = v;
    const btn = $(".btn-refresh");
    if (btn) {
      btn.textContent = v ? "⟳ Refreshing..." : "⟳ Refresh";
      btn.disabled = v;
    }
  }

  // ===========================================================================
  // Render engine
  // ===========================================================================
  const root = document.getElementById("root");

  function render() {
    clear(root);
    root.appendChild(renderHeader());
    root.appendChild(renderTabNav());
    const content = el("div", {
      style: { flex: "1", overflow: "hidden", display: "flex", flexDirection: "column" },
    });
    root.appendChild(content);

    const contentArea = el("div", {
      className: "tab-content",
      style: { flex: "1", overflowY: "auto" },
    });
    content.appendChild(contentArea);

    renderContentInto(contentArea);
  }

  function renderContentInto(container) {
    clear(container);
    switch (activeTab) {
      case 0:
        renderDashboardInto(container);
        break;
      case 1:
        renderTokenUsageInto(container);
        break;
      case 2:
        renderAlertsInto(container);
        break;
      case 3:
        renderPricingInto(container);
        break;
      case 4:
        renderApiKeysInto(container);
        break;
      case 5:
        renderHistoryInto(container);
        break;
    }
  }

  function renderContent() {
    updateTabNavHighlight();
    renderContentInto($(".tab-content"));
  }

  function updateTabNavHighlight() {
    const btns = $$(".tab-btn");
    btns.forEach((btn, i) => {
      if (i === activeTab) btn.classList.add("active");
      else btn.classList.remove("active");
    });
  }

  // ===========================================================================
  // Header
  // ===========================================================================
  function renderHeader() {
    const themeLabel = theme === "dark" ? "☀ Light" : "☾ Dark";
    const themeTitle = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
    return el(
      "div",
      { className: "app-header" },
      el("h1", {}, getActiveTabTitle()),
      el(
        "div",
        { className: "header-actions" },
        el(
          "button",
          { className: "btn btn-small btn-refresh", onClick: refreshQuota },
          "⟳ Refresh",
        ),
        el(
          "button",
          { className: "btn btn-small", onClick: toggleTheme, title: themeTitle },
          themeLabel,
        ),
        el("button", { className: "btn-icon", onClick: () => api.app.quit(), title: "Quit" }, "✕"),
      ),
    );
  }

  // ===========================================================================
  // Tab Nav
  // ===========================================================================
  const TABS = [
    { label: "◉ Dashboard", title: "Dashboard" },
    { label: "⬡ Tokens", title: "Token Usage" },
    { label: "⚠ Alerts", title: "Budget Alerts" },
    { label: "$ Pricing", title: "Pricing" },
    { label: "🔑 API Keys", title: "API Keys" },
    { label: "📈 History", title: "Quota History" },
  ];

  function getActiveTabTitle() {
    return TABS[activeTab]?.title || "Quota Monitor";
  }

  function renderTabNav() {
    const nav = el("div", { className: "tab-nav" });
    TABS.forEach((tab, i) => {
      nav.appendChild(
        el(
          "button",
          {
            className: "tab-btn" + (i === activeTab ? " active" : ""),
            onClick: () => {
              activeTab = i;
              updateHeaderTitle();
              renderContent();
              if (i === 1) fetchTokens();
              if (i === 2) loadAlerts();
              if (i === 3) loadPricing();
              if (i === 4) loadApikeyStatus();
              if (i === 5) loadHistory();
            },
          },
          tab.label,
        ),
      );
    });
    return nav;
  }

  function updateHeaderTitle() {
    const h1 = $(".app-header h1");
    if (h1) h1.textContent = getActiveTabTitle();
  }

  // ===========================================================================
  // Dashboard
  // ===========================================================================

  // Entries that share the same `group` (e.g. "Claude", "OpenCode Go (dvtn)")
  // are rendered as one card with stacked mini-bars, same as OpenCode's own
  // grouped quota display, instead of one full-width card per window.
  const WINDOW_TAG_ORDER = { "5h": 0, hourly: 0, daily: 1, weekly: 2, monthly: 3, yearly: 4 };

  function windowTag(entry) {
    const label = (entry.label || "").trim().replace(/:+$/, "").trim();
    return label || entry.name;
  }

  function groupPercentEntriesByLabel(entries) {
    const byGroup = new Map();
    const others = [];
    for (const e of entries) {
      const key = e.kind !== "value" && e.percentRemaining != null ? (e.group || "").trim() : "";
      if (!key) {
        others.push(e);
        continue;
      }
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(e);
    }

    const groups = new Map();
    for (const [key, list] of byGroup) {
      if (list.length >= 2) {
        list.sort(
          (a, b) =>
            (WINDOW_TAG_ORDER[windowTag(a).toLowerCase()] ?? 99) -
            (WINDOW_TAG_ORDER[windowTag(b).toLowerCase()] ?? 99),
        );
        groups.set(key, list);
      } else {
        others.push(...list);
      }
    }
    return { groups, others };
  }

  function renderGroupedCard(groupName, windows) {
    const card = el("div", { className: "card" });
    card.appendChild(
      el("div", { className: "card-title", style: { marginBottom: "10px" } }, groupName),
    );

    // Find the shortest reset time across all windows for the status line
    let shortestReset = "";
    let shortestDiff = Infinity;
    for (const w of windows) {
      if (w.resetTimeIso) {
        const diff = new Date(w.resetTimeIso) - new Date();
        if (diff > 0 && diff < shortestDiff) {
          shortestDiff = diff;
        }
      }
    }
    if (shortestDiff > 0 && shortestDiff < Infinity) {
      const h = Math.floor(shortestDiff / 3600000);
      const m = Math.floor((shortestDiff % 3600000) / 60000);
      shortestReset = h > 24 ? Math.floor(h / 24) + "d" : h + "h " + m + "m";
    }

    for (const w of windows) {
      const remaining = Math.max(0, Math.min(100, w.percentRemaining || 0));
      const used = 100 - remaining;
      let barClass = "good";
      if (used >= 90) barClass = "danger";
      else if (used >= 75) barClass = "warning";

      const row = el("div", {
        style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" },
      });

      // Window label
      row.appendChild(
        el(
          "span",
          {
            style: {
              width: "52px",
              fontSize: "10px",
              color: "var(--text-secondary)",
              textAlign: "right",
              flexShrink: "0",
            },
          },
          windowTag(w),
        ),
      );

      // Mini bar
      const barWrap = el("div", {
        className: "percent-bar-container",
        style: { flex: "1", margin: "0", height: "12px" },
      });
      barWrap.appendChild(
        el("div", { className: "percent-bar-fill " + barClass, style: { width: used + "%" } }),
      );
      row.appendChild(barWrap);

      // Percentage
      row.appendChild(
        el(
          "span",
          {
            style: {
              width: "36px",
              fontSize: "10px",
              fontFamily: "var(--font-mono)",
              textAlign: "right",
              flexShrink: "0",
              color: "var(--text-primary)",
            },
          },
          Math.round(used) + "%",
        ),
      );

      card.appendChild(row);
    }

    // Reset countdown
    if (shortestReset) {
      card.appendChild(
        el(
          "div",
          {
            style: {
              marginTop: "6px",
              fontSize: "10px",
              color: "var(--text-muted)",
              textAlign: "right",
            },
          },
          "⟳ " + shortestReset,
        ),
      );
    }

    return card;
  }

  function renderDashboardInto(container) {
    if (!quotaData) {
      container.appendChild(
        el(
          "div",
          { className: "empty-state" },
          el("div", { className: "icon" }, "◉"),
          el("div", { className: "text" }, "No quota data loaded"),
          el("div", { className: "hint" }, "Click Refresh to fetch quota status"),
        ),
      );
      return;
    }

    const entries = quotaData.entries || [];
    const providerIds = quotaData.detectedProviderIds || [];
    const errors = quotaData.errors || [];
    const observed = quotaData.lastObservationAt
      ? new Date(quotaData.lastObservationAt).toLocaleTimeString()
      : null;
    const status = quotaData.fetching
      ? "Refreshing quota…"
      : quotaData.previousObservation
        ? "Showing previous observation" + (observed ? " from " + observed : "")
        : quotaData.stale
          ? "Some quota is unavailable"
          : quotaData.lastSuccessAt
            ? "Updated " + new Date(quotaData.lastSuccessAt).toLocaleTimeString()
            : "Waiting for quota";
    container.appendChild(
      el(
        "div",
        {
          className: "quota-refresh-status",
          style: {
            fontSize: "11px",
            color: "var(--text-muted)",
            marginBottom: "8px",
          },
        },
        status,
      ),
    );

    for (const message of quotaData.historyDiagnostics || []) {
      container.appendChild(
        el(
          "div",
          {
            className: "history-diagnostic",
            style: { marginBottom: "8px", color: "var(--text-secondary)" },
          },
          message,
        ),
      );
    }
    // Surface provider-level errors (e.g. Claude CLI session expired) instead
    // of letting the provider silently vanish from the list below.
    for (const err of errors) {
      container.appendChild(
        el(
          "div",
          { className: "alert-indicator triggered", style: { marginBottom: "8px" } },
          el("span", {}, "⚠"),
          el("span", {}, (err.label ? err.label + ": " : "") + err.message),
        ),
      );
    }

    // Filter
    const filterBar = el("div", { className: "filter-bar" });
    const sel = el("select", {
      className: "filter-select",
      onChange: (event) => {
        quotaProviderFilter = event.target.value;
        renderContent();
      },
    });
    sel.appendChild(el("option", { value: "all" }, "All providers (" + providerIds.length + ")"));
    providerIds.forEach((id) => sel.appendChild(el("option", { value: id }, id)));
    filterBar.appendChild(
      el(
        "div",
        { className: "filter-group" },
        el("span", { className: "filter-label" }, "Provider:"),
        sel,
      ),
    );
    filterBar.appendChild(
      el(
        "span",
        { style: { fontSize: "10px", color: "var(--text-muted)", marginLeft: "auto" } },
        providerIds.length + " providers",
      ),
    );
    container.appendChild(filterBar);

    if (quotaProviderFilter !== "all" && !providerIds.includes(quotaProviderFilter))
      quotaProviderFilter = "all";
    sel.value = quotaProviderFilter;
    const filterVal = quotaProviderFilter;
    const filtered =
      filterVal === "all"
        ? entries
        : entries.filter((e) =>
            e.providerId
              ? e.providerId === filterVal
              : e.name && e.name.toLowerCase().includes(filterVal.toLowerCase()),
          );

    // Group entries that share a `group` (e.g. "Claude", "OpenCode Go (dvtn)")
    // into one card; render the rest as individual cards
    const { groups, others } = groupPercentEntriesByLabel(filtered);

    // Sort groups by their most-constrained window's remaining percent (descending)
    const mostConstrained = (ws) => Math.min(...ws.map((w) => w.percentRemaining ?? 0));
    const sortedGroups = [...groups].sort(
      ([, aw], [, bw]) => mostConstrained(bw) - mostConstrained(aw),
    );

    // Merge groups and individual cards into one sorted list
    const merged = [
      ...sortedGroups.map(([groupName, windows]) => {
        const key = -mostConstrained(windows); // negative = sort by remaining desc, groups below value
        return { type: "group", groupName, windows, sortKey: key };
      }),
      ...others.map((entry) => ({
        type: "card",
        entry,
        sortKey:
          entry.percentRemaining == null
            ? -9999 // value entry — pin to top
            : entry.percentRemaining > 0
              ? -entry.percentRemaining // remaining desc
              : 100,
      })), // 0% last
    ].sort((a, b) => a.sortKey - b.sortKey);

    for (const item of merged) {
      if (item.type === "group") {
        container.appendChild(renderGroupedCard(item.groupName, item.windows));
      } else {
        container.appendChild(renderProviderCard(item.entry));
      }
    }
    const selectedDetails = (quotaData.accountingDetails ?? []).filter(
      (row) => filterVal === "all" || row.providerId === filterVal,
    );
    if (selectedDetails.length) {
      const estimates = selectedDetails.filter((row) => row.runway);
      if (estimates.length) {
        const card = el("div", { className: "card runway-estimates" });
        card.appendChild(el("div", { className: "card-title" }, "Fixed-window estimates"));
        for (const row of estimates) {
          card.appendChild(el("div", {}, row.name + ": " + row.runway));
          const reset = row.facts.find((fact) => fact.label === "Reset");
          if (reset) card.appendChild(el("div", { className: "hint" }, "Reset: " + reset.value));
        }
        card.appendChild(
          el(
            "div",
            { className: "hint" },
            "Linear average since fixed-window start; not a recent-rate prediction.",
          ),
        );
        container.appendChild(card);
      }
      container.appendChild(renderAccountingRows(selectedDetails));
    }

    if (quotaData.sessionTokens) {
      const st = quotaData.sessionTokens;
      const card = el("div", { className: "card", style: { marginTop: "12px" } });
      card.appendChild(el("div", { className: "card-title" }, "Session Tokens"));
      card.appendChild(renderKV("Input", formatNumber(st.totalInput)));
      card.appendChild(renderKV("Output", formatNumber(st.totalOutput)));
      container.appendChild(card);
    }
  }

  function renderProviderCard(entry) {
    const card = el("div", { className: "card" });
    const header = el("div", { className: "card-header" });
    header.appendChild(el("span", { className: "card-title" }, entry.name));

    if (entry.kind === "value") {
      header.appendChild(
        el(
          "span",
          { className: "card-subtitle", style: { fontSize: "12px", color: "var(--accent)" } },
          entry.value,
        ),
      );
    }
    card.appendChild(header);

    if (entry.kind !== "value" && entry.percentRemaining != null) {
      const remaining = Math.max(0, Math.min(100, entry.percentRemaining));
      const used = 100 - remaining;
      let barClass = "good";
      if (used >= 90) barClass = "danger";
      else if (used >= 75) barClass = "warning";

      const barContainer = el("div", { className: "percent-bar-container" });
      barContainer.appendChild(
        el("div", { className: "percent-bar-fill " + barClass, style: { width: used + "%" } }),
      );
      card.appendChild(barContainer);

      const label = el("div", { className: "percent-bar-label" });
      label.appendChild(el("span", { className: "value" }, Math.round(used) + "% used"));

      let resetText = "";
      if (entry.resetTimeIso) {
        const diff = new Date(entry.resetTimeIso) - new Date();
        if (diff > 0) {
          const h = Math.floor(diff / 3600000);
          const m = Math.floor((diff % 3600000) / 60000);
          resetText = h > 24 ? Math.floor(h / 24) + "d " + (h % 24) + "h" : h + "h " + m + "m";
        }
      }
      label.appendChild(el("span", { className: "value" }, resetText ? "⟳ " + resetText : ""));
      card.appendChild(label);
    }

    return card;
  }

  function renderAccountingRows(rows) {
    const details = el("details", {
      className: "card accounting-details",
      style: { overflowWrap: "anywhere", minWidth: "0" },
    });
    details.appendChild(
      el(
        "summary",
        { className: "card-title", style: { cursor: "pointer" } },
        "Balances and usage details",
      ),
    );
    for (const row of rows) {
      const item = el("div", {
        className: "accounting-detail-row",
        style: { marginTop: "12px", minWidth: "0" },
      });
      item.appendChild(
        el(
          "div",
          { className: "card-subtitle" },
          row.providerId +
            " · " +
            row.name +
            (row.prominence === "supplementary" ? " · Additional detail" : ""),
        ),
      );
      item.appendChild(
        el(
          "div",
          { className: "accounting-detail-value", style: { fontWeight: "600", margin: "4px 0" } },
          row.value,
        ),
      );
      for (const fact of row.facts || []) item.appendChild(renderKV(fact.label, fact.value));
      details.appendChild(item);
    }
    return details;
  }

  // ===========================================================================
  // Token Usage
  // ===========================================================================

  function fmtCompact(n) {
    if (!Number.isFinite(n)) return "0";
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (abs >= 1_000_000_000) return sign + (abs / 1_000_000_000).toFixed(1) + "B";
    if (abs >= 1_000_000) return sign + (abs / 1_000_000).toFixed(1) + "M";
    if (abs >= 1_000) return sign + (abs / 1_000).toFixed(1) + "K";
    return String(Math.trunc(n));
  }

  function fmtUsd(n) {
    if (!Number.isFinite(n)) return "$0.00";
    return "$" + n.toFixed(2);
  }

  function normalizeSourceName(providerID) {
    const p = (providerID || "").toLowerCase();
    if (p.includes("opencode")) return "OpenCode";
    if (p.includes("cursor")) return "Cursor";
    if (p.includes("claude") || p.includes("anthropic")) return "Claude";
    if (p.includes("github") || p.includes("copilot")) return "Copilot";
    if (p.includes("openai") || p.includes("chatgpt") || p.includes("codex")) return "OpenAI";
    if (p.includes("google") || p.includes("antigravity") || p.includes("gemini")) return "Google";
    if (p.includes("azure")) return "Azure";
    return providerID || "Unknown";
  }

  function sourceSortKey(providerID) {
    const s = (providerID || "").toLowerCase();
    if (s === "opencode") return 1;
    if (s === "claude" || s === "anthropic") return 2;
    if (s === "cursor") return 3;
    if (s === "copilot" || s.includes("copilot")) return 4;
    if (s === "openai") return 5;
    if (s.includes("google")) return 6;
    if (s.includes("azure")) return 7;
    return 99;
  }

  function renderTokenUsageInto(container) {
    // ── Merged view toggle ────────────────────────────
    const toggleBar = el("div", { className: "filter-bar", style: { marginBottom: "8px" } });
    toggleBar.appendChild(
      el(
        "button",
        {
          className: "btn btn-small " + (showMergedTokens ? "btn-primary" : ""),
          onClick: () => {
            if (!showMergedTokens) {
              fetchMergedTokens();
            } else {
              showMergedTokens = false;
              mergedTokenData = null;
              renderTokenUsage();
            }
          },
        },
        "🌐 Merged",
      ),
    );
    toggleBar.appendChild(
      el(
        "span",
        {
          style: { fontSize: "10px", color: "var(--text-muted)", marginLeft: "8px" },
        },
        showMergedTokens ? "All machines" : "This machine only",
      ),
    );
    container.appendChild(toggleBar);

    if (showMergedTokens) {
      renderMergedTokenUsage(container);
      return;
    }

    if (!tokenData) {
      container.appendChild(
        el(
          "div",
          { className: "loading-center" },
          el("span", { className: "spinner" }),
          " Loading token data...",
        ),
      );
      fetchTokens();
      return;
    }

    const agg = tokenData.aggregate || {};
    const totals = agg.totals || {};
    const winLabel = tokenData.window?.label || "Usage";

    // ── Window selector ──────────────────────────────
    const filterBar = el("div", { className: "filter-bar" });
    const windows = [
      { v: "day", l: "24h" },
      { v: "week", l: "7d" },
      { v: "month", l: "30d" },
      { v: "all", l: "All" },
    ];
    const group = el(
      "div",
      { className: "filter-group" },
      el("span", { className: "filter-label" }, "Window:"),
    );
    const activeWindow = tokenData.window?.label || "";
    windows.forEach((w) => {
      const isActive = activeWindow.includes(w.l);
      group.appendChild(
        el(
          "button",
          {
            className: "btn btn-small token-window-select " + (isActive ? "btn-primary" : ""),
            onClick: () => {
              fetchTokens(w.v);
            },
          },
          w.l,
        ),
      );
    });
    filterBar.appendChild(group);
    filterBar.appendChild(
      el(
        "button",
        {
          className: "btn btn-small",
          onClick: async () => {
            try {
              const r = await api.tokens.syncExportAndPush();
              showToast(r.pushed ? "Synced & pushed" : "Exported (push skipped)");
            } catch (e) {
              showToast(e.message, "error");
            }
          },
          style: { marginLeft: "auto", marginRight: "4px" },
        },
        "↗ Sync",
      ),
    );
    filterBar.appendChild(
      el(
        "button",
        { className: "btn btn-small", onClick: () => fetchTokens(), style: {} },
        "⟳ Refresh",
      ),
    );
    container.appendChild(filterBar);

    // ── Summary card ─────────────────────────────────
    const summary = el("div", { className: "card" });
    summary.appendChild(el("div", { className: "card-title" }, winLabel));

    const priced = totals.priced || {};
    const unknownTok = totals.unknown || {};
    const unpricedTok = totals.unpriced || {};
    const hasCache = (priced.cache_read || 0) + (priced.cache_write || 0) > 0;
    const hasReason =
      (priced.reasoning || 0) + (unknownTok.reasoning || 0) + (unpricedTok.reasoning || 0) > 0;

    const grid = el("div", {
      style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "6px", marginTop: "6px" },
    });
    grid.appendChild(renderKV("Messages", formatNumber(totals.messageCount || 0)));
    grid.appendChild(renderKV("Sessions", formatNumber(totals.sessionCount || 0)));
    grid.appendChild(renderKV("Cost", fmtUsd(totals.costUsd), "var(--accent)"));
    grid.appendChild(renderKV("Input Tokens", fmtCompact(priced.input || 0)));
    grid.appendChild(renderKV("Output Tokens", fmtCompact(priced.output || 0)));
    if (hasCache) {
      grid.appendChild(renderKV("Cache Read", fmtCompact(priced.cache_read || 0)));
      grid.appendChild(renderKV("Cache Write", fmtCompact(priced.cache_write || 0)));
    }
    if (hasReason) {
      grid.appendChild(renderKV("Reasoning", fmtCompact(priced.reasoning || 0)));
    }
    summary.appendChild(grid);
    container.appendChild(summary);

    // ── Models table (priced + unpriced + unknown) ───
    const bySourceModel = agg.bySourceModel || [];
    const unpriced = agg.unpriced || [];
    const unknown = agg.unknown || [];

    const allModels = [
      ...bySourceModel.map((row) => ({
        sourceProviderID: row.sourceProviderID,
        sourceModelID: row.sourceModelID,
        tokens: row.tokens || {},
        costUsd: row.costUsd,
        messageCount: row.messageCount,
        priced: true,
      })),
      ...unpriced.map((u) => ({
        sourceProviderID: u.key?.sourceProviderID || "?",
        sourceModelID: u.key?.sourceModelID || "?",
        tokens: u.tokens || {},
        costUsd: null,
        messageCount: u.messageCount || 0,
        priced: false,
      })),
      ...unknown.map((u) => ({
        sourceProviderID: u.key?.sourceProviderID || "?",
        sourceModelID: u.key?.sourceModelID || "?",
        tokens: u.tokens || {},
        costUsd: null,
        messageCount: u.messageCount || 0,
        priced: false,
      })),
    ];

    if (allModels.length > 0) {
      const grouped = new Map();
      for (const row of allModels) {
        const src = normalizeSourceName(row.sourceProviderID);
        if (!grouped.has(src)) grouped.set(src, []);
        grouped.get(src).push(row);
      }

      const sources = [...grouped.keys()].sort((a, b) => {
        const ka = sourceSortKey(a),
          kb = sourceSortKey(b);
        return ka !== kb ? ka - kb : a.localeCompare(b);
      });

      const modelCard = el("div", { className: "card" });
      modelCard.appendChild(
        el("div", { className: "card-title", style: { marginBottom: "8px" } }, "Models"),
      );

      const table = el("table", { className: "data-table" });
      const thead = el("thead");
      const hRow = el("tr");
      [
        "Source",
        "Model",
        "Input",
        "Output",
        "C.Read",
        "C.Write",
        "Reason",
        "Total",
        "Cost",
      ].forEach((h) => {
        hRow.appendChild(el("th", {}, h));
      });
      thead.appendChild(hRow);
      table.appendChild(thead);

      const tbody = el("tbody");
      let visibleCount = 0;
      let totalCount = 0;
      const limit = showAllModels ? Infinity : 10;

      for (let si = 0; si < sources.length; si++) {
        const src = sources[si];
        const list = grouped.get(src);
        list.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1));

        let groupRendered = 0;
        for (const row of list) {
          totalCount++;
          if (visibleCount >= limit) continue;
          visibleCount++;
          groupRendered++;
          const t = row.tokens || {};
          const tr = el("tr");
          [
            src,
            row.sourceModelID || "?",
            fmtCompact(t.input || 0),
            fmtCompact(t.output || 0),
            fmtCompact(t.cache_read || 0),
            fmtCompact(t.cache_write || 0),
            fmtCompact(t.reasoning || 0),
            fmtCompact(
              (t.input || 0) +
                (t.output || 0) +
                (t.cache_read || 0) +
                (t.cache_write || 0) +
                (t.reasoning || 0),
            ),
            row.priced ? fmtUsd(row.costUsd) : "N/A",
          ].forEach((v, i) => {
            tr.appendChild(
              el(
                "td",
                {
                  className:
                    i >= 2 && i <= 7
                      ? "num-col"
                      : i === 8
                        ? row.priced
                          ? "cost-col"
                          : "cost-col cost-na"
                        : "text-col",
                },
                v,
              ),
            );
          });
          if (!row.priced) {
            tr.style.cursor = "pointer";
            tr.title = "Click to add pricing for " + row.sourceProviderID + "/" + row.sourceModelID;
            tr.addEventListener("click", () => {
              activeTab = 3;
              updateHeaderTitle();
              updateTabNavHighlight();
              renderContentInto($(".tab-content"));
              loadPricing();
              showAddPricingModal(row.sourceProviderID, row.sourceModelID);
            });
          }
          tbody.appendChild(tr);
        }

        // Separator row between sources (only if we rendered from this group and more groups follow)
        if (groupRendered > 0 && si < sources.length - 1 && visibleCount < limit) {
          const sep = el("tr");
          sep.appendChild(el("td", { colSpan: 9, style: { padding: "2px 0" } }, ""));
          tbody.appendChild(sep);
        }
      }
      table.appendChild(tbody);

      // Header row with count + toggle
      const titleRow = el("div", {
        style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
      });
      titleRow.appendChild(el("span", {}, ""));
      if (totalCount > 10) {
        titleRow.appendChild(
          el(
            "button",
            {
              className: "btn btn-small",
              onClick: () => {
                showAllModels = !showAllModels;
                renderContent();
              },
            },
            showAllModels ? "Show less" : "Show all (" + totalCount + " models)",
          ),
        );
      }
      modelCard.appendChild(titleRow);

      modelCard.appendChild(table);

      const unpricedCount = unpriced.length + unknown.length;
      if (unpricedCount > 0) {
        modelCard.appendChild(
          el(
            "div",
            { style: { fontSize: "10px", color: "var(--text-muted)", marginTop: "8px" } },
            unpricedCount + " model(s) without pricing — add custom rates in Pricing tab.",
          ),
        );
      }
      container.appendChild(modelCard);
    }

    // ── Top Sessions ─────────────────────────────────
    const sessions = (agg.bySession || []).filter(
      (s) => (s.costUsd || 0) > 0 || (s.messageCount || 0) > 0,
    );
    if (sessions.length > 0) {
      const top = sessions.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)).slice(0, 10);
      const sessCard = el("div", { className: "card" });
      sessCard.appendChild(
        el("div", { className: "card-title", style: { marginBottom: "8px" } }, "Top Sessions"),
      );

      const table = el("table", { className: "data-table" });
      const thead = el("thead");
      const hRow = el("tr");
      ["Session", "Cost", "Tokens", "Msgs", "Title"].forEach((h) =>
        hRow.appendChild(el("th", {}, h)),
      );
      thead.appendChild(hRow);
      table.appendChild(thead);

      const tbody = el("tbody");
      top.forEach((row) => {
        const tr = el("tr");
        tr.appendChild(
          el(
            "td",
            {
              className: "text-col",
              style: {
                fontFamily: "var(--font-mono)",
                fontSize: "9px",
                maxWidth: "120px",
                overflow: "hidden",
                textOverflow: "ellipsis",
              },
            },
            row.sessionID || "-",
          ),
        );
        tr.appendChild(el("td", { className: "cost-col" }, fmtUsd(row.costUsd)));
        tr.appendChild(
          el(
            "td",
            { className: "num-col" },
            fmtCompact(
              (row.tokens?.input || 0) +
                (row.tokens?.output || 0) +
                (row.tokens?.cache_read || 0) +
                (row.tokens?.cache_write || 0) +
                (row.tokens?.reasoning || 0),
            ),
          ),
        );
        tr.appendChild(el("td", { className: "num-col" }, formatNumber(row.messageCount || 0)));
        tr.appendChild(
          el(
            "td",
            {
              className: "text-col",
              style: {
                maxWidth: "200px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
            },
            (row.title || "").trim().slice(0, 30) || "(untitled)",
          ),
        );
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      sessCard.appendChild(table);
      container.appendChild(sessCard);
    }
  }

  function renderTokenUsage() {
    const c = $(".tab-content");
    if (c) {
      clear(c);
      renderTokenUsageInto(c);
    }
  }

  // ===========================================================================
  // Merged Token Usage (cross-machine sync)
  // ===========================================================================
  function renderMergedTokenUsage(container) {
    if (!mergedTokenData) {
      container.appendChild(
        el(
          "div",
          { className: "loading-center" },
          el("span", { className: "spinner" }),
          " Loading merged data...",
        ),
      );
      return;
    }

    const totals = mergedTokenData.totals || {};
    const byPM = mergedTokenData.byProviderModel || [];

    // ── Totals card ───────────────────────────────────
    const card = el("div", { className: "card" });
    card.appendChild(el("div", { className: "card-title" }, "All Machines — Merged Totals"));
    const grid = el("div", {
      style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "6px", marginTop: "6px" },
    });
    grid.appendChild(renderKV("Messages", formatNumber(totals.messages || 0)));
    grid.appendChild(renderKV("Cost", fmtUsd(totals.costUsd), "var(--accent)"));
    grid.appendChild(renderKV("Input Tokens", fmtCompact(totals.tokens?.input || 0)));
    grid.appendChild(renderKV("Output Tokens", fmtCompact(totals.tokens?.output || 0)));
    grid.appendChild(renderKV("Cache Read", fmtCompact(totals.tokens?.cache_read || 0)));
    grid.appendChild(renderKV("Cache Write", fmtCompact(totals.tokens?.cache_write || 0)));
    card.appendChild(grid);
    container.appendChild(card);

    // ── By provider/model table ───────────────────────
    if (byPM.length > 0) {
      const modelCard = el("div", { className: "card" });
      modelCard.appendChild(
        el(
          "div",
          { className: "card-title", style: { marginBottom: "8px" } },
          "By Provider / Model",
        ),
      );

      const table = el("table", { className: "data-table" });
      const thead = el("thead");
      const hRow = el("tr");
      ["Provider", "Model", "Input", "Output", "C.Read", "C.Write", "Total", "Cost"].forEach(
        (h) => {
          hRow.appendChild(el("th", {}, h));
        },
      );
      thead.appendChild(hRow);
      table.appendChild(thead);

      const tbody = el("tbody");
      const sorted = [...byPM].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));
      sorted.forEach((row) => {
        const t = row.tokens || {};
        const tr = el("tr");
        [
          row.provider || "?",
          row.model || "?",
          fmtCompact(t.input || 0),
          fmtCompact(t.output || 0),
          fmtCompact(t.cache_read || 0),
          fmtCompact(t.cache_write || 0),
          fmtCompact((t.input || 0) + (t.output || 0) + (t.cache_read || 0) + (t.cache_write || 0)),
          fmtUsd(row.costUsd),
        ].forEach((v, i) => {
          tr.appendChild(
            el(
              "td",
              { className: i >= 2 && i <= 6 ? "num-col" : i === 7 ? "cost-col" : "text-col" },
              v,
            ),
          );
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      modelCard.appendChild(table);
      container.appendChild(modelCard);
    }
  }

  // ===========================================================================
  // Budget Alerts
  // ===========================================================================
  function renderAlertsInto(container) {
    if (budgetState?.diagnostic) {
      container.appendChild(el("div", { className: "history-diagnostic" }, budgetState.diagnostic));
      if (!alerts.length) return;
    }
    const header = el("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "12px",
      },
    });
    header.appendChild(
      el(
        "span",
        { style: { fontSize: "12px", color: "var(--text-secondary)" } },
        alerts.length + " rule" + (alerts.length !== 1 ? "s" : ""),
      ),
    );
    header.appendChild(
      el(
        "button",
        { className: "btn btn-small btn-primary", onClick: showCreateAlertModal },
        "+ New Alert",
      ),
    );
    container.appendChild(header);

    if (alerts.length === 0) {
      container.appendChild(
        el(
          "div",
          { className: "empty-state" },
          el("div", { className: "icon" }, "⚠"),
          el("div", { className: "text" }, "No budget alerts configured"),
          el("div", { className: "hint" }, "Create alerts to monitor your token spending"),
        ),
      );
      return;
    }

    alerts.forEach((alert) => {
      const card = el("div", { className: "card" });
      const hdr = el("div", { className: "card-header" });
      hdr.appendChild(el("span", { className: "card-title" }, alert.name));
      hdr.appendChild(
        el(
          "span",
          { className: "tag " + (alert.enabled ? "tag-green" : "tag-gray") },
          alert.enabled ? "ON" : "OFF",
        ),
      );
      card.appendChild(hdr);
      card.appendChild(
        renderKV(
          "Scope",
          (alert.scope?.type || "global") +
            (alert.scope?.providerId ? "/" + alert.scope.providerId : ""),
        ),
      );
      card.appendChild(
        renderKV(
          "Threshold",
          (alert.metric === "cost_usd" ? "$" : "") +
            alert.threshold +
            " " +
            (alert.metric || "").replace(/_/g, " "),
        ),
      );
      card.appendChild(renderKV("Window", alert.window));
      const evaluation = budgetState?.results.find((item) => item.rule.id === alert.id);
      if (alert.enabled) {
        card.appendChild(
          renderKV(
            "Status",
            evaluation
              ? evaluation.status === "unknown"
                ? "Unknown"
                : evaluation.triggered
                  ? "Triggered"
                  : "Within threshold"
              : "Not evaluated",
          ),
        );
        if (evaluation) {
          card.appendChild(renderKV("Evaluation", evaluation.message));
          card.appendChild(
            renderKV("Evaluated", new Date(evaluation.evaluatedAt).toLocaleString()),
          );
          card.appendChild(
            renderKV(
              "Range",
              (evaluation.window.sinceMs
                ? new Date(evaluation.window.sinceMs).toLocaleString()
                : "All available history") +
                " – " +
                new Date(evaluation.window.untilMs).toLocaleString(),
            ),
          );
        }
      }
      card.appendChild(
        el(
          "div",
          { style: { marginTop: "8px" } },
          el(
            "button",
            { className: "btn btn-small btn-danger", onClick: () => deleteAlert(alert.id) },
            "Delete",
          ),
        ),
      );
      container.appendChild(card);
    });
  }

  function renderAlerts() {
    const c = $(".tab-content");
    if (c) {
      clear(c);
      renderAlertsInto(c);
    }
  }

  async function deleteAlert(id) {
    try {
      await api.alerts.delete(id);
      showToast("Alert deleted");
      await loadAlerts();
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  function showCreateAlertModal() {
    const overlay = el("div", {
      className: "modal-overlay",
      onClick: (e) => {
        if (e.target === overlay) overlay.remove();
      },
    });
    const modal = el("div", { className: "modal" });
    modal.appendChild(el("div", { className: "modal-title" }, "New Budget Alert"));

    const fields = [
      ["Name", "text", "name", ""],
      ["Scope Type", "select", "scopeType", "global", ["global", "provider", "model"]],
      ["Provider ID", "text", "scopeProviderId", ""],
      ["Model ID", "text", "scopeModelId", ""],
      ["Window", "select", "window", "day", ["day", "week", "month", "all"]],
      [
        "Metric",
        "select",
        "metric",
        "cost_usd",
        ["cost_usd", "tokens_total", "tokens_input", "tokens_output"],
      ],
      ["Threshold", "number", "threshold", "1"],
      ["Direction", "select", "direction", "above", ["above", "below"]],
    ];

    const values = {};
    fields.forEach(([label, type, key, def, opts]) => {
      values[key] = def;
      const group = el("div", { className: "form-group" });
      group.appendChild(el("label", { className: "form-label" }, label));
      if (type === "select" && opts) {
        const s = el("select", {
          className: "filter-select",
          style: { width: "100%" },
          onChange: (e) => (values[key] = e.target.value),
        });
        opts.forEach((o) => s.appendChild(el("option", { value: o }, o)));
        group.appendChild(s);
      } else {
        group.appendChild(
          el("input", {
            className: "form-input",
            type: type,
            placeholder: "",
            onInput: (e) =>
              (values[key] = type === "number" ? parseFloat(e.target.value) || 0 : e.target.value),
          }),
        );
      }
      modal.appendChild(group);
    });

    const actions = el("div", { className: "modal-actions" });
    actions.appendChild(
      el("button", { className: "btn btn-small", onClick: () => overlay.remove() }, "Cancel"),
    );
    actions.appendChild(
      el(
        "button",
        {
          className: "btn btn-small btn-primary",
          onClick: async () => {
            try {
              await api.alerts.create({
                name: values["name"] || "New Alert",
                scope: {
                  type: values["scopeType"],
                  providerId: values["scopeProviderId"] || undefined,
                  modelId: values["scopeModelId"] || undefined,
                },
                window: values["window"],
                metric: values["metric"],
                threshold: values["threshold"],
                direction: values["direction"],
              });
              showToast("Alert created");
              overlay.remove();
              await loadAlerts();
            } catch (e) {
              showToast(e.message, "error");
            }
          },
        },
        "Create",
      ),
    );
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ===========================================================================
  // Pricing Editor
  // ===========================================================================
  function renderPricingInto(container) {
    if (pricingSnapshot) {
      const card = el("div", { className: "card" });
      const hdr = el("div", { className: "card-header" });
      hdr.appendChild(el("span", { className: "card-title" }, "Pricing Snapshot"));
      hdr.appendChild(
        el(
          "span",
          { className: "tag " + (pricingSnapshot.stale ? "tag-yellow" : "tag-green") },
          pricingSnapshot.stale ? "STALE" : "FRESH",
        ),
      );
      card.appendChild(hdr);
      card.appendChild(
        renderKV(
          "Updated",
          pricingSnapshot.generatedAt
            ? new Date(pricingSnapshot.generatedAt).toLocaleDateString()
            : "never",
        ),
      );
      card.appendChild(renderKV("Providers", String(pricingSnapshot.providerCount || 0)));
      card.appendChild(renderKV("Models", String(pricingSnapshot.modelCount || 0)));
      container.appendChild(card);
    }

    const hdr = el("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "8px",
      },
    });
    hdr.appendChild(
      el(
        "span",
        { style: { fontSize: "12px", color: "var(--text-secondary)" } },
        pricingOverrides.length + " override" + (pricingOverrides.length !== 1 ? "s" : ""),
      ),
    );
    hdr.appendChild(
      el(
        "button",
        { className: "btn btn-small btn-primary", onClick: showAddPricingModal },
        "+ Add Override",
      ),
    );
    container.appendChild(hdr);

    pricingOverrides.forEach((o) => {
      const card = el("div", { className: "card" });
      const ch = el("div", { className: "card-header" });
      ch.appendChild(el("span", { className: "card-title" }, o.provider + "/" + o.model));
      ch.appendChild(
        el(
          "button",
          {
            className: "btn btn-small btn-danger",
            onClick: async () => {
              try {
                await api.pricing.delete(o.provider, o.model);
                showToast("Override removed");
                await loadPricing();
              } catch (e) {
                showToast(e.message, "error");
              }
            },
          },
          "✕",
        ),
      );
      card.appendChild(ch);
      const rates = o.rates || {};
      const g = el("div", {
        style: {
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: "4px",
          fontSize: "10px",
        },
      });
      if (rates.input != null) g.appendChild(renderKV("Input", "$" + rates.input + "/1M"));
      if (rates.output != null) g.appendChild(renderKV("Output", "$" + rates.output + "/1M"));
      if (rates.cache_read != null)
        g.appendChild(renderKV("Cache Read", "$" + rates.cache_read + "/1M"));
      if (rates.cache_write != null)
        g.appendChild(renderKV("Cache Write", "$" + rates.cache_write + "/1M"));
      if (rates.reasoning != null)
        g.appendChild(renderKV("Reasoning", "$" + rates.reasoning + "/1M"));
      card.appendChild(g);
      if (o.label)
        card.appendChild(
          el(
            "div",
            { style: { fontSize: "10px", color: "var(--text-muted)", marginTop: "4px" } },
            o.label,
          ),
        );
      container.appendChild(card);
    });
  }

  function renderPricing() {
    const c = $(".tab-content");
    if (c) {
      clear(c);
      renderPricingInto(c);
    }
  }

  function showAddPricingModal(provider, model) {
    const overlay = el("div", {
      className: "modal-overlay",
      onClick: (e) => {
        if (e.target === overlay) overlay.remove();
      },
    });
    const modal = el("div", { className: "modal" });
    modal.appendChild(el("div", { className: "modal-title" }, "Add Pricing Override"));
    const vals = { provider: provider || "", model: model || "" };
    [
      ["Provider", "text", "provider", provider || ""],
      ["Model", "text", "model", model || ""],
      ["Input ($/1M tokens)", "number", "input", ""],
      ["Output ($/1M tokens)", "number", "output", ""],
      ["Cache Read ($/1M)", "number", "cache_read", ""],
      ["Cache Write ($/1M)", "number", "cache_write", ""],
      ["Reasoning ($/1M)", "number", "reasoning", ""],
      ["Label (optional)", "text", "label", ""],
    ].forEach(([label, type, key, def]) => {
      vals[key] = def;
      const g = el("div", { className: "form-group" });
      g.appendChild(el("label", { className: "form-label" }, label));
      const input = el("input", {
        className: "form-input",
        type: type,
        placeholder: "",
        onInput: (e) => (vals[key] = type === "number" ? e.target.value : e.target.value),
      });
      if (def) input.value = def;
      g.appendChild(input);
      modal.appendChild(g);
    });
    const actions = el("div", { className: "modal-actions" });
    actions.appendChild(
      el("button", { className: "btn btn-small", onClick: () => overlay.remove() }, "Cancel"),
    );
    actions.appendChild(
      el(
        "button",
        {
          className: "btn btn-small btn-primary",
          onClick: async () => {
            const rates = {};
            if (vals["input"]) rates.input = parseFloat(vals["input"]);
            if (vals["output"]) rates.output = parseFloat(vals["output"]);
            if (vals["cache_read"]) rates.cache_read = parseFloat(vals["cache_read"]);
            if (vals["cache_write"]) rates.cache_write = parseFloat(vals["cache_write"]);
            if (vals["reasoning"]) rates.reasoning = parseFloat(vals["reasoning"]);
            try {
              await api.pricing.save({
                provider: vals["provider"],
                model: vals["model"],
                rates,
                label: vals["label"] || undefined,
              });
              showToast("Override saved");
              overlay.remove();
              await loadPricing();
            } catch (e) {
              showToast(e.message, "error");
            }
          },
        },
        "Save",
      ),
    );
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ===========================================================================
  // API Keys
  // ===========================================================================
  function renderApiKeysInto(container) {
    if (!apikeyStatus) {
      container.appendChild(
        el(
          "div",
          { className: "loading-center" },
          el("span", { className: "spinner" }),
          " Loading...",
        ),
      );
      return;
    }

    if (apikeyStatus.state === "empty") {
      container.appendChild(
        el(
          "div",
          { className: "empty-state" },
          el("div", { className: "icon" }, "🔑"),
          el("div", { className: "text" }, "No API key store found"),
          el(
            "div",
            { className: "hint" },
            "Create an encrypted store to manage your provider API keys",
          ),
          el(
            "button",
            {
              className: "btn btn-primary",
              style: { marginTop: "12px" },
              onClick: showInitStoreModal,
            },
            "Create Key Store",
          ),
        ),
      );
      return;
    }

    if (apikeyStatus.state === "locked") {
      const card = el("div", { className: "card" });
      const hdr = el("div", { className: "card-header" });
      hdr.appendChild(el("span", { className: "card-title" }, "Key Store Locked"));
      hdr.appendChild(el("span", { className: "tag tag-yellow" }, "🔒 LOCKED"));
      card.appendChild(hdr);
      card.appendChild(
        el(
          "div",
          { style: { fontSize: "11px", color: "var(--text-secondary)", marginBottom: "8px" } },
          (apikeyStatus.providerCount || 0) + " key(s) stored",
        ),
      );
      card.appendChild(
        el(
          "button",
          { className: "btn btn-primary", onClick: showUnlockModal },
          "Unlock with Passphrase",
        ),
      );
      container.appendChild(card);
      return;
    }

    if (apikeyStatus.state === "unlocked") {
      const actions = el("div", {
        style: { display: "flex", gap: "8px", marginBottom: "12px", flexWrap: "wrap" },
      });
      actions.appendChild(
        el("button", { className: "btn btn-small", onClick: showAddKeyModal }, "+ Add Key"),
      );
      actions.appendChild(
        el("button", { className: "btn btn-small", onClick: showExportModal }, "↗ Export"),
      );
      actions.appendChild(
        el(
          "button",
          {
            className: "btn btn-small",
            onClick: async () => {
              await api.apikeys.lock();
              await loadApikeyStatus();
              showToast("Store locked");
            },
          },
          "🔒 Lock",
        ),
      );
      container.appendChild(actions);

      const providers = apikeyStatus.providers || [];
      if (providers.length === 0) {
        container.appendChild(
          el(
            "div",
            { className: "empty-state" },
            el("div", { className: "text" }, "No API keys stored"),
            el("div", { className: "hint" }, "Add keys for providers like OpenAI, Anthropic, etc."),
          ),
        );
      }
      providers.forEach((info) => {
        const card = el("div", { className: "card" });
        const hdr = el("div", { className: "card-header" });
        hdr.appendChild(el("span", { className: "card-title" }, info.providerId));
        hdr.appendChild(
          el(
            "span",
            { className: "tag " + (info.hasKey ? "tag-green" : "tag-gray") },
            info.hasKey ? "STORED" : "EMPTY",
          ),
        );
        card.appendChild(hdr);
        card.appendChild(renderKV("Label", info.label || "-"));
        card.appendChild(renderKV("Updated", new Date(info.updatedAt).toLocaleDateString()));
        card.appendChild(
          el(
            "div",
            { style: { marginTop: "8px" } },
            el(
              "button",
              {
                className: "btn btn-small btn-danger",
                onClick: async () => {
                  try {
                    await api.apikeys.delete(info.providerId);
                    showToast("Key deleted");
                    await loadApikeyStatus();
                  } catch (e) {
                    showToast(e.message, "error");
                  }
                },
              },
              "Delete",
            ),
          ),
        );
        container.appendChild(card);
      });
    }
  }

  function renderApiKeys() {
    const c = $(".tab-content");
    if (c) {
      clear(c);
      renderApiKeysInto(c);
    }
  }

  // ===========================================================================
  // History
  // ===========================================================================

  function renderBurndownSparkline(points) {
    if (!points || points.length === 0) {
      return el(
        "div",
        { className: "hint", style: { fontSize: "11px", color: "var(--text-muted)" } },
        "No history yet for this range.",
      );
    }

    const recent = points.slice(-30); // cap width to what fits the popup
    const row = el("div", { className: "sparkline" });
    recent.forEach((s) => {
      const remaining = Math.max(0, Math.min(100, s.percentRemaining ?? 0));
      const used = 100 - remaining;
      let barClass = "good";
      if (used >= 90) barClass = "danger";
      else if (used >= 75) barClass = "warning";

      row.appendChild(
        el("div", {
          className: "sparkline-bar " + barClass,
          style: { height: Math.max(4, Math.round((remaining / 100) * 48)) + "px" },
          title:
            new Date(s.timestamp).toLocaleString() + " — " + Math.round(remaining) + "% remaining",
        }),
      );
    });
    return row;
  }

  /**
   * Splits the collapsed (worst-window-wins) quota_snapshots time series
   * back out into one series per limit kind (e.g. "5h:" vs "Weekly:"), so
   * burn-rate can be computed per window instead of across mismatched kinds.
   */
  function groupQuotaSnapshotsByKind(snapshots) {
    const byKind = new Map();
    (snapshots || []).forEach((snap) => {
      (snap.limits || []).forEach((limit) => {
        const account =
          snap.accountIdentity && snap.accountIdentity !== "unknown"
            ? "Account " + snap.accountIdentity.slice(0, 8)
            : "Unknown account";
        const key = account + " · " + (limit.kind || limit.group || "quota");
        if (!byKind.has(key)) byKind.set(key, { group: limit.group || key, points: [] });
        byKind.get(key).points.push({
          timestamp: snap.timestamp,
          percentRemaining: 100 - limit.percent,
          resetTimeIso: limit.resets_at,
        });
      });
    });
    byKind.forEach((entry) => entry.points.sort((a, b) => a.timestamp - b.timestamp));
    return byKind;
  }

  function formatDuration(minutes) {
    if (!Number.isFinite(minutes) || minutes < 0) return "—";
    const totalMin = Math.round(minutes);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? h + "h " + m + "m" : m + "m";
  }

  /**
   * Descriptive consumption between the last two observations only.
   * Fixed-window runway is calculated by the shared metadata-aware formatter.
   */
  function computeBurnStats(points) {
    if (!points || points.length === 0) return null;
    const latest = points[points.length - 1];
    const stats = {
      percentRemaining: latest.percentRemaining,
      resetTimeIso: latest.resetTimeIso,
      burnPerMin: null,
    };

    if (points.length >= 2) {
      const prev = points[points.length - 2];
      const deltaMin = (latest.timestamp - prev.timestamp) / 60000;
      const usedDelta = prev.percentRemaining - latest.percentRemaining; // + = consumed since prev
      if (deltaMin > 0 && usedDelta >= 0) {
        stats.burnPerMin = usedDelta / deltaMin;
      }
    }

    return stats;
  }

  function renderBurnCard(kindLabel, entry) {
    const card = el("div", { className: "card" });
    card.appendChild(
      el(
        "div",
        { className: "card-title" },
        (entry.group || kindLabel).replace(/:+$/, "") + " Burn-down",
      ),
    );
    card.appendChild(renderBurndownSparkline(entry.points));

    const stats = computeBurnStats(entry.points);
    if (stats) {
      const line1 = [Math.round(stats.percentRemaining) + "% left"];
      if (stats.burnPerMin != null) {
        line1.push(
          "burn " +
            stats.burnPerMin.toFixed(2) +
            "%/min (" +
            (stats.burnPerMin * 60).toFixed(1) +
            "%/hr)",
        );
      }
      const resetsAtMs = stats.resetTimeIso ? new Date(stats.resetTimeIso).getTime() : NaN;
      if (Number.isFinite(resetsAtMs)) {
        line1.push("reset in " + formatDuration((resetsAtMs - Date.now()) / 60000));
      }
      card.appendChild(
        el(
          "div",
          { style: { fontSize: "11px", color: "var(--text-secondary)", marginTop: "6px" } },
          line1.join(" · "),
        ),
      );
    }
    return card;
  }

  function renderModelSourceBreakdown(container) {
    const card = el("div", { className: "card" });
    const header = el("div", { className: "card-header" });
    header.appendChild(el("span", { className: "card-title" }, "Model Cost Breakdown"));
    card.appendChild(header);

    if (!historySourceModels || historySourceModels.length === 0) {
      card.appendChild(
        el(
          "div",
          { className: "hint", style: { fontSize: "11px", color: "var(--text-muted)" } },
          "No usage recorded for this range.",
        ),
      );
      container.appendChild(card);
      return;
    }

    const bySource = new Map();
    historySourceModels.forEach((row) => {
      const src = normalizeSourceName(row.sourceProviderID);
      if (!bySource.has(src)) bySource.set(src, []);
      bySource.get(src).push(row);
    });
    const sources = [...bySource.keys()].sort((a, b) => {
      const ka = sourceSortKey(a),
        kb = sourceSortKey(b);
      return ka !== kb ? ka - kb : a.localeCompare(b);
    });
    if (!sources.includes(historyGroupBy)) historyGroupBy = "All";

    const groupSelect = el("select", {
      className: "filter-select",
      onChange: (e) => {
        historyGroupBy = e.target.value;
        renderHistory();
      },
    });
    ["All", ...sources].forEach((s) => {
      const opt = el("option", { value: s }, s === "All" ? "All sources" : s);
      if (s === historyGroupBy) opt.setAttribute("selected", "");
      groupSelect.appendChild(opt);
    });
    card.appendChild(
      el("div", { className: "filter-bar", style: { padding: "0 0 4px 0" } }, groupSelect),
    );

    const rows =
      historyGroupBy === "All"
        ? historySourceModels.map((r) => ({
            label: normalizeSourceName(r.sourceProviderID) + "/" + r.sourceModelID,
            costUsd: r.costUsd,
          }))
        : bySource.get(historyGroupBy).map((r) => ({ label: r.sourceModelID, costUsd: r.costUsd }));
    rows.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));

    const wrap = el("div", { style: { marginTop: "8px" } });
    const maxCost = Math.max(...rows.map((r) => r.costUsd || 0), 0.0001);
    rows.slice(0, 8).forEach((r) => {
      const row = el("div", { style: { marginBottom: "6px" } });
      row.appendChild(
        el(
          "div",
          {
            style: {
              display: "flex",
              justifyContent: "space-between",
              fontSize: "11px",
              marginBottom: "2px",
            },
          },
          el("span", {}, r.label),
          el("span", { style: { fontFamily: "var(--font-mono)" } }, fmtUsd(r.costUsd || 0)),
        ),
      );
      const barWrap = el("div", { className: "percent-bar-container" });
      const pct = Math.max(2, Math.round(((r.costUsd || 0) / maxCost) * 100));
      barWrap.appendChild(
        el("div", { className: "percent-bar-fill good", style: { width: pct + "%" } }),
      );
      row.appendChild(barWrap);
      wrap.appendChild(row);
    });
    card.appendChild(wrap);
    container.appendChild(card);
  }

  function renderBurningSessionsCard(container) {
    const card = el("div", { className: "card" });
    card.appendChild(el("div", { className: "card-title" }, "What's Burning Your Quota"));
    card.appendChild(
      el(
        "div",
        { style: { fontSize: "10px", color: "var(--text-muted)", marginBottom: "6px" } },
        "Local sessions ranked by weighted tokens in the " +
          historyBurningWindowLabel.toLowerCase() +
          " (this machine only, approximate).",
      ),
    );

    const sessions = (historyBurningSessions || []).filter(
      (s) => s.tokens && (s.tokens.input || s.tokens.output),
    );
    if (sessions.length === 0) {
      card.appendChild(
        el(
          "div",
          { className: "hint", style: { fontSize: "11px", color: "var(--text-muted)" } },
          "No active sessions in this window.",
        ),
      );
      container.appendChild(card);
      return;
    }

    const weight = (s) =>
      (s.tokens.input || 0) +
      (s.tokens.output || 0) +
      (s.tokens.cache_write || 0) +
      (s.tokens.cache_read || 0) * 0.1;
    const ranked = sessions
      .map((s) => ({ ...s, weight: weight(s) }))
      .sort((a, b) => b.weight - a.weight);
    const totalWeight = ranked.reduce((sum, s) => sum + s.weight, 0) || 1;

    ranked.slice(0, 5).forEach((s) => {
      const row = el("div", { style: { marginBottom: "8px" } });
      const title = s.title || "Session " + String(s.sessionID || "").slice(0, 8);
      row.appendChild(el("div", { style: { fontSize: "11px", marginBottom: "2px" } }, title));
      const pct = Math.round((s.weight / totalWeight) * 100);
      row.appendChild(
        el(
          "div",
          { style: { fontSize: "10px", color: "var(--text-muted)" } },
          pct +
            "% of local burn · " +
            fmtCompact(s.weight) +
            " weighted tokens · " +
            formatNumber(s.messageCount || 0) +
            " msgs",
        ),
      );
      const barWrap = el("div", { className: "percent-bar-container" });
      barWrap.appendChild(
        el("div", { className: "percent-bar-fill good", style: { width: Math.max(2, pct) + "%" } }),
      );
      row.appendChild(barWrap);
      card.appendChild(row);
    });
    container.appendChild(card);
  }

  function renderResetHistoryList(resets) {
    if (!resets || resets.length === 0) {
      return el(
        "div",
        { className: "hint", style: { fontSize: "11px", color: "var(--text-muted)" } },
        "No resets recorded yet.",
      );
    }

    const wrap = el("div", {});
    const capped = resets.filter((r) => (r.quota_used || 0) >= 99).length;
    wrap.appendChild(
      el(
        "div",
        { style: { fontSize: "10px", color: "var(--text-muted)", marginBottom: "6px" } },
        capped + " of " + resets.length + " window(s) fully capped (≥99% used)",
      ),
    );

    resets.slice(0, 6).forEach((r) => {
      const used = Math.round(r.quota_used || 0);
      const left = Math.round(r.quota_remaining ?? 100 - used);
      wrap.appendChild(
        renderKV(
          new Date(r.reset_at).toLocaleDateString() + " · " + r.reset_type,
          used + "% used · " + left + "% left unused",
        ),
      );
    });
    return wrap;
  }

  function renderHistoryInto(container) {
    if (historyReadError) {
      container.appendChild(el("div", { className: "history-diagnostic" }, historyReadError));
    }
    if (!historyProvidersLoaded) {
      container.appendChild(
        el(
          "div",
          { className: "empty-state" },
          el("div", { className: "icon" }, "📈"),
          el("div", { className: "text" }, "Loading history..."),
        ),
      );
      return;
    }

    if (historyProviders.length === 0) {
      container.appendChild(
        el(
          "div",
          { className: "empty-state" },
          el("div", { className: "icon" }, "📈"),
          el("div", { className: "text" }, "No quota history yet"),
          el(
            "div",
            { className: "hint" },
            "Snapshots are captured automatically whenever quota is checked.",
          ),
        ),
      );
      return;
    }

    const controls = el("div", { className: "filter-bar" });

    const providerSelect = el("select", {
      className: "filter-select",
      onChange: (e) => {
        historyProvider = e.target.value;
        historyAccount = "all";
        historyWindow = null;
        loadHistory();
      },
    });
    historyProviders.forEach((p) => {
      const opt = el("option", { value: p }, normalizeSourceName(p));
      if (p === historyProvider) opt.setAttribute("selected", "");
      providerSelect.appendChild(opt);
    });
    controls.appendChild(providerSelect);
    const accountSelect = el("select", {
      className: "filter-select history-account-filter",
      onChange: (e) => {
        historyAccount = e.target.value;
        renderHistory();
      },
    });
    const accounts = [
      ...new Set([
        ...historyQuota.map((row) => row.accountIdentity || "unknown"),
        ...historyAccounting.map((row) => row.detail.accountIdentity),
      ]),
    ];
    for (const id of ["all", ...accounts]) {
      const option = el(
        "option",
        { value: id },
        id === "all"
          ? "All accounts (separate series)"
          : id === "unknown"
            ? "Unknown account"
            : "Account " + id.slice(0, 8),
      );
      if (historyAccount === id) option.setAttribute("selected", "");
      accountSelect.appendChild(option);
    }
    controls.appendChild(accountSelect);

    const rangeSelect = el("select", {
      className: "filter-select",
      onChange: (e) => {
        historyDays = parseInt(e.target.value, 10);
        loadHistory();
      },
    });
    [
      [7, "Last 7 days"],
      [30, "Last 30 days"],
    ].forEach(([val, label]) => {
      const opt = el("option", { value: String(val) }, label);
      if (val === historyDays) opt.setAttribute("selected", "");
      rangeSelect.appendChild(opt);
    });
    controls.appendChild(rangeSelect);

    container.appendChild(controls);

    container.appendChild(
      el(
        "div",
        {
          className: "history-diagnostic",
          style: { marginBottom: "8px", color: "var(--text-secondary)" },
        },
        "Unknown observations are kept separate from identified accounts. An account label identifies only observations from the same selected account.",
      ),
    );
    const selectedHistory = (historyWindow ? [] : historyQuota).filter(
      (item) => historyAccount === "all" || (item.accountIdentity || "unknown") === historyAccount,
    );
    const selectedAccounting = historyAccounting.filter(
      (item) =>
        (historyAccount === "all" || item.detail.accountIdentity === historyAccount) &&
        (!historyWindow || item.detail.windowId === historyWindow),
    );
    if (historyWindow)
      container.appendChild(
        el(
          "button",
          {
            className: "btn btn-sm",
            onClick: () => {
              historyWindow = null;
              renderHistory();
            },
          },
          "Window: " + historyWindow + " · Show all windows",
        ),
      );
    const eventCard = el("div", { className: "card" });
    eventCard.appendChild(el("div", { className: "card-title" }, "Confirmed Reset Events"));
    eventCard.appendChild(el("div", { className: "hint" }, resetStatus));
    const selectedEvents = resetEvents.filter(
      (event) =>
        event.providerId === historyProvider &&
        (historyAccount === "all" || event.accountIdentity === historyAccount) &&
        (!historyWindow || event.windowId === historyWindow),
    );
    if (!selectedEvents.length)
      eventCard.appendChild(el("div", { className: "hint" }, "No confirmed resets recorded."));
    selectedEvents.slice(0, 20).forEach((event) => {
      eventCard.appendChild(
        el(
          "div",
          {},
          event.windowId +
            " · Account " +
            event.accountIdentity.slice(0, 8) +
            " · " +
            event.state +
            " · " +
            new Date(event.observedAt).toLocaleString(),
        ),
      );
      if (event.state === "uncertain")
        eventCard.appendChild(
          el(
            "button",
            {
              className: "btn btn-sm",
              onClick: async () => {
                if (
                  window.confirm(
                    "A notice may already have appeared. Retry this reset notification?",
                  )
                ) {
                  try {
                    await api.resets.retry(event.id);
                    await loadHistory();
                  } catch {
                    showToast("Reset retry unavailable", "error");
                  }
                }
              },
            },
            "Retry uncertain notice",
          ),
        );
    });
    container.appendChild(eventCard);
    const latestDetails = new Map();
    for (const item of selectedAccounting) latestDetails.set(item.detail.key, item.detail);
    if (latestDetails.size)
      container.appendChild(renderAccountingRows([...latestDetails.values()]));
    for (const snapshot of selectedHistory.filter((item) => item.error).slice(-5)) {
      container.appendChild(
        el(
          "div",
          { className: "history-diagnostic" },
          new Date(snapshot.timestamp).toLocaleString() + ": " + snapshot.error,
        ),
      );
    }
    const byKind = groupQuotaSnapshotsByKind(selectedHistory);
    if (byKind.size === 0) {
      const card = el("div", { className: "card" });
      card.appendChild(el("div", { className: "card-title" }, "Quota Burn-down"));
      card.appendChild(renderBurndownSparkline([]));
      container.appendChild(card);
    } else {
      // 5h-like windows first (fastest-moving, most actionable), then the rest.
      const kinds = [...byKind.keys()].sort((a, b) => {
        return a.localeCompare(b);
      });
      kinds.forEach((k) => container.appendChild(renderBurnCard(k, byKind.get(k))));
    }

    container.appendChild(
      el(
        "div",
        { style: { fontSize: "11px", color: "var(--text-muted)" } },
        "Local usage totals are not filtered by quota account.",
      ),
    );
    renderBurningSessionsCard(container);
    renderModelSourceBreakdown(container);

    const resetCard = el("div", { className: "card" });
    resetCard.appendChild(
      el("div", { className: "card-title" }, "Legacy Reset History (account unknown)"),
    );
    resetCard.appendChild(
      renderResetHistoryList(
        historyAccount === "all" || historyAccount === "unknown" ? historyResets : [],
      ),
    );
    container.appendChild(resetCard);
  }

  function renderHistory() {
    const c = $(".tab-content");
    if (c) {
      clear(c);
      renderHistoryInto(c);
    }
  }

  function showInitStoreModal() {
    showPassphraseModal(
      "Create API Key Store",
      "Set a master passphrase to encrypt your API keys at rest.",
      async (pass) => {
        await api.apikeys.init(pass);
        showToast("Key store initialized");
        await loadApikeyStatus();
      },
    );
  }

  function showUnlockModal() {
    showPassphraseModal("Unlock Key Store", "Enter your master passphrase.", async (pass) => {
      await api.apikeys.unlock(pass);
      showToast("Key store unlocked");
      await loadApikeyStatus();
    });
  }

  function showExportModal() {
    showPassphraseModal(
      "Export API Keys",
      "Set a one-time passphrase to encrypt the export file.",
      async (pass) => {
        const result = await api.apikeys.export(pass);
        const blob = new Blob([JSON.stringify(result.bundle, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = result.defaultFileName;
        a.click();
        URL.revokeObjectURL(url);
        showToast("Keys exported");
      },
    );
  }

  function showAddKeyModal() {
    const overlay = el("div", {
      className: "modal-overlay",
      onClick: (e) => {
        if (e.target === overlay) overlay.remove();
      },
    });
    const modal = el("div", { className: "modal" });
    modal.appendChild(el("div", { className: "modal-title" }, "Add API Key"));
    const vals = { providerId: "", apiKey: "", label: "" };
    [
      ["Provider ID", "text", "providerId", "e.g. openai, anthropic"],
      ["API Key", "password", "apiKey", "sk-..."],
      ["Label (optional)", "text", "label", "e.g. Work account"],
    ].forEach(([label, type, key, placeholder]) => {
      const g = el("div", { className: "form-group" });
      g.appendChild(el("label", { className: "form-label" }, label));
      g.appendChild(
        el("input", {
          className: "form-input",
          type: type,
          placeholder: placeholder,
          onInput: (e) => (vals[key] = e.target.value),
        }),
      );
      modal.appendChild(g);
    });
    const actions = el("div", { className: "modal-actions" });
    actions.appendChild(
      el("button", { className: "btn btn-small", onClick: () => overlay.remove() }, "Cancel"),
    );
    actions.appendChild(
      el(
        "button",
        {
          className: "btn btn-small btn-primary",
          onClick: async () => {
            try {
              await api.apikeys.save(vals.providerId, vals.apiKey, vals.label || undefined);
              showToast("API key saved");
              overlay.remove();
              await loadApikeyStatus();
            } catch (e) {
              showToast(e.message, "error");
            }
          },
        },
        "Save",
      ),
    );
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  function showPassphraseModal(title, desc, onConfirm) {
    const overlay = el("div", {
      className: "modal-overlay",
      onClick: (e) => {
        if (e.target === overlay) overlay.remove();
      },
    });
    const modal = el("div", { className: "modal" });
    modal.appendChild(el("div", { className: "modal-title" }, title));
    if (desc)
      modal.appendChild(
        el(
          "div",
          { style: { fontSize: "11px", color: "var(--text-secondary)", marginBottom: "12px" } },
          desc,
        ),
      );
    let pass = "";
    const g = el("div", { className: "form-group" });
    g.appendChild(el("label", { className: "form-label" }, "Passphrase"));
    g.appendChild(
      el("input", {
        className: "form-input",
        type: "password",
        placeholder: "Enter passphrase",
        onInput: (e) => (pass = e.target.value),
      }),
    );
    modal.appendChild(g);
    const actions = el("div", { className: "modal-actions" });
    actions.appendChild(
      el("button", { className: "btn btn-small", onClick: () => overlay.remove() }, "Cancel"),
    );
    actions.appendChild(
      el(
        "button",
        {
          className: "btn btn-small btn-primary",
          onClick: async () => {
            try {
              await onConfirm(pass);
              overlay.remove();
            } catch (e) {
              showToast(e.message, "error");
            }
          },
        },
        "Confirm",
      ),
    );
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================
  function renderKV(key, value, color) {
    const row = el("div", { className: "kv-row" });
    row.appendChild(el("span", { className: "key" }, key));
    row.appendChild(el("span", { className: "value", style: color ? { color } : {} }, value));
    return row;
  }

  function toggleTheme() {
    theme = theme === "dark" ? "light" : "dark";
    localStorage.setItem("quota-theme", theme);
    applyTheme();
    renderHeaderActions();
  }

  function applyTheme() {
    if (theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  function renderHeaderActions() {
    const actions = $(".header-actions");
    if (!actions) return;
    const themeLabel = theme === "dark" ? "☀ Light" : "☾ Dark";
    const themeTitle = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
    const btns = $$(".btn", actions);
    // The toggle is the second button (index 1)
    const toggleBtn = btns[1];
    if (toggleBtn && toggleBtn.title && toggleBtn.title.includes("theme")) {
      toggleBtn.textContent = themeLabel;
      toggleBtn.title = themeTitle;
    }
  }

  // ===========================================================================
  // Init
  // ===========================================================================
  function init() {
    // Load saved theme
    const saved = localStorage.getItem("quota-theme");
    if (saved === "light" || saved === "dark") {
      theme = saved;
    }
    applyTheme();

    render();
    const unsubscribeResets = api.resets?.onOpen((selection) => {
      historyProvider = selection.providerId;
      historyAccount = selection.accountIdentity;
      historyWindow = selection.windowId;
      activeTab = 5;
      render();
      loadHistory();
    });
    const unsubscribeQuota = api.quota.onUpdate(receiveQuotaSnapshot);
    api.quota
      .state()
      .then(receiveQuotaSnapshot)
      .catch((e) => showToast(e.message, "error"));
    const unsubscribeBudgets = api.alerts.onUpdate(receiveBudgetState);
    const unsubscribeHistory = api.dashboardHistory.onUpdate(() => {
      historyProvidersLoaded = false;
      if (activeTab === 5) loadHistory();
    });
    window.addEventListener(
      "beforeunload",
      () => {
        unsubscribeQuota();
        unsubscribeBudgets();
        unsubscribeHistory();
        unsubscribeResets?.();
      },
      { once: true },
    );
    loadAlerts();
    loadPricing();
    loadApikeyStatus();

    // Listen for refresh events from main process
    if (api.app.onRefresh) {
      api.app.onRefresh(() => refreshQuota());
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
