import { readFileSync } from "node:fs";

/** The models.dev price list shipped in this package: `providers[provider][model]` is a price. */
export const SHIPPED_PRICE_LIST: {
  _meta: { generatedAt: number };
  providers: Record<string, Record<string, Record<string, number>>>;
} = JSON.parse(
  readFileSync(new URL("../../src/data/modelsdev-pricing.min.json", import.meta.url), "utf8"),
);
