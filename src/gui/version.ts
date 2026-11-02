/** Put in by the build (`.github/scripts/build-gui.mjs`); absent in tests. */
declare const __OQ_VERSION__: string | undefined;

/** The plugin's version, like "6.1.0"; "" where the build did not put it in. */
export const PLUGIN_VERSION = typeof __OQ_VERSION__ === "string" ? __OQ_VERSION__ : "";
