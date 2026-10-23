# Provider template

Copy this folder when adding a provider that should use the README wording:

```text
Existing OpenCode auth, global config, or env
```

This template is outside `src/` and is not published to npm. `package.json` only publishes `dist`, `README.md`, and `LICENSE`.

## Who this is for

Use this template for API-key/token providers that support all three trusted sources:

1. existing OpenCode API-key/token login, read through the plugin API
2. trusted user/global OpenCode config
3. environment variables

Do not use it for OAuth-only providers such as OpenAI.

Auth is part of the provider's entry in `src/lib/provider-registration.ts`, not a new file: its `apiKey` lists the env var names and OpenCode provider ids. The shared resolver reads env, then trusted global config, then OpenCode logins for those ids, and `tests/lib.api-key-resolver.test.ts` covers that order; add a row to its vendor table.

## Copy targets

| Template file      | Copy to                              | Purpose                                                          |
| ------------------ | ------------------------------------ | ---------------------------------------------------------------- |
| `provider.ts`      | `src/providers/<provider>.ts`        | Ask the API, turn its reply into rows, say when it is available. |
| `provider.test.ts` | `tests/providers.<provider>.test.ts` | Prove the rows, the error and availability through fake HTTP.    |

Also update:

- `src/lib/provider-registration.ts`: one entry, in display order, with the provider's label, OpenCode ids, row keys (`rowKeys`) and key (`apiKey`)
- `src/providers/registry.ts`: bind the provider to its id (the compiler checks every id has one)
- `src/lib/quota-status.ts`: its `DEBUG_DETAILS` entry, `{}` when no debug detail needs redacting (the compiler checks this too)
- `tests/lib.api-key-resolver.test.ts`: a row in its vendor table
- `README.md`

## Replacement checklist

Before coding, replace these placeholders everywhere:

- `example-provider`
- `Example Provider`
- `EXAMPLE_PROVIDER_API_KEY`
- `exampleProvider`
- `exampleProviderProvider`
- `queryExampleRows`
- `https://api.example.com/v1/usage`

## README wording rule

Use `Existing OpenCode auth, global config, or env` only after tests prove all three paths work. Do not leave copied template tests skipped, todo-only, or unresolved. If one path is missing, use provider-specific wording instead.

In provider ledgers, use `Data from` rather than `Source`. These are friendly labels, not exact internal result types: use `Quota` as the umbrella for quota and rate-limit windows, join other multiple results with `and`, and use `Quota and usage` in that order. Keep exact internal `type` values in code and JSON/export documentation.

## Row rule

A provider returns the row contract in `src/providers/contract.ts`: per account, its rows and its errors, plus debug details for `/quota_status`. The copied `provider.ts` shows one remote quota row with the percent left (`quotaRow`). Keep that shape when the provider only reports a percentage.

Each row's `key` becomes its id (`example-provider.monthly`), which users' hide, rename and order settings use, so a key never changes once released. List every key in the provider's `rowKeys`; `fetchRows` in the provider tests fails on a key that is not listed.

If the provider reports more than a percentage, follow `.github/CONTRIBUTING.md`: amounts as typed `used`, `limit`, `remaining` or `amount` values, yes/no as `flag`, never pre-formatted money strings.
