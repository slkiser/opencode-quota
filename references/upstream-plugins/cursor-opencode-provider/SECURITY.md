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
- remote URLs (`https://…`; this provider fetches HTTPS only)

OpenCode itself expands `~/`, accepts absolute paths, and injects those file contents into the model prompt for **every** provider. This package does the same discovery when building Cursor `RequestContext.rules`.

So a project config like:

```json
{
  "instructions": ["~/.ssh/id_rsa", "/etc/passwd"]
}
```

can cause those files to be read and sent to the model provider (OpenCode prompt path and/or this provider's Cursor `RequestContext`). That is intentional OpenCode parity, not a Cursor-only hole. There is no path allowlist that rejects absolute/`~/` instruction paths (matching OpenCode; OpenCode has not treated this as a defect).

Treat project `opencode.json` as **trusted**. Do not open untrusted repositories with project config enabled if that is unacceptable.

#### Mitigation: disable project config

To ignore project-level OpenCode config (including project `instructions` and project `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` discovery), set:

```bash
export OPENCODE_DISABLE_PROJECT_CONFIG=1
```

OpenCode honors this flag when loading config and assembling prompts. This provider honors the same flag when collecting rules for Cursor `RequestContext`, so project `instructions` are not merged and project instruction files are not auto-discovered. Global config under `~/.config/opencode` (and `~/.claude/CLAUDE.md` when applicable) still applies.

Truthy values: `1` or `true` (case-insensitive), same as OpenCode.

#### Related hardening in this provider

- Remote `instructions` URLs are **HTTPS-only** (`http://` is skipped). Redirects (including to a local proxy) are intentional and not blocked.

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
