/**
 * Runtime duck-type boundary for the OpenCode 2.0 plugin — not host conformance.
 *
 * Only the methods and fields this plugin calls or publishes. Extra host
 * fields are ignored at runtime. Do not import `@opencode/plugin`: it is not a
 * standalone types surface we can pin next to `@opencode-ai/plugin`, and a host
 * dependency would force a plugin bump on every OpenCode release.
 *
 * Compile-time checks that our *calls and payloads* still fit the fuller host
 * editor live in `test/opencode2-conformance.types.ts` against
 * `test/opencode2-host-contract.ts`.
 *
 * Effect `Schema` brands (Provider.ID, Model.ID, …) are modelled as plain
 * `string`; brands are compile-time only and erase at runtime.
 */
export {};
