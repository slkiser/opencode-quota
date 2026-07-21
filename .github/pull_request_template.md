## Summary

Describe the change and why it is needed.

## Linked Issue

Use `Fixes #...` or `Refs #...` when available.  
If no issue exists, include a short rationale/scope summary.

## OpenCode Validation

- Current production released OpenCode version tested:
- Why this version is relevant to the fix:

## Quality Checklist

- [ ] I ran `pnpm run typecheck`
- [ ] I ran `pnpm run build`
- [ ] I ran `pnpm test`
- [ ] This is the smallest safe root-cause fix (no unnecessary hook/output mutation logic)
- [ ] I preserved behavioral invariants and updated/added boundary tests as needed
- [ ] I updated docs for user-facing workflow/command/config changes (`README.md` and `CONTRIBUTING.md` when applicable)
- [ ] For new API-key/token providers, I started from `contributing/provider-template/` or explained why the template does not apply
- [ ] For provider setup/auth wording changes, I checked the relevant dummy `.ts` template in `contributing/provider-template/` and verified `README.md` against `src/lib/provider-metadata.ts` (`authentication`/`authFallbacks`) and provider auth resolver/diagnostics behavior
