import { describe, expect, it } from "vitest";

import type { QuotaProviderResult } from "../src/lib/entries.js";
import { projectQuotaProviderResults } from "../src/lib/quota-accounting-projection.js";

function multiAccountResult(): QuotaProviderResult {
  return {
    attempted: true,
    errors: [],
    entries: [
      {
        accounting: {
          resultType: "rate_limit",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
          sourceId: "openai-multi-auth:business",
        },
        name: "OpenAI (Business) Weekly",
        group: "OpenAI (Business)",
        label: "Weekly:",
        percentRemaining: 0,
        resetTimeIso: "2026-08-22T12:00:00.000Z",
      },
      {
        accounting: {
          resultType: "rate_limit",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
          sourceId: "openai-multi-auth:business",
        },
        name: "OpenAI (Business) Code Review",
        group: "OpenAI (Business)",
        label: "Code Review:",
        percentRemaining: 20,
      },
      {
        accounting: {
          resultType: "rate_limit",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
          sourceId: "openai-multi-auth:personal",
        },
        name: "OpenAI (Personal) Weekly",
        group: "OpenAI (Personal)",
        label: "Weekly:",
        percentRemaining: 68,
        resetTimeIso: "2026-08-22T12:00:00.000Z",
      },
    ],
  };
}

describe("OpenAI multi-account projection", () => {
  it("keeps one selected quota row per account in single-window style", () => {
    expect(projectQuotaProviderResults([multiAccountResult()], "singleWindow", "summary")).toEqual([
      expect.objectContaining({ name: "[OpenAI] (Business) Weekly", percentRemaining: 0 }),
      expect.objectContaining({ name: "[OpenAI] (Personal) Weekly", percentRemaining: 68 }),
    ]);
  });

  it("keeps all returned windows for each account in all-windows style", () => {
    const projected = projectQuotaProviderResults([multiAccountResult()], "allWindows", "summary");
    expect(projected.map((entry) => entry.name)).toEqual([
      "OpenAI (Business) Weekly",
      "OpenAI (Business) Code Review",
      "OpenAI (Personal) Weekly",
    ]);
  });
});
