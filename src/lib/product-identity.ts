import path from "node:path";

export const PRODUCT_NAME = "Token Watcher";
export const PACKAGE_NAME = "@thanhndv212/token-watcher";
export const LEGACY_PACKAGE_NAME = "@thanhndv212/opencode-quota";

/** Retain the existing Electron profile, including local storage and window state.
 * Config, credentials and history retain their existing storage namespaces too. */
export function desktopUserDataPath(appData: string, explicitUserData = ""): string {
  return explicitUserData
    ? path.resolve(explicitUserData)
    : path.join(appData, LEGACY_PACKAGE_NAME);
}
