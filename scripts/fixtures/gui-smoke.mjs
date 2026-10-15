import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, session, Menu, powerMonitor, Tray } from "electron";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const helpers = [];
const fork = childProcess.fork;
childProcess.fork = (...args) => {
  const child = fork(...args);
  if (String(args[0]).includes("history-helper")) helpers.push(child);
  return child;
};
syncBuiltinESMExports();

// This is an external fixture harness, never a production-mode bypass. Load
// the actual installed main/preload/renderer/controller/provider pipeline.
// Quota HTTP is fixture-backed; unrelated tab IPC remains fixture-backed.
let fetches = 0;
let failNext = false;
let responseDelayMs = 0;
globalThis.fetch = async (input, options) => {
  assert.equal(String(input), "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(options.headers.Authorization, "Bearer gui-smoke-fixture-token");
  fetches++;
  if (responseDelayMs) await new Promise((done) => setTimeout(done, responseDelayMs));
  if (failNext) {
    failNext = false;
    return new Response("Fixture offline", { status: 503 });
  }
  return new Response(
    JSON.stringify({
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18_000,
          reset_after_seconds: 3600,
        },
      },
    }),
    { status: 200 },
  );
};
const noTray = process.env.QUOTA_SMOKE_NO_TRAY === "1";
if (noTray) {
  Tray.prototype.setToolTip = function () {
    this.destroy();
    throw new Error("Fixture system tray unavailable");
  };
}
let trayRefresh;
const buildMenu = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = (template) => {
  trayRefresh = template.find((item) => item.label === "Refresh Quota")?.click;
  return buildMenu(template);
};
const fixtures = {
  "tokens:query": () => ({
    aggregate: { totals: { costUsd: 0 }, bySourceModel: [], bySession: [] },
    window: { label: "7 days" },
  }),
  "pricing:list": () => ({ overrides: [], snapshot: null }),
  "apikeys:status": () => ({ state: "empty" }),
};
const realHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  if (fixtures[channel]) realHandle(channel, fixtures[channel]);
  else if (
    channel.startsWith("app:") ||
    channel.startsWith("config:") ||
    channel.startsWith("quota:") ||
    channel.startsWith("alerts:") ||
    channel.startsWith("dashboardHistory:") ||
    channel.startsWith("reset:")
  )
    realHandle(channel, handler);
  else
    realHandle(channel, () => {
      throw new Error(`Unexpected fixture IPC: ${channel}`);
    });
};

const errors = [];
app.on("web-contents-created", (_event, contents) => {
  contents.on("preload-error", (_event, _path, error) => errors.push(error.message));
  contents.on("console-message", (_event, details) => {
    if (details.level === "error") errors.push(details.message);
  });
  contents.on("render-process-gone", (_event, details) => errors.push(JSON.stringify(details)));
});
const deadline = setTimeout(() => {
  console.error("GUI smoke timed out", errors);
  app.exit(1);
}, 45_000);

async function waitFor(check, description) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
}

async function smoke() {
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (_details, callback) => {
        errors.push("Unexpected GUI network request");
        callback({ cancel: true });
      },
    );
    await import(pathToFileURL(process.env.QUOTA_SMOKE_MAIN).href);
    await waitFor(() => BrowserWindow.getAllWindows().length > 0, "main window");
    const win = BrowserWindow.getAllWindows()[0];
    const evaluate = (code) => win.webContents.executeJavaScript(code);
    await waitFor(
      () => evaluate('document.body.innerText.includes("OpenAI (Plus)")'),
      "fixture dashboard",
    );
    assert.equal(await evaluate("typeof window.quotaApi.quota.fetch"), "function");
    const settings = await evaluate("window.quotaApi.config.quota()");
    assert.equal(fetches, 1, "startup must query once, independent of renderer startup");
    assert.deepEqual(settings.config.enabledProviders, ["openai"]);
    assert.equal(settings.config.cursorPlan, "pro");
    assert.deepEqual(settings.config.resetNotifications, {
      enabled: false,
      watched: [],
      preferDesktop: true,
    });
    assert.deepEqual(await evaluate("window.quotaApi.resets.events()"), []);
    assert.equal(await evaluate('window.quotaApi.resets.retry("invalid")'), false);
    assert.equal(settings.config.requestTimeoutMs, 9000);
    assert.deepEqual(settings.meta.workspaceConfigPaths, []);
    assert.equal(settings.meta.globalConfigPaths.length, 1);
    await writeFile(
      join(process.env.XDG_CONFIG_HOME, "opencode", "opencode-quota", "quota-toast.json"),
      JSON.stringify({
        enabledProviders: ["openai"],
        minIntervalMs: 1,
        requestTimeoutMs: 12000,
        pricingSnapshot: { source: "bundled", autoRefresh: 0 },
      }),
    );
    const reloaded = await evaluate("window.quotaApi.config.reloadQuota()");
    assert.equal(reloaded.config.requestTimeoutMs, 12000);
    assert.equal(
      await evaluate("window.quotaApi.app.getVersion()"),
      process.env.QUOTA_SMOKE_VERSION,
    );
    for (const [index, expected] of [
      [1, "7 days"],
      [2, "No budget alerts configured"],
      [3, "override"],
      [4, "Create"],
      [5, "History"],
    ]) {
      await evaluate(`document.querySelectorAll('.tab-btn')[${index}].click()`);
      await waitFor(
        () => evaluate(`document.body.innerText.includes(${JSON.stringify(expected)})`),
        `tab ${index}`,
      );
    }
    win.webContents.send("reset:open", {
      providerId: "openai",
      windowId: "hourly",
      accountIdentity: "unknown",
    });
    await waitFor(
      () => evaluate("document.body.innerText.includes('Window: hourly')"),
      "reset notice opens selected window",
    );
    assert.ok(await evaluate("document.body.innerText.includes('Confirmed Reset Events')"));
    const initialHistory = await evaluate(
      'window.quotaApi.dashboardHistory.quotaHistory("openai")',
    );
    assert.equal(initialHistory.length, 1, "standalone startup must persist one observation");
    assert.equal(initialHistory[0].accountIdentity, "unknown");
    const richHistory = await evaluate(
      'window.quotaApi.dashboardHistory.accountingHistory("openai")',
    );
    assert.equal(richHistory.length, 1);
    assert.equal(richHistory[0].detail.value, "75% remaining");
    assert.equal(richHistory[0].detail.accountIdentity, "unknown");
    await evaluate(
      "window.__budgetEvents = 0; window.__historyEvents = 0; window.__budgetOff = window.quotaApi.alerts.onUpdate(() => window.__budgetEvents++); window.__historyOff = window.quotaApi.dashboardHistory.onUpdate(() => window.__historyEvents++); undefined",
    );
    const day = await evaluate(
      'window.quotaApi.alerts.create({ name: "Fixture day", scope: { type: "global" }, window: "day", metric: "tokens_input", threshold: 15, direction: "above" })',
    );
    const week = await evaluate(
      'window.quotaApi.alerts.create({ name: "Fixture week", scope: { type: "global" }, window: "week", metric: "tokens_input", threshold: 15, direction: "above" })',
    );
    const cost = await evaluate(
      'window.quotaApi.alerts.create({ name: "Unknown price", scope: { type: "global" }, window: "day", metric: "cost_usd", threshold: 1, direction: "below" })',
    );
    let budgets = await evaluate("window.quotaApi.alerts.state()");
    assert.equal(budgets.results.find((r) => r.rule.id === day.id).currentValue, 10);
    assert.equal(budgets.results.find((r) => r.rule.id === day.id).triggered, false);
    assert.equal(budgets.results.find((r) => r.rule.id === week.id).currentValue, 20);
    assert.equal(budgets.results.find((r) => r.rule.id === week.id).triggered, true);
    assert.equal(budgets.results.find((r) => r.rule.id === cost.id).status, "unknown");
    await evaluate(`window.quotaApi.alerts.update(${JSON.stringify(week.id)}, { threshold: 25 })`);
    await evaluate(`window.quotaApi.alerts.delete(${JSON.stringify(cost.id)})`);
    budgets = await evaluate("window.quotaApi.alerts.state()");
    assert.equal(budgets.triggeredCount, 0);
    assert.equal(
      budgets.results.some((r) => r.rule.id === cost.id),
      false,
    );
    assert.equal(fetches, 1, "rule edits must not refetch provider quota");
    await evaluate("document.querySelectorAll('.tab-btn')[0].click()");
    const before = fetches;
    await evaluate("document.querySelector('.btn-refresh').click()");
    await waitFor(() => fetches > before, "manual refresh");
    await waitFor(
      () => evaluate("window.quotaApi.quota.state().then(s => !s.fetching)"),
      "manual completion",
    );
    await evaluate("window.quotaApi.config.update({ refreshIntervalMs: 10000 })");
    win.hide();
    const beforeTimer = fetches;
    await waitFor(() => fetches === beforeTimer + 1, "scheduled refresh while hidden");
    await waitFor(
      () => evaluate("window.quotaApi.quota.state().then(s => !s.fetching)"),
      "timer completion",
    );
    if (noTray) {
      assert.equal(trayRefresh, undefined);
      await evaluate("window.quotaApi.quota.fetch(true)");
    } else {
      assert.equal(typeof trayRefresh, "function");
      trayRefresh();
    }
    await waitFor(() => fetches === beforeTimer + 2, "real tray refresh while hidden");
    await waitFor(
      () => evaluate("window.quotaApi.quota.state().then(s => !s.fetching)"),
      "tray completion",
    );
    // Suspend/resume goes through actual main-process power event handlers.
    powerMonitor.emit("suspend");
    assert.equal((await evaluate("window.quotaApi.quota.state()")).nextRefreshAt, null);
    powerMonitor.emit("resume");
    await waitFor(() => fetches === beforeTimer + 3, "wake refresh");
    await waitFor(
      () => evaluate("window.quotaApi.quota.state().then(s => !s.fetching)"),
      "wake completion",
    );
    await evaluate("window.quotaApi.config.update({ refreshIntervalMs: 0 })");
    win.show();
    await evaluate(
      "window.quotaApi.quota.state().then(s => { if (s.nextRefreshAt !== null) throw new Error('timer still active'); })",
    );
    responseDelayMs = 150;
    const beforeOverlap = fetches;
    await evaluate(
      "Promise.all(Array.from({ length: 5 }, () => window.quotaApi.quota.fetch(true)))",
    );
    assert.equal(fetches, beforeOverlap + 1, "overlapping manual calls must share one HTTP query");
    responseDelayMs = 0;
    failNext = true;
    const failed = await evaluate("window.quotaApi.quota.fetch(true)");
    assert.equal(failed.stale, true);
    assert.equal(failed.previousObservation, true);
    assert.equal(failed.entries.length, 1);
    await waitFor(
      () => evaluate('document.body.innerText.includes("Showing previous observation")'),
      "stale state in renderer",
    );
    const recovered = await evaluate("window.quotaApi.quota.fetch(true)");
    assert.equal(recovered.stale, false);
    assert.equal(recovered.previousObservation, false);
    await waitFor(
      () =>
        evaluate(
          'document.querySelector(".quota-refresh-status").innerText.startsWith("Updated ")',
        ),
      "renderer recovery",
    );
    await evaluate(
      "window.__smokeUpdates = 0; window.__smokeUnsubscribe = window.quotaApi.quota.onUpdate(() => window.__smokeUpdates++); undefined",
    );
    await evaluate("window.quotaApi.quota.fetch(true)");
    assert.equal(await evaluate("window.__smokeUpdates"), 2);
    await evaluate("window.__smokeUnsubscribe()");
    await evaluate("window.quotaApi.quota.fetch(true)");
    assert.equal(
      await evaluate("window.__smokeUpdates"),
      2,
      "unsubscribe removes only its own listener",
    );
    const history = await evaluate('window.quotaApi.dashboardHistory.quotaHistory("openai")');
    assert.ok(
      history.length > initialHistory.length,
      "hidden/manual refreshes must persist history",
    );
    assert.ok(history.some((row) => row.error?.includes("503") && row.percentRemaining === null));
    assert.ok(await evaluate("window.__historyEvents > 0 && window.__budgetEvents > 0"));
    await evaluate("window.__budgetOff(); window.__historyOff(); undefined");
    const eventCounts = await evaluate("[window.__budgetEvents, window.__historyEvents]");
    await evaluate("window.quotaApi.quota.fetch(true)");
    assert.deepEqual(
      await evaluate("[window.__budgetEvents, window.__historyEvents]"),
      eventCounts,
    );
    await evaluate("document.querySelectorAll('.tab-btn')[0].click(); undefined");
    await waitFor(
      () => evaluate("document.querySelectorAll('.accounting-details').length > 0"),
      "structured accounting details",
    );
    await evaluate("document.querySelector('.accounting-details').open = true; undefined");
    assert.ok(
      await evaluate(
        "document.querySelector('.accounting-details').innerText.includes('75% remaining')",
      ),
    );
    assert.ok(
      await evaluate(
        "document.querySelector('.accounting-details').innerText.includes('Source observation')",
      ),
    );
    assert.ok(
      await evaluate(
        "document.querySelector('.accounting-details').innerText.includes('Five-hour')",
      ),
    );
    if (process.env.QUOTA_SMOKE_SCREENSHOT_DIR) {
      await mkdir(process.env.QUOTA_SMOKE_SCREENSHOT_DIR, { recursive: true });
      const window = BrowserWindow.getAllWindows()[0];
      for (const [label, width] of [
        ["wide", 960],
        ["narrow", 480],
      ]) {
        window.setMinimumSize(400, 500);
        window.setSize(width, 820);
        await evaluate("document.querySelector('.accounting-details').scrollIntoView(); undefined");
        await writeFile(
          join(process.env.QUOTA_SMOKE_SCREENSHOT_DIR, `accounting-${label}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
    }
    assert.equal(
      await evaluate("document.body.innerText.includes('Fixed-window estimates')"),
      false,
      "identified OpenAI windows must not invent a fixed-window estimate",
    );
    // Presentation fixture: provider integration is covered separately by quota IPC tests.
    const { projectAccountingDetails } = await import(
      new URL("../lib/accounting-display.js", pathToFileURL(process.env.QUOTA_SMOKE_MAIN)).href
    );
    const now = Date.now();
    const fixed = {
      id: "explicit",
      name: "Fixture fixed window",
      resultType: "quota",
      prominence: "primary",
      source: {
        id: "fixture",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      account: { kind: "unknown" },
      freshness: { kind: "observed", observedAtIso: new Date(now).toISOString() },
      window: {
        kind: "fixed",
        id: "explicit",
        startedAtIso: new Date(now - 4 * 3600000).toISOString(),
        endsAtIso: new Date(now + 4 * 3600000).toISOString(),
        fullReset: true,
      },
      value: { kind: "percent", remaining: 25 },
    };
    const state = await evaluate("window.quotaApi.quota.state()");
    win.webContents.send("quota:updated", {
      ...state,
      revision: state.revision + 1000,
      accountingDetails: projectAccountingDetails(
        "fixture",
        { attempted: true, entries: [], errors: [], accounting: { version: 1, rows: [fixed] } },
        { quotaProjection: "runway", now },
      ),
    });
    await waitFor(
      () => evaluate("document.body.innerText.includes('≈ 1h 20m')"),
      "shared fixed-window estimate presentation",
    );
    assert.ok(await evaluate("document.body.innerText.includes('not a recent-rate prediction')"));
    if (process.env.QUOTA_SMOKE_SCREENSHOT_DIR) {
      for (const [label, width] of [
        ["wide", 960],
        ["narrow", 480],
      ]) {
        win.setMinimumSize(400, 500);
        win.setSize(width, 820);
        await evaluate("document.querySelector('.runway-estimates').scrollIntoView(); undefined");
        await writeFile(
          join(process.env.QUOTA_SMOKE_SCREENSHOT_DIR, `runway-${label}.png`),
          (await win.webContents.capturePage()).toPNG(),
        );
      }
    }
    assert.deepEqual(errors, []);
    clearTimeout(deadline);
    console.log(
      `Installed Electron GUI smoke passed: ${process.platform}, Electron ${process.versions.electron}, six tabs, config, startup/timer/tray/wake/coalesced HTTP refresh, stale/recovery, unsubscribe, persisted history, windowed budgets/rule edits, version, preload`,
    );
    assert.ok(helpers.length > 0, "installed main must launch the real history helper");
    app.once("will-quit", (event) => {
      event.preventDefault();
      void waitFor(
        () => helpers.every((child) => child.exitCode !== null || child.signalCode !== null),
        "history helper shutdown",
      )
        .then(() => app.exit(0))
        .catch((error) => {
          console.error(error);
          app.exit(1);
        });
    });
    await evaluate("window.quotaApi.app.quit()");
  } catch (error) {
    console.error(error, errors);
    clearTimeout(deadline);
    app.exit(1);
  }
}

// Electron waits for the ESM main module to finish evaluating before ready.
// Waiting for ready with top-level await would deadlock the bootstrap.
void smoke();
