# Provider template

Copy this folder when adding a provider that should use the README wording:

```text
Existing OpenCode auth, global config, or env
```

This template is intentionally outside `src/` and is not published to npm. `package.json` only publishes `dist`, `README.md`, and `LICENSE`.

## Who this is for

Use this template for API-key/token providers that support all three trusted sources:

1. existing OpenCode API-key/token auth (`opencode.db`)
2. trusted user/global OpenCode config
3. environment variables

Do not use it for OAuth-only providers such as OpenAI.

## Copy targets

| Template file      | Copy to                               | Purpose                                                  |
| ------------------ | ------------------------------------- | -------------------------------------------------------- |
| `config.ts`        | `src/lib/<provider>-config.ts`        | Resolve auth from OpenCode auth, global config, and env. |
| `provider.ts`      | `src/providers/<provider>.ts`         | Register availability, model matching, and result types. |
| `config.test.ts`   | `tests/lib.<provider>-config.test.ts` | Prove auth source precedence/fallbacks.                  |
| `provider.test.ts` | `tests/providers.<provider>.test.ts`  | Prove provider wrapper behavior.                         |

Also update:

- `src/lib/provider-registration.ts` with the provider metadata and display order
- `src/providers/registry.ts` with the provider singleton binding
- `README.md`
- `/quota_status` diagnostics when the provider exposes auth-source details

## Replacement checklist

Before coding, replace these placeholders everywhere:

- `example-provider`
- `Example Provider`
- `EXAMPLE_PROVIDER_API_KEY`
- `exampleProvider`
- `exampleProviderProvider`
- `queryExampleProviderQuota`

## README wording rule

Use `Existing OpenCode auth, global config, or env` only after tests prove all three paths work. Do not leave copied template tests skipped, todo-only, or unresolved. If one path is missing, use provider-specific wording instead.

In provider ledgers, use `Data from` rather than `Source`. These are friendly labels, not exact internal result types: use `Quota` as the umbrella for quota and rate-limit windows, join other multiple results with `and`, and use `Quota and usage` in that order. Keep exact internal `resultType` values in code and JSON/export documentation.

## Accounting row rule

The copied `provider.ts` intentionally demonstrates a simple percentage-only row. Keep that shape when the provider only has a percentage, but preserve the required `AccountingMetadata` and make `resultType`, acquisition, ownership, and authority match the real source.

If the provider exposes richer accounting facts, follow `CONTRIBUTING.md` instead of formatting them into the simple example:

- Numeric money/count data becomes a typed quantity or percentage basis fact; booleans become typed boolean rows.
- Every rich row has a complete semantic metric and explicit `primary` or `supplementary` prominence.
- Basis `used`, `limit`, and `remaining` values keep their literal meanings and individual authorities.
- Named metrics contain no values, units, reset text, or layout punctuation.
- Do not use financial `right` strings or `barValue`; shared formatting owns labels and values.
