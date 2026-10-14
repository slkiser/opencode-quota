# COR-02: Account-safe cache implementation

Before COR-02, the shared quota cache identified configuration without the selected credential, allowing an account switch to reuse another account's memory, persisted, or pending result. The completed implementation applies the following safety contract.

1. Introduce explicit cache policies. Providers without a verified identity policy fetch uncached; cached-only reads return a miss. Account-neutral caching must be explicitly declared.
2. Adapt the pinned upstream protected HMAC identity implementation (4.x commit 5e20e58b3e516996cde7725601fc62e945025df1). Persist only a locator digest, never credentials or the opaque auth identity. Unavailable protected storage disables account caching.
3. A resolved-auth policy prepares both identity and a fetch closure using the same credential snapshot. This prevents credential switches, including A/B/A races, from assigning a fetched result to the wrong cache identity.
4. Version/invalidate old ambiguous snapshots; apply identity to memory, disk, pending work, and cached-only reads. Recheck pending work after asynchronous disk lookup. Explicit bypass never joins pending cached work.
5. Prove the contract with account switches, simultaneous requests, bypass, old snapshots, and serialized-state tests. Integrate DeepSeek using its actual env/global-config/OpenCode-auth resolver and frozen credential.
6. Audit and integrate provider-specific/internal caches. Unsupported adapters remain explicitly uncached in the shared layer; this can increase probes across independent surfaces. Explicitly uncached adapters do not claim account-scoped cache coverage.

Validation: targeted failing regressions first, full suite after each logical increment, installed-package/desktop CI before merge. Protected main and required checks remain mandatory. No live credentials or provider calls are needed for fixtures.

## Provider rollout and internal-cache audit (2026-10-08)

Every registered provider now declares a cache policy. None of the production providers is account-neutral.

| Policy              | Providers                                                    | Identity/fetch contract                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolved auth       | DeepSeek, Chutes, Synthetic, NanoGPT, Z.ai, Zhipu, Kimi Code | Selected API key is captured once; the same key performs every request in the transaction.                                                                                                     |
| Resolved auth       | OpenAI                                                       | Captured access token, account header, display email, and expiry; a changed account header invalidates reuse even if the token matches. Expired tokens do not authorize a cache hit.           |
| Resolved auth       | Copilot                                                      | PAT wins over OAuth; the selected token and PAT billing scope/tier/filter configuration identify the cache. The fetch uses the captured PAT target or OAuth token.                             |
| Resolved auth       | MiniMax international and China                              | Captured API key and endpoint identity; the endpoints remain separate providers.                                                                                                               |
| Resolved auth       | Ollama Cloud                                                 | Captured session cookie; configuration is read fresh before preparing the transaction.                                                                                                         |
| Resolved auth       | OpenCode Go                                                  | Captured ordered workspace set, cookies, IDs, and labels; fetching does not resolve the workspace list a second time.                                                                          |
| Explicitly uncached | Anthropic, Google Antigravity, Google Gemini CLI, Google AGY | CLI/keychain or companion-managed account selection cannot yet be frozen by these wrappers. Shared quota results and cached-only exports are disabled rather than using an ambiguous identity. |
| Explicitly uncached | Cursor, Qwen Code, Alibaba Coding Plan                       | Live local usage aggregates do not expose a verified account snapshot. Their historical account attribution remains separate ACC-02 work.                                                      |

There are 13 resolved-auth providers and 7 explicitly uncached providers. Uncached providers can perform more probes across surfaces; implementing reliable prepared snapshots for them is future work, not claimed cache coverage.

- `readAuthFileCached()` remains a compatibility entry point but reads auth fresh. TTL and in-flight auth reuse previously hid login switches/logout; quota TTL applies only after identity resolution.
- Ollama/OpenCode Go `*ConfigCached()` wrappers likewise resolve credential-bearing config fresh. OpenCode Go fetching uses one selected workspace configuration rather than two potentially different reads.
- Anthropic local and fallback diagnostics no longer retain or share account-dependent snapshots by binary path. Each call probes fresh; explicit bypass remains accepted for API compatibility. Provider cooldown verification remains COR-03 work; fresh diagnostics do not establish that gate.
- The outer rendered-toast cache has been removed from the plugin path. Every lifecycle event checks provider availability and account identity before rendering. Shared scoped results still avoid repeat requests for supported providers, and session-token rendering stays current.
- Google access-token caching remains separate credential storage: its lookup key includes refresh token, project, and email; credential rotation changes the key. The existing private-file permission tests remain required. It does not authorize shared quota-result caching.
- Companion module resolution caches retain code loading only, not quota observations. Other API-key/config resolvers read their selected env/trusted-config/auth input before the prepared fetch is created.

## Validation and merge gate

Regression fixtures cover selected-credential capture, A/B/A switching, trusted-config removal and auth-file rotation, OpenAI account headers, Copilot PAT target changes, workspace-set replacement, auth logout, fresh Anthropic diagnostics, and successive lifecycle toasts. Existing shared-cache tests cover disk restart, opaque serialization, concurrent accounts, and explicit bypass during pending work.

`pnpm run smoke:account-cache` (after `pnpm run build`) adds real separate-process evidence: concurrent Chutes A/B fixtures share one protected identity key, retain separate disk results, and read their own persisted observations after process restart without extra requests. It inspects quota files for opaque locators and absence of credential/identity strings. Linux quality CI runs this after build and tests.

Local validation on 2026-10-08 used Node 22.23.3 and pnpm 10.0.0. All 134 Vitest files / 1,336 tests passed, including the five command/TUI/provider boundary suites. Other passing gates: typecheck, Vitest, build/check with installed tarball, account-cache process smoke, and installed-tarball Electron smoke. GUI provider responses remain fixture-backed; these results do not establish live provider correctness or actual OpenCode-host integration. COR-02 is complete: [PR #35](https://github.com/thanhndv212/opencode-quota/pull/35) merged at `3165abf`, and [main CI 37787732500](https://github.com/thanhndv212/opencode-quota/actions/runs/37787732500) passed all six checks, including quality/process isolation, Node 20/22 installed tarballs, Linux/macOS Electron, and the required gate. [PR CI 37787317404](https://github.com/thanhndv212/opencode-quota/actions/runs/37787317404) also passed before merge. The seven uncached adapters and COR-03 cooldown gate remain explicit limits.
