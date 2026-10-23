import { describe, expect, it } from "vite-plus/test";
import { exampleProviderProvider } from "../src/providers/example-provider.js";
import {
  fakeHttp,
  fetchRows,
  keyLogin,
  requestHeader,
  rowSummary,
  useProviderWorld,
} from "./helpers/provider-fetch.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const RESET = "2026-01-02T00:00:00.000Z";

describe("example provider", () => {
  // Temp OpenCode folders and no provider keys in the environment, never this machine's own.
  const world = useProviderWorld();

  it("is not set up when it has no key, and sends nothing", async () => {
    const http = fakeHttp(() => {
      throw new Error("no request expected");
    });

    const fetched = await fetchRows(exampleProviderProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toEqual({ code: "not_configured" });
    expect(http).not.toHaveBeenCalled();
  });

  it("shows the monthly quota left of the env key", async () => {
    process.env.EXAMPLE_PROVIDER_API_KEY = "test-key";
    const http = fakeHttp(() => ({ used_percent: 25, resets_at: RESET }));

    const fetched = await fetchRows(exampleProviderProvider);

    expect(rowSummary(fetched.rows)).toEqual([
      ["example-provider.monthly", null, "Monthly", "month", 75, RESET],
    ]);
    expect(fetched.error).toBeUndefined();
    expect(requestHeader(http.mock.calls[0]?.[1], "Authorization")).toBe("Bearer test-key");
  });

  it("shows a failed check as the provider's error and keeps the message for /quota_status", async () => {
    process.env.EXAMPLE_PROVIDER_API_KEY = "test-key";
    fakeHttp(() => new Response("Unauthorized", { status: 401 }));

    const fetched = await fetchRows(exampleProviderProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toMatchObject({ code: "login_expired" });
    expect(fetched.debug).toContainEqual({
      key: "error",
      value: "Example Provider: Example Provider API error 401: Unauthorized",
    });
  });

  it("queries each key stored in OpenCode as its own account", async () => {
    world.storeLogins([
      keyLogin("work", "example-provider", "work-key", { label: "work", updated: 2 }),
      keyLogin("home", "example-provider", "home-key", { label: "home", updated: 1 }),
    ]);
    fakeHttp(() => ({ used_percent: 25 }));

    const fetched = await fetchRows(exampleProviderProvider);

    expect(fetched.rows.map((row) => row.account)).toEqual(["work", "home"]);
  });

  it("is available when OpenCode lists the provider, or with only a key", async () => {
    const listed = createProviderAvailabilityContext({ providerIds: ["example-provider"] });
    const unlisted = createProviderAvailabilityContext({ providerIds: [] });

    await expect(exampleProviderProvider.isAvailable(listed)).resolves.toBe(true);
    await expect(exampleProviderProvider.isAvailable(unlisted)).resolves.toBe(false);

    process.env.EXAMPLE_PROVIDER_API_KEY = "test-key";

    await expect(exampleProviderProvider.isAvailable(unlisted)).resolves.toBe(true);
  });
});
