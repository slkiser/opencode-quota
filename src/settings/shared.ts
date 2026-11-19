/**
 * The parts of the settings schema a client bundles: plain values with no imports, so a client
 * that takes them takes in no provider definition, price list or Node module. `schema.ts`
 * re-exports each of them.
 */

/** The names a color setting takes besides "#rrggbb": theme colors, and the row's bar color. */
export const THEME_COLOR_NAMES = [
  "text",
  "muted",
  "accent",
  "green",
  "yellow",
  "red",
  "blue",
  "bar",
] as const;

/** The setting kinds that hold an object by id, which a patch merges entry by entry. */
export const RECORD_KINDS: readonly string[] = ["names", "rowOrder", "window"];

/**
 * Settings where no value is not the same as the default value: unset, the providers with their
 * own request timeout use it; set, every provider uses that one.
 */
export const UNSET_IS_NOT_DEFAULT: ReadonlySet<string> = new Set([
  "providers.checking.requestTimeoutMs",
]);

/** Why a custom provider is not switched on: its definition is not the one the user saw. */
export const CHANGED_SINCE_REVIEW = "changed since you reviewed it; look again";

/** Sets a dotted key in a nested object, making the groups on the way. */
export function setPath(target: object, key: string, value: unknown): void {
  const parts = key.split(".");
  let group = target as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    group[part] ??= {};
    group = group[part] as Record<string, unknown>;
  }
  group[parts[parts.length - 1]] = value;
}
