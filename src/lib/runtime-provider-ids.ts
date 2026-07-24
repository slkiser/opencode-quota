import type { QuotaProviderContext } from "./entries.js";

export type RuntimeProviderIdResolver = () => Promise<ReadonlySet<string>>;

export function createRuntimeProviderIdResolver(
  client: QuotaProviderContext["client"],
): RuntimeProviderIdResolver {
  let pending: Promise<ReadonlySet<string>> | undefined;

  return () => {
    pending ??= client.config
      .providers()
      .then((response) => new Set((response.data?.providers ?? []).map((provider) => provider.id)));
    return pending;
  };
}
