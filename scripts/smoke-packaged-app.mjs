import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const binary = process.argv[2] && path.resolve(process.argv[2]);
if (!binary)
  throw new Error(
    "Usage: node scripts/smoke-packaged-app.mjs <installed-app-binary> [evidence-dir]",
  );
const nativeNotices = process.env.QUOTA_SMOKE_NATIVE_NOTICES === "1";
if (nativeNotices && process.platform !== "linux")
  throw new Error("Native daemon smoke is Linux-only; macOS requires observed UI permission.");
const evidence = path.resolve(process.argv[3] || "/tmp/quota-packaged-evidence");
await mkdir(evidence, { recursive: true });
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const root = await mkdtemp(path.join(tmpdir(), "quota-packaged-"));
let child;
let socket;
let exited = false;
let output = "";
const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  SHELL: "/bin/sh",
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_STATE_HOME: path.join(root, "state"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  OPENCODE_QUOTA_NODE_BINARY: process.execPath,
};
for (const key of [
  "ELECTRON_RUN_AS_NODE",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_QUOTA_SYNC_DIR",
  "OPENCODE_QUOTA_PROJECT_ROOT",
])
  delete env[key];
const settings = path.join(env.XDG_CONFIG_HOME, "opencode", "opencode-quota");
await mkdir(settings, { recursive: true });
await writeFile(
  path.join(settings, "quota-toast.json"),
  JSON.stringify({
    enabledProviders: [],
    ...(nativeNotices
      ? {
          resetNotifications: {
            enabled: true,
            watched: [{ providerId: "fixture-os-validation", windowId: "hourly" }],
            preferDesktop: true,
          },
        }
      : {}),
    enableToast: false,
    pricingSnapshot: { source: "bundled", autoRefresh: 0 },
  }),
);
const data = path.join(env.XDG_DATA_HOME, "opencode");
await mkdir(data, { recursive: true });
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(path.join(data, "opencode.db"));
db.exec(
  "CREATE TABLE session(id TEXT,title TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT)",
);
db.close();
if (nativeNotices) {
  const { DashboardApi } = await import("../dist/dashboard/api.js");
  const journal = new DatabaseSync(path.join(data, "quota-dashboard.db"));
  const history = new DashboardApi(journal);
  history.captureSnapshot("fixture-os-validation", {
    entries: [{ name: "Hourly fixture", percentRemaining: 100 }],
    errors: [],
  });
  const now = Date.now();
  const event = {
    id: "b".repeat(64),
    accountIdentity: "a".repeat(64),
    providerId: "fixture-os-validation",
    rowId: "hourly",
    windowId: "hourly",
    label: "Isolated Linux native delivery",
    previousResetAt: now - 1000,
    resetAt: now + 3600000,
    observedAt: now,
    previousRemaining: 5,
    percentRemaining: 100,
  };
  journal
    .prepare(
      "INSERT INTO reset_events(id,provider,account_identity,window_id,observed_at,reset_at,event_data,state) VALUES(?,?,?,?,?,?,?,'pending')",
    )
    .run(
      event.id,
      event.providerId,
      event.accountIdentity,
      event.windowId,
      event.observedAt,
      event.resetAt,
      JSON.stringify(event),
    );
  journal.close();
}
const wait = async (fn, label) => {
  const until = Date.now() + 25000;
  while (Date.now() < until && !exited) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Packaged app timed out: ${label}; ${output.slice(-1500)}`);
};
try {
  child = spawn(
    binary,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${path.join(root, "electron-profile")}`,
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.on("exit", () => (exited = true));
  child.on("error", (e) => {
    output += e.message;
    exited = true;
  });
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  const port = await wait(
    () => output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1],
    "DevTools endpoint",
  );
  const page = await wait(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (p) => p.type === "page" && p.url.startsWith("file:"),
      );
    } catch {
      return undefined;
    }
  }, "renderer target");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let next = 0;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown")
      exceptions.push(message.params.exceptionDetails.text);
    if (message.id) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) p.reject(new Error(message.error.message));
      else p.resolve(message.result);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await call("Runtime.enable");
  await call("Page.enable");
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await wait(
    () => evaluate("!!window.quotaApi && document.querySelectorAll('.tab-btn').length===6"),
    "preload and six tabs",
  );
  assert.equal(await evaluate("window.quotaApi.app.getVersion()"), pkg.version);
  assert.deepEqual((await evaluate("window.quotaApi.config.quota()")).config.enabledProviders, []);
  await evaluate("window.quotaApi.quota.fetch(true)");
  const tabs = [];
  for (let index = 0; index < 6; index++) {
    await evaluate(`document.querySelectorAll('.tab-btn')[${index}].click()`);
    const expected = [
      "Dashboard",
      "Input Tokens",
      "No budget alerts configured",
      "Pricing Snapshot",
      "Create Key Store",
      nativeNotices ? "Confirmed Reset Events" : "No quota history yet",
    ][index];
    await wait(
      () => evaluate(`document.body.innerText.includes(${JSON.stringify(expected)})`),
      `tab ${index} content`,
    );
    tabs.push(await evaluate("document.body.innerText.slice(0,2000)"));
    const png = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(
      path.join(evidence, `packaged-tab-${index}.png`),
      Buffer.from(png.data, "base64"),
    );
  }
  let nativeDelivery;
  if (nativeNotices) {
    await wait(
      async () =>
        (await evaluate("window.quotaApi.resets.events()")).some(
          (event) =>
            event.id === "b".repeat(64) &&
            event.state === "delivered" &&
            event.deliveredChannel === "desktop",
        ),
      "native delivery acknowledgment",
    );
    const displayed = Number(
      execFileSync("dunstctl", ["count", "displayed"], { encoding: "utf8" }).trim(),
    );
    assert.equal(displayed, 1, "Expected exactly one native daemon banner");
    execFileSync("scrot", [path.join(evidence, "native-os-banner.png")]);
    await evaluate(
      "window.__nativeResetOpen = null; window.quotaApi.resets.onOpen(value => {window.__nativeResetOpen = value}); document.querySelectorAll('.tab-btn')[0].click()",
    );
    execFileSync("dunstctl", ["action", "0"]);
    try {
      await wait(
        () =>
          evaluate(
            "document.body.innerText.includes('Window: hourly') && document.body.innerText.includes('Quota History')",
          ),
        "native daemon action navigates history/window",
      );
    } catch (error) {
      const diagnostic = {
        callback: await evaluate("window.__nativeResetOpen"),
        body: await evaluate("document.body.innerText"),
        daemonHistory: execFileSync("dunstctl", ["history"], { encoding: "utf8" }),
      };
      await writeFile(
        path.join(evidence, "NATIVE-ACTION-FAILURE.json"),
        JSON.stringify(diagnostic, null, 2),
      );
      const failurePng = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(
        path.join(evidence, "native-action-failure.png"),
        Buffer.from(failurePng.data, "base64"),
      );
      throw error;
    }
    const png = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(
      path.join(evidence, "native-action-history.png"),
      Buffer.from(png.data, "base64"),
    );
    nativeDelivery = {
      daemon: execFileSync("dunst", ["--version"], { encoding: "utf8" }).trim(),
      displayed,
      action: "dunstctl default action activated; actual OS callback/history navigation",
      events: await evaluate("window.quotaApi.resets.events()"),
      classification:
        "actual Linux X11/D-Bus daemon banner and action; synthetic reset event, not live provider or other desktop certification",
    };
    await writeFile(
      path.join(evidence, "NATIVE-DELIVERY.json"),
      JSON.stringify(nativeDelivery, null, 2),
    );
  }
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  const result = {
    name: pkg.name,
    version: pkg.version,
    platform: process.platform,
    arch: process.arch,
    binary: path.resolve(binary),
    renderer: page.url,
    preload: true,
    tabs: 6,
    nativeDelivery,
    exceptions,
    classification:
      "actual packaged binary; isolated settings/empty usage; no provider or model certification",
  };
  await writeFile(
    path.join(evidence, "PACKAGED-SMOKE.json"),
    JSON.stringify({ ...result, tabText: tabs }, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  await evaluate("window.quotaApi.app.quit()").catch(() => {});
} finally {
  socket?.close();
  if (child && !exited) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await rm(root, { recursive: true, force: true });
}
