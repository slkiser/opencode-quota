import { afterEach, describe, expect, it, vi } from "vitest";

import { formatQuotaRows } from "../src/lib/format.js";
import { fetchRemoteQuotaProvider } from "../src/lib/quota-providers-remote.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";
import { validateQuotaProviders } from "../src/lib/quota-providers.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

const validatedSources = validateQuotaProviders([
  {
    id: "mapped-source",
    providerId: "mapped-provider",
    label: " Mapped ",
    mode: "remote-api",
    url: "https://provider.example/quota",
    format: "json-v1",
    adapter: {
      mappings: [
        {
          resultType: "quota",
          name: " Requests ",
          label: " Requests: ",
          unit: " req ",
          unitPosition: "suffix",
          metric: {
            type: "remaining-limit",
            remaining: { path: ["remaining"] },
            limit: { path: ["limit"] },
          },
        },
        {
          resultType: "status",
          name: " Status ",
          metric: {
            type: "status",
            value: { path: ["status"] },
          },
        },
      ],
    },
  },
]);
const source = validatedSources.value?.[0];
if (!source || source.mode !== "remote-api" || source.format !== "json-v1") {
  throw new Error("Expected the json-v1 surface fixture to validate");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("json-v1 mapped quota presentation surfaces", () => {
  it("renders mapped percent and value rows on Web, toast, sidebar, and compact output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ remaining: 40, limit: 100, status: "Ready" })),
    );
    const result = await fetchRemoteQuotaProvider(source, "secret");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data = { entries: result.entries, errors: [] };
    const webInline = formatQuotaRows({
      version: "1.0.0",
      style: "allWindows",
      layout: { maxWidth: 80, narrowAt: 50, tinyAt: 32 },
      percentDisplayMode: "remaining",
      ...data,
    });
    const toast = formatQuotaRows({
      version: "1.0.0",
      style: "singleWindow",
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      percentDisplayMode: "remaining",
      ...data,
    });
    const sidebar = buildSidebarQuotaPanelLines({
      config: { formatStyle: "allWindows", percentDisplayMode: "remaining" },
      data,
    }).join("\n");
    const compact = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data,
    });

    for (const rendered of [webInline, toast, sidebar, compact]) {
      expect(rendered).toContain("40%");
      expect(rendered).toContain("Ready");
      expect(rendered).not.toContain("secret");
      expect(rendered.replace(/\r?\n/g, "")).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    }
    expect(webInline).toContain("Requests");
    expect(toast).toContain("[Mapped] 40/100 req");
    expect(sidebar).toContain("[Mapped]");
    expect(compact).toContain("Mapped");
  });
});
