/** The snapshot's display settings, with the Settings page's unsaved changes on top. */
import type { QuotaSnapshot } from "../core/types.js";
import { settingsFromValues, type SurfaceSettings } from "../settings/display.js";

export function surfaceSettings(
  snapshot: QuotaSnapshot | undefined,
  preview?: Readonly<Record<string, unknown>>,
): SurfaceSettings {
  return settingsFromValues({ ...snapshot?.settings?.values, ...preview });
}
