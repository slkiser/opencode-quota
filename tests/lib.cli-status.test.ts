import { describe, expect, it } from "vitest";

import { parseStatusArgs, STATUS_USAGE } from "../src/lib/cli-status.js";

describe("parseStatusArgs", () => {
  it("returns help=true for --help", () => {
    const result = parseStatusArgs(["--help"]);
    expect(result).toEqual({ ok: true, help: true, json: false });
  });

  it("returns help=true for -h", () => {
    const result = parseStatusArgs(["-h"]);
    expect(result).toEqual({ ok: true, help: true, json: false });
  });

  it("returns help=true even when other flags present (-h --json)", () => {
    const result = parseStatusArgs(["-h", "--json"]);
    expect(result).toEqual({ ok: true, help: true, json: false });
  });

  it("returns help=true for --help with extra positional after", () => {
    const result = parseStatusArgs(["--help", "status"]);
    expect(result).toEqual({ ok: true, help: true, json: false });
  });

  it("parses --json flag", () => {
    const result = parseStatusArgs(["--json"]);
    expect(result).toEqual({ ok: true, help: false, json: true });
  });

  it("treats duplicate --json as idempotent, not error", () => {
    const result = parseStatusArgs(["--json", "--json"]);
    expect(result).toEqual({ ok: true, help: false, json: true });
  });

  it("parses --provider with space-separated value", () => {
    const result = parseStatusArgs(["--provider", "copilot"]);
    expect(result).toEqual({ ok: true, help: false, json: false, providerId: "copilot" });
  });

  it("parses --provider with equals form", () => {
    const result = parseStatusArgs(["--provider=copilot"]);
    expect(result).toEqual({ ok: true, help: false, json: false, providerId: "copilot" });
  });

  it("parses --provider and --json in any order", () => {
    const result1 = parseStatusArgs(["--provider=copilot", "--json"]);
    expect(result1).toEqual({ ok: true, help: false, json: true, providerId: "copilot" });
    const result2 = parseStatusArgs(["--json", "--provider", "copilot"]);
    expect(result2).toEqual({ ok: true, help: false, json: true, providerId: "copilot" });
  });

  it("rejects --provider specified twice", () => {
    const result = parseStatusArgs(["--provider", "copilot", "--provider", "openai"]);
    expect(result).toEqual({ ok: false, error: "Specify --provider only once." });
  });

  it("rejects --provider without value", () => {
    const result = parseStatusArgs(["--provider"]);
    expect(result).toEqual({ ok: false, error: "Missing value for --provider." });
  });

  it("rejects --provider with value starting with dash", () => {
    const result = parseStatusArgs(["--provider", "--json"]);
    expect(result).toEqual({ ok: false, error: "Missing value for --provider." });
  });

  it("rejects --provider= with empty value", () => {
    const result = parseStatusArgs(["--provider="]);
    expect(result).toEqual({ ok: false, error: "Missing value for --provider." });
  });

  it("rejects --threshold with descriptive error", () => {
    const result = parseStatusArgs(["--threshold", "50"]);
    expect(result).toEqual({
      ok: false,
      error: "--threshold is not supported by status. Use 'show --json --threshold' instead.",
    });
  });

  it("rejects --threshold= equals form too", () => {
    const result = parseStatusArgs(["--threshold=50"]);
    expect(result).toEqual({
      ok: false,
      error: "--threshold is not supported by status. Use 'show --json --threshold' instead.",
    });
  });

  it("rejects unknown flag", () => {
    const result = parseStatusArgs(["--unknown-flag"]);
    expect(result).toEqual({ ok: false, error: "Unknown option: --unknown-flag" });
  });

  it("rejects unexpected positional argument", () => {
    const result = parseStatusArgs(["extra-positional"]);
    expect(result).toEqual({ ok: false, error: "Unexpected argument: extra-positional" });
  });

  it("rejects bare double-dash", () => {
    const result = parseStatusArgs(["--"]);
    expect(result).toEqual({ ok: false, error: "Unknown option: --" });
  });

  it("returns default no-flag path for empty argv", () => {
    const result = parseStatusArgs([]);
    expect(result).toEqual({ ok: true, help: false, json: false });
  });

  it("STATUS_USAGE contains status command and provider flag", () => {
    expect(STATUS_USAGE).toContain("opencode-quota status");
    expect(STATUS_USAGE).toContain("--provider");
    expect(STATUS_USAGE).toContain("--json");
    expect(STATUS_USAGE).toContain("--help");
  });
});
