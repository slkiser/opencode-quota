# Security

## Threat Model

### Overview

cursor-opencode-provider is an OpenCode plugin and AI SDK provider that speaks Cursor's private agent protocol. Through the host it can trigger powerful tools (shell, file operations, network access via host MCP/tools) and it sends workspace context, instructions, and tool results to Cursor.

### No Sandbox

Neither this provider nor OpenCode's permission system is a security sandbox. Permissions help users review and control actions; they are not an isolation boundary.

If you need isolation, run the host in a disposable container, virtual machine, or similarly restricted environment. Review project instructions and third-party tool or MCP server configuration before allowing them to execute.

### Project `instructions` can include arbitrary local paths

This provider mirrors OpenCode's trust model for project configuration. That has implications for what ends up in Cursor context.

OpenCode's `opencode.json` / `opencode.jsonc` `instructions` array may list:

- relative paths / globs (e.g. `.cursor/rules/*.md`)
- absolute paths
- home-relative paths (`~/…`)
- remote URLs supported by the host

OpenCode owns instruction discovery and supplies the resulting system prompt
to the AI SDK provider. This package forwards that prompt as Cursor's
always-apply system-instructions rule; it does not independently read instruction
or skill file bodies or fetch instruction URLs. Its merged-config read supplies
MCP server ids, plugin metadata and interaction guidance
([`src/context/rules.ts`](src/context/rules.ts),
[`src/context/build.ts`](src/context/build.ts)).

So a project config like:

```json
{
  "instructions": ["docs/project-guide.md", "/absolute/path/to/approved-guide.md"]
}
```

can cause those files to be read by OpenCode and included in the prompt sent to
Cursor. The provider does not add an instruction-path allowlist or remove content
already supplied by the host. Review instruction paths before enabling project
configuration, especially if they could refer to sensitive local files.

Treat project `opencode.json` as **trusted**. Do not open untrusted repositories with project config enabled if that is unacceptable.

#### Mitigation: disable project config

To ignore project-level OpenCode config (including project `instructions` and project `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` discovery), set:

```bash
export OPENCODE_DISABLE_PROJECT_CONFIG=1
```

Set this before starting OpenCode and use the host's project-config controls to
suppress project instructions. The provider also skips its own project config
metadata reads when this flag is set; global config still applies. It cannot
remove instruction text that a host has already included in the supplied prompt
([`loadMergedConfig`](src/context/rules.ts)).

Truthy values: `1` or `true` (case-insensitive), same as OpenCode.

Instruction URL fetching and redirect policy belong to the host; this provider
has no separate instruction-fetch policy.

### Out of Scope

| Category | Rationale |
| --- | --- |
| **Sandbox escapes** | The host permission system is not a sandbox (see above) |
| **Cursor / LLM data handling** | Data sent to Cursor is governed by Cursor's policies and your account terms |
| **MCP server behavior** | External MCP servers you configure are outside our trust boundary |
| **Malicious project config** | Users control their own configuration; trusted project `instructions` reading absolute/`~/` paths is expected OpenCode parity (see above) |
| **Host tool execution after user approval** | Actions the host runs under its normal permission prompts are expected behavior |

---

## Reporting Security Issues

Do not report a suspected vulnerability in a public GitHub issue, discussion, or pull request.

Use GitHub's private [vulnerability reporting form](https://github.com/oakimov/cursor-opencode-provider/security/advisories/new). This keeps the report and subsequent discussion private between the reporter and the repository maintainers.

Include the affected version, environment (OpenCode 1.x vs 2.0, plugin entrypoint), impact, reproduction steps, and any suggested mitigation. The initial message should not include credentials, personal data, or exploit code beyond what is needed to reproduce the issue. If the report requires sensitive supporting material, first send a minimal description and ask the maintainers to coordinate a suitable transfer method.

Reports must describe a concrete, reproducible security impact. Automated scanner output or model-generated speculation without validation may not receive a response.

We will make a reasonable effort to acknowledge valid reports, but we cannot promise a specific response or remediation timeline.
