/**
 * The status line at the bottom of Home, with the display settings a v5 config converts to.
 * JSX here builds plain `{ type, props }` nodes and never calls a component, so a test reads
 * what HomeFooter asks Solid to show.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { convertV5 } from "../src/settings/index.js";
import { displaySettings } from "../src/tui/display.js";
import type { SurfaceHost } from "../src/tui/sidebar.js";
import { stubJsx } from "./helpers/fake-tui-host.js";
import { findAll } from "./helpers/jsx-tree.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quota-tui-status-line-"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  stubJsx({ components: "keep" });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("HomeFooter", () => {
  it("shows the status line on Home for a v5 config that showed it only on Home", async () => {
    const v5 = join(root, "config", "opencode-quota", "quota-toast.jsonc");
    mkdirSync(join(root, "config", "opencode-quota"), { recursive: true });
    writeFileSync(
      v5,
      JSON.stringify({
        tuiCompactStatus: { enabled: true, sessionPrompt: false, homeBottom: true },
      }),
    );
    const conversion = await convertV5();
    const display = () => displaySettings(conversion!.settings);
    expect(display().surfaces.statusLine.enabled).toBe(false);

    const { HomeFooter, StatusLine } = await import("../src/tui/status-line.tsx");
    const host = {
      theme: () => ({ text: { muted: "muted" } }),
      display,
      quota: { homeLine: () => "", watchHome: () => () => {} },
    } as unknown as SurfaceHost;
    const footer = HomeFooter({ host });

    // Every <Show> around the status line: the footer's own, then the status line's.
    const shows = findAll(
      footer,
      (node) =>
        "when" in node.props &&
        findAll(node.props.children, (child) => child.type === StatusLine).length > 0,
    );
    expect(shows.map((node) => node.props.when)).toEqual([true, true]);
  });
});
