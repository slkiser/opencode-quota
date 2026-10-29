import { describe, expect, it } from "vite-plus/test";

import {
  createGoogleAccountLabelMap,
  formatGoogleAccountErrors,
  formatGoogleAccountLabel,
} from "../src/providers/google-account-format.js";

describe("google account formatting helpers", () => {
  it("formats real ellipsis labels without repeating the domain", () => {
    expect(formatGoogleAccountLabel("alice@example.com", "fixedGmailHint")).toBe("ali…");
    expect(formatGoogleAccountLabel("alice@example.com", "domainHint")).toBe("ali…");
    expect(formatGoogleAccountLabel("bo@example.com", "domainHint")).toBe("bo…");
    expect(formatGoogleAccountLabel("local-only", "domainHint")).toBe("loc…");
  });

  it("extends or numbers colliding account hints without repeating domains", () => {
    const labels = createGoogleAccountLabelMap(
      ["alice@work.com", "alicia@example.com", "alice@personal.com"],
      "domainHint",
    );

    expect(labels.get("alice@work.com")).toBe("alice… 1");
    expect(labels.get("alicia@example.com")).toBe("alici…");
    expect(labels.get("alice@personal.com")).toBe("alice… 2");
    expect(new Set(labels.values()).size).toBe(3);
  });

  it("returns Unknown for missing or empty email", () => {
    expect(formatGoogleAccountLabel(undefined, "fixedGmailHint")).toBe("Unknown");
    expect(formatGoogleAccountLabel("", "domainHint")).toBe("Unknown");
  });

  it("maps account errors with preserved messages and shared labels", () => {
    const errors = [{ email: "bob@example.com", error: "Unauthorized" }];
    expect(formatGoogleAccountErrors(errors, "fixedGmailHint")).toEqual([
      { label: "bob…", message: "Unauthorized" },
    ]);
    expect(formatGoogleAccountErrors(errors, "domainHint")).toEqual([
      { label: "bob…", message: "Unauthorized" },
    ]);
  });
});
