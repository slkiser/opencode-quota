import { expect } from "vite-plus/test";

type QuotaRpcHandler = (
  input: unknown,
  context: {
    signal: AbortSignal;
    error: (type: string, message: string, data?: unknown) => unknown;
  },
) => Promise<unknown>;

type QuotaRpcCallOptions = { location?: { directory: string }; signal?: AbortSignal };

type EventHandler = (event: { data: unknown }) => void;

/**
 * The RPC events between a server fake and a TUI fake: give `emit` to the server's
 * `ctx.rpc.register` answer and the bridge passes each event, as JSON, to the TUI's listeners.
 */
export function createQuotaRpcEvents() {
  const listeners = new Map<string, Set<EventHandler>>();
  return {
    emit: async (name: string, data: unknown) => {
      for (const handler of listeners.get(name) ?? []) {
        handler({ data: JSON.parse(JSON.stringify(data)) });
      }
    },
    on(name: string, handler: EventHandler, options?: { signal?: AbortSignal }) {
      const handlers = listeners.get(name) ?? new Set();
      handlers.add(handler);
      listeners.set(name, handlers);
      const stop = () => handlers.delete(handler);
      options?.signal?.addEventListener("abort", stop);
      return stop;
    },
  };
}

/**
 * A TUI fake's `client.rpc` that calls the handlers a server fake registered with
 * `ctx.rpc.register`. Like OpenCode's HTTP route it carries JSON: input and output make a
 * JSON round trip, and an output that is not a pure JSON value fails the call.
 */
export function createQuotaRpcBridge(
  handlers: Record<string, QuotaRpcHandler>,
  events: ReturnType<typeof createQuotaRpcEvents> = createQuotaRpcEvents(),
) {
  return (definition: { methods: Record<string, unknown> }) => ({
    ...Object.fromEntries(
      Object.keys(definition.methods).map((method) => [
        method,
        async (input: unknown, options?: QuotaRpcCallOptions) => {
          expect(options?.location).toBeDefined();
          const output = await handlers[method](JSON.parse(JSON.stringify(input)), {
            signal: options?.signal ?? new AbortController().signal,
            error: (type, message, data) => ({ type, message, data }),
          });
          expect(output).toStrictEqual(JSON.parse(JSON.stringify(output)));
          return JSON.parse(JSON.stringify(output));
        },
      ]),
    ),
    events: { on: events.on },
  });
}
