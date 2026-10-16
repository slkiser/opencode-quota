import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withConsumer } from "./lib/package-consumer.mjs";
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const binary = process.env.OPENCODE_HOST_BINARY || "opencode";
await withConsumer(process.argv[2], async (root) => {
  let modelRequests = 0;
  const model = createServer((_req, res) => {
    modelRequests++;
    res.writeHead(503, { "content-type": "application/json" });
    res.end('{"error":"model requests forbidden in deterministic command smoke"}');
  });
  await new Promise((resolve, reject) => {
    model.once("error", reject);
    model.listen(0, "127.0.0.1", resolve);
  });
  const profile = path.join(root, "host-profile");
  const configDir = path.join(profile, "config", "opencode");
  await mkdir(path.join(configDir, "opencode-quota"), { recursive: true });
  await writeFile(
    path.join(configDir, "opencode-quota", "quota-toast.json"),
    JSON.stringify({
      enabledProviders: [],
      enableToast: false,
      pricingSnapshot: { source: "bundled", autoRefresh: 0 },
    }),
  );
  await writeFile(
    path.join(configDir, "opencode.json"),
    JSON.stringify({
      plugin: [pathToFileURL(path.join(root, "node_modules", pkg.name, "dist/index.js")).href],
      model: "fixture/model",
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fixture",
          options: {
            baseURL: `http://127.0.0.1:${model.address().port}/v1`,
            apiKey: "fixture-not-a-real-key",
          },
          models: { model: { name: "Fixture", limit: { context: 8192, output: 1024 } } },
        },
      },
    }),
  );
  const env = {
    PATH: process.env.PATH,
    HOME: profile,
    USERPROFILE: profile,
    SHELL: "/bin/sh",
    TMPDIR: process.env.TMPDIR || "/tmp",
    XDG_CONFIG_HOME: path.join(profile, "config"),
    XDG_DATA_HOME: path.join(profile, "data"),
    XDG_STATE_HOME: path.join(profile, "state"),
    XDG_CACHE_HOME: path.join(profile, "cache"),
    BUN_INSTALL_CACHE_DIR: path.join(profile, "bun-cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
  };
  const hostVersion = execFileSync(binary, ["--version"], { env, encoding: "utf8" }).trim();
  assert.equal(hostVersion, process.env.OPENCODE_HOST_VERSION || "1.18.10");
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.on("error", (error) => {
    output += error.message;
    exited = true;
  });
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  try {
    const deadline = Date.now() + 30000;
    let url;
    while (Date.now() < deadline && !exited) {
      url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(url, `Host failed to start: ${output.slice(-2000)}`);
    const request = async (route, method = "GET", body) => {
      const response = await fetch(url + route, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      return { status: response.status, body: await response.json() };
    };
    const commands = await request("/command");
    assert.equal(commands.status, 200);
    assert.ok(
      commands.body.some((c) => c.name === "quota"),
      JSON.stringify(commands.body).slice(0, 1000),
    );
    const session = await request("/session", "POST", {
      title: "Isolated deterministic command smoke",
    });
    assert.equal(session.status, 200);
    assert.ok(session.body.id);
    const results = [];
    for (const command of ["quota", "quota_status", "quota_dashboard", "tokens_between"]) {
      assert.ok(
        commands.body.some((c) => c.name === command),
        `Missing host command ${command}`,
      );
      const result = await request(`/session/${session.body.id}/command`, "POST", {
        command,
        arguments: command === "tokens_between" ? "invalid" : "",
        model: "fixture/model",
      });
      results.push({
        command,
        status: result.status,
        diagnostic: result.status === 500 ? JSON.stringify(result.body).slice(0, 200) : undefined,
      });
      assert.ok([200, 500].includes(result.status));
      assert.equal(modelRequests, 0, `${command} reached the model endpoint`);
    }
    const messages = await request(`/session/${session.body.id}/message`);
    assert.equal(messages.status, 200);
    const ignored = messages.body
      .flatMap((m) => m.parts ?? [])
      .filter((p) => p.type === "text" && p.ignored === true && p.text?.length);
    assert.ok(ignored.length >= 4, JSON.stringify({ results, outputCount: ignored.length }));
    assert.equal(modelRequests, 0);
    console.log(
      JSON.stringify(
        {
          host: binary,
          hostVersion,
          package: pkg.name,
          version: pkg.version,
          results,
          ignoredOutputs: ignored.length,
          modelRequests,
          classification: "installed actual host; isolated configuration and model endpoint",
          hostDiagnostics: results.some((r) => r.status === 500)
            ? "host exposes handled abort as HTTP 500; output remains stored"
            : null,
        },
        null,
        2,
      ),
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (exited) return resolve();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise((resolve) => model.close(resolve));
  }
});
