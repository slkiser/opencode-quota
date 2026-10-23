import { vi } from "vite-plus/test";

/** One stored OpenCode login, in the shape OpenCode 2 keeps it. */
export type FakeCredential = {
  integrationId: string;
  /** Connection id (`cred_…` in OpenCode). */
  id: string;
  label: string;
  /** Whether `list()` shows this integration; unregistered (alias) ids answer only `active()`. */
  registered: boolean;
  method: "key" | "oauth" | "external";
  /**
   * The stored value: `{ type: "key", key, metadata? }`, `{ type: "oauth", ..., metadata? }`
   * or `{ type: "external", methodID, metadata? }`.
   */
  value: Record<string, unknown>;
  /** When set, `resolve()` rejects with this message (a failed token refresh). */
  resolveError?: string;
};

type FakeConnection =
  | { type: "credential"; id: string; label: string; method: "key" | "oauth" | "external" }
  | { type: "env"; name: string };

const FAKE_LOCATION = { directory: "/tmp/opencode-quota-fake-location" };

/**
 * A fake of the server plugin's `ctx.integration` with OpenCode 2.0.28's Promise shapes:
 * `list()` and `get()` return `{ location, data }` envelopes and `get()` rejects for an
 * unregistered id; `connection.active()` and `connection.resolve()` return bare values.
 * Credentials are listed in the given order, which stands for OpenCode's own order (active
 * first, then newest). `envNames` adds env connections to registered ids, after their
 * credentials, the way OpenCode does. Every method is a `vi.fn`, so tests can count calls
 * or make one reject.
 */
export function createFakeIntegration(
  credentials: FakeCredential[],
  options: { envNames?: Record<string, string> } = {},
) {
  const envNames = options.envNames ?? {};
  const registeredIds = [
    ...new Set([
      ...credentials.filter((credential) => credential.registered).map((c) => c.integrationId),
      ...Object.keys(envNames),
    ]),
  ];
  const connectionsFor = (integrationId: string): FakeConnection[] => [
    ...credentials
      .filter((credential) => credential.integrationId === integrationId)
      .map((credential) => ({
        type: "credential" as const,
        id: credential.id,
        label: credential.label,
        method: credential.method,
      })),
    ...(registeredIds.includes(integrationId) && envNames[integrationId]
      ? [{ type: "env" as const, name: envNames[integrationId] }]
      : []),
  ];
  const info = (integrationId: string) => ({
    id: integrationId,
    name: integrationId,
    methods: [],
    connections: connectionsFor(integrationId),
  });

  const integration = {
    list: vi.fn(async () => ({ location: FAKE_LOCATION, data: registeredIds.map(info) })),
    get: vi.fn(async ({ integrationID }: { integrationID: string }) => {
      if (!registeredIds.includes(integrationID)) {
        throw new Error(`Integration not found: ${integrationID}`);
      }
      return { location: FAKE_LOCATION, data: info(integrationID) };
    }),
    connection: {
      active: vi.fn(async (integrationID: string) => connectionsFor(integrationID)[0]),
      resolve: vi.fn(async (connection: FakeConnection) => {
        if (connection.type === "env") return { type: "key", key: `env:${connection.name}` };
        const credential = credentials.find((candidate) => candidate.id === connection.id);
        if (!credential) return undefined;
        if (credential.resolveError !== undefined) throw new Error(credential.resolveError);
        return structuredClone(credential.value);
      }),
    },
  };
  return integration;
}
