import { describe, expect, it } from "vite-plus/test";
import { isCanonicalAccountingDecimal } from "../src/lib/accounting-format.js";

describe("accounting-format", () => {
  it("accepts only canonical decimals", () => {
    for (const value of ["0", "0.00", "1", "1.2300", "-0.1", "-12.50", "999999999999999999999"]) {
      expect(isCanonicalAccountingDecimal(value), value).toBe(true);
    }
    for (const value of [
      "",
      "+1",
      "01",
      "-0",
      "-0.0",
      ".1",
      "1.",
      "1e3",
      "NaN",
      "Infinity",
      "1,000",
    ]) {
      expect(isCanonicalAccountingDecimal(value), value).toBe(false);
    }
  });
});
