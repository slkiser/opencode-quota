# CUS-01 — Global remote quota definitions

Issue: [#24](https://github.com/thanhndv212/opencode-quota/issues/24). Status: complete. PR #54 merged at `fd90be4`; all six merged-main CI 38755053941 checks passed. Evidence date: 2026-10-15. Dependencies: ACC-01 and COR-01/02 complete.

Adapted from upstream `130d82b` definitions, `f6393b3abb22beecd55b43da483acca6c496f8f6` quota-v1/json-v1 schemas and mature modules at `2733b5bd010f659d1d6007e5d19026e82d51353f`. Reviewed main `0819759854fa65c68daf53296972e890f9ad3f5c`: credential-database auth changes stay under the explicit host compatibility gate. Later plain-decimal text normalization (`5694966`) is not silently imported: this slice accepts JSON numbers, with explicit division, and reports numeric strings unavailable rather than coercing them. Existing fork providers are unchanged.

Definitions live in the trusted **global** opencode-quota/quota-toast.json sidecar under quotaProviders. Global experimental.quotaToast.quotaProviders is a legacy fallback. Workspace definitions, merged SDK values and root-level OpenCode quotaProviders never define endpoints. First global definition source wins, including an empty array. Malformed/unreadable definition sources disable all custom providers and produce a credential-free configuration issue; ordinary malformed-file diagnostics are not duplicated.

Use stable IDs beginning with custom- to keep user sources separate from built-ins. providerId identifies the actual runtime/auth provider and defaults to id. Optional exact modelIds restrict matching. The namespace is a deliberate fork adaptation; built-ins cannot be overridden.

```json
{
  "quotaProviders": [
    {
      "id": "custom-acme",
      "providerId": "acme",
      "label": "Acme",
      "mode": "remote-api",
      "url": "https://quota.example.test/status",
      "apiKeyEnv": "ACME_API_KEY",
      "format": "json-v1",
      "adapter": {
        "mappings": [
          {
            "name": "Daily requests",
            "resultType": "quota",
            "unit": "requests",
            "metric": {
              "type": "used-limit",
              "used": { "path": ["usage", "used"] },
              "limit": { "path": ["usage", "limit"] }
            }
          }
        ]
      }
    }
  ]
}
```

Remote requests are authenticated GET only, with the declared env variable, trusted global provider API-key config or existing key login. No arbitrary methods/headers, inline credentials, executable expressions or scripts. HTTPS is required except explicit loopback HTTP. URL userinfo, fragments and credential query parameters are rejected. All redirects are refused. The selected definition and credential form one immutable fetch snapshot; the full definition fingerprint invalidates caches when endpoint/mapping/model selection changes. Removed/invalid definitions stop old provider objects from fetching. Cache identities and credentials never become public history identity.

Bounds: 16 definitions, 16 mappings per definition, 64 output rows, eight path segments, bounded strings/numeric magnitude, 64 KiB config documents and a 1 MiB streaming response cap within the whole-response deadline. Paths read own properties only and reject prototype/constructor segments. Arrays require explicit rowsPath. Missing/malformed mapped fields retain other valid rows and report bounded row errors. Literal operand authority is user configured; calculated percentages are locally derived. Units remain distinct, zero denominators are unknown, and over-limit values remain negative. Source timestamps require explicit timestamp mappings; reset boundaries remain identified rather than fabricated full-reset windows. Account identity remains unknown.

json-v1 metrics: percentage (used/remaining), used-limit, remaining-limit, spend-budget, remaining-budget, numeric value and explicit status. Number sources are JSON-number paths or numeric literals, with path division by 100/1,000/1,000,000. Text/status sources are paths or literals. Timestamps declare ISO-8601, Unix seconds or Unix milliseconds. USD-style three-letter units are currency; known count units stay counts; other declared units stay custom units. No cross-unit summation.

quota-v1 accepts the bounded `{ "version": "quota-v1", "entries": [...] }` envelope with explicit percent/value rows. Value strings remain unparsed display facts with unknown quantity semantics; percentage rows preserve negative values. Optional labels, right-hand text and valid source/reset timestamps remain available. Credential reflection in either format rejects the response before cache/history/export persistence. Error responses and exceptions never expose raw bodies, endpoints or tokens.

## Acceptance and rollback

Node 22.23.3/pnpm 10.0.0: typecheck; 159 files / 1,648 tests; clean installed-tarball consumer; account-cache process smoke; actual native Node/Bun 1.3.14 history compatibility; installed macOS Electron 42.5.0 smoke passed. Two real isolated HTTP endpoints with different protocols feed shared desktop IPC, command, toast/sidebar formatting. Tests verify auth fallbacks, prototype/script/header rejection, model filtering, cache reuse/change/removal, stalled valid bodies, oversized valid JSON, redirect refusal and credential reflection. Command-handled/no-model-call boundary tests remain green.

Installed Electron smoke verifies package startup and the existing HTTP-fixture pipeline. Custom endpoint semantics are independently exercised with real local HTTP fixture integration, not live-user service or real host certification. No user configuration was changed.

Rollback: remove the global quotaProviders field or clear the array, then reload quota settings. Existing provider objects fail closed after removal. No database migration. Built-ins and stable JSON exports retain their existing contracts; custom entries use the same rendering/export boundary.
