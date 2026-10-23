import { CURSOR_PROVIDER_ID } from "./shared.js";
import { createSdk, isCursorPackage } from "./plugin-core.js";
/** OpenCode's v2/promise `define` is an identity function. */
function define(plugin) {
    return plugin;
}
const plugin = define({
    id: "cursor.provider",
    setup: async (ctx) => {
        await ctx.aisdk.sdk((event) => {
            if (event.sdk)
                return;
            if (!isCursorPackage(event.package, event.model.providerID))
                return;
            event.sdk = createSdk({
                name: event.model.providerID || CURSOR_PROVIDER_ID,
                ...event.options,
            });
        });
        await ctx.aisdk.language((event) => {
            if (event.model.providerID !== CURSOR_PROVIDER_ID)
                return;
            if (event.language)
                return;
            if (typeof event.sdk?.languageModel !== "function")
                return;
            event.language = event.sdk.languageModel(event.model.api.id);
        });
    },
});
export default plugin;
