import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { desktopUserDataPath, PACKAGE_NAME, PRODUCT_NAME } from "../src/lib/product-identity.js";
import { isQuotaPluginSpec } from "../src/lib/config-file-utils.js";

describe("Token Watcher identity migration", () => {
  it("retains the pre-rename Electron profile rather than creating a fresh account/theme store", () => {
    const appData = path.resolve("fixture-user", "Library", "Application Support");
    expect(desktopUserDataPath(appData)).toBe(path.join(appData, "@thanhndv212/opencode-quota"));
  });

  it("honors an explicit isolated profile instead of touching the user's retained profile", () => {
    const isolated = path.resolve("fixture-smoke", "profile");
    expect(desktopUserDataPath(path.resolve("actual-app-data"), isolated)).toBe(isolated);
  });

  it.each(["opencode", "tui"] as const)(
    "recognizes old and renamed %s plugins to prevent duplicate installation",
    (kind) => {
      for (const spec of [
        "@thanhndv212/token-watcher@3.11.0-rc.3",
        "@thanhndv212/opencode-quota@3.11.0-rc.2",
        "@slkiser/opencode-quota@3.10.1",
        `file:///projects/token-watcher/dist/${kind === "tui" ? "tui.tsx" : "index.js"}`,
      ])
        expect(isQuotaPluginSpec(spec, kind)).toBe(true);
      expect(isQuotaPluginSpec("@other/unrelated", kind)).toBe(false);
    },
  );

  it("aligns published package identity, app branding and installer migration identity", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(manifest.name).toBe(PACKAGE_NAME);
    const builder = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
    expect(builder).toContain(`productName: "${PRODUCT_NAME}"`);
    expect(builder).toContain("appId: io.github.thanhndv212.tokenwatcher");
  });
});
