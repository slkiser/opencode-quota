import { afterEach, vi } from "vite-plus/test";

afterEach(async () => {
  try {
    const pricing = await import("../src/lib/modelsdev-pricing.js");
    pricing.__resetPricingSnapshotForTests();
  } catch {
    // best effort; tests that don't load pricing module should still clean up
  }

  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
