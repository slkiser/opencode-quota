<p align="center">
  <a href="https://github.com/slkiser/opencode-quota">
    <picture>
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" alt="OpenCode Quota 标志">
    </picture>
  </a>
</p>
<p align="center">在 OpenCode 的 TUI 和 Desktop 中查看配额、用量和费用。</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@slkiser/opencode-quota"><img alt="npm" src="https://img.shields.io/npm/v/%40slkiser%2Fopencode-quota?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@slkiser/opencode-quota"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40slkiser%2Fopencode-quota?style=flat-square" /></a>
  <a href="https://github.com/slkiser/opencode-quota/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/slkiser/opencode-quota/ci.yml?style=flat-square&branch=main&label=CI" /></a>
  <a href="../../../LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" /></a>
</p>
<p align="center">
  <a href="../../../README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://github.com/slkiser/opencode-quota"><img src="https://shawnkiser.com/opencode-quota/opencode-quota-v6-hero.gif" alt="OpenCode 中的 OpenCode Quota：侧边栏、配额窗口的 Usage 和 Limits 标签页，以及它的设置" /></a>
</p>

---

## 安装

```bash
opencode plugin add @slkiser/opencode-quota
```

重启 OpenCode，然后输入 `/quota`。会打开一个显示你各项限额的窗口。点击标签页 Usage（用量）、Limits（限额）、Plugin（插件）或某个 Settings（设置）标签页，或按 `tab` 在它们之间切换；点击或按 `esc` 关闭窗口。

> [!IMPORTANT]
> 需要 OpenCode `2.0.26+`；终端命令还需要 Node.js `22.13+` 或 `23.4+`。

> [!NOTE]
> 还在用 OpenCode 1？请改为运行 `npx @slkiser/opencode-quota@4 init`，并参见 [OpenCode 1 的 README](https://github.com/slkiser/opencode-quota/blob/release/4.x/README.md)。

<details>
<summary>自己编辑 <code>opencode.json</code></summary>

把插件添加到 `opencode.jsonc` 或 `opencode.json`，并保留你的其他插件。写在 `~/.config/opencode` 中对所有项目生效；写在某个项目的文件夹中则只对该项目生效。这一项同时加载服务端和 TUI：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

</details>

## 功能

- **TUI：** `/quota` 会打开一个窗口，里面有 Usage、Limits、Plugin 和 Settings 标签页。TUI 还会有侧边栏中的 Quota 面板、输入框下方的状态行和 toast 提示。
- **Desktop（实验性，OpenCode `2.2.0+`）：** **Quota** 命令会打开用量窗口（Limits、Cost、Tokens）。Desktop 还会有固定的 Quota 侧边标签页、标题栏胶囊、窗口底部状态条、输入框上方的胶囊、toast 提示、会话菜单中的 **Quota usage for this session**，以及 OpenCode 设置中的 Quota 页面。同一个插件条目即可加载它；可在 **Settings → Extensions → Plugins** 中关闭。
  <details>
  <summary>各项设置在 TUI 和 Desktop 中的显示位置</summary>
  <table>
  <tr><th>设置组</th><th>TUI</th><th>Desktop</th></tr>
  <tr><td><code>sidebar</code></td><td>侧边栏中的 Quota 面板</td><td>Quota 侧边标签页</td></tr>
  <tr><td><code>collapsed</code></td><td>折叠成每个提供商一行的侧边栏面板</td><td>标题栏胶囊，以及折叠时的 Quota 侧边标签页</td></tr>
  <tr><td><code>statusLine</code></td><td>输入框下方的一行</td><td>窗口底部状态条，以及输入框上方的胶囊</td></tr>
  <tr><td><code>toast</code></td><td>带进度条的 toast 提示</td><td>toast 提示，每个提供商一句话</td></tr>
  </table>
  <p><b>注意：</b>在 TUI 中，侧边栏显示配额时状态行会隐藏，除非开启 <b>Next to the sidebar</b>（<code>statusLine.withSidebar</code>）。在 Desktop 中，状态条默认也会显示在 Quota 侧边标签页旁；<b>Next to the side panel</b>（<code>statusLine.withSidePanel</code>）可将其关闭。</p>
  </details>
- **Web 和 Desktop：** `/quota`、`/quota_usage` 和 `/quota_status` 会把报告作为你的消息发到聊天中。AI 从不回复它，插件也会把它从每次 AI 请求中过滤掉。卸载插件后，过去聊天中的旧报告将不再被过滤。Web 的字体可能无法让各列对齐。
- **终端：** 即使 OpenCode 已关闭，`npx @slkiser/opencode-quota@latest show` 也能使用。
- **脚本和状态栏：** JSON、导出文件和指标。参见[外部集成](../external-integration.md)。
- **为 OpenCode 2 打造：** 设置实时生效，作用于每个打开的 OpenCode。

## 命令

| 命令 | 显示内容 |
| --- | --- |
| `/quota` | 限额。Web 和 Desktop：限额与最近 7 天的用量并排显示 |
| `/quota_usage [range]` | token 和 API 费用：`today`（默认）、`24h`、`7d`、`30d`、`90d`、`all`、`session`（含其子代理）、`between` 两个日期之间 |
| `/quota_status` | 配置检查：登录、提供商、价格和提示 |
| `/quota_settings` | 设置标签页（仅 TUI） |

例如 `/quota_usage 30d` 或 `/quota_usage between 2026-09-01 2026-09-25`。在终端中，无论 OpenCode 是否打开，`npx @slkiser/opencode-quota@latest show` 都会显示你的配额，`npx @slkiser/opencode-quota@latest status` 会检查你的配置（[两者的区别](../troubleshooting.md#terminal-commands)）。加上 `--help` 可查看所有选项。

## 设置

在 `/quota_settings` 中修改侧边栏、状态行、toast 提示、颜色、措辞和提供商。**Save**（保存）只会把你改动的内容写入 OpenCode 配置文件夹中的 `opencode-quota/settings.jsonc`，并保留你的注释。编辑该文件后，几秒内就会生效到每个打开的 TUI。在 Desktop 中，OpenCode 设置里的 Quota 页面也保存到同一个文件。自定义提供商、Claude CLI 路径和导出路径只能在文件中设置。[设置和默认值](../configuration.md)。

## 提供商

用 `/connect` 登录后，提供商就会出现。在 `/quota_settings` → **Providers** 中开启或关闭各个提供商。

<table>
<tr>
<td valign="top">

| 美国 | 套餐 |
| --- | --- |
| [Anthropic (Claude)](../providers.md#anthropic-claude)\* | 个人 · 企业 |
| [Cursor](../providers.md#cursor)\* | 个人 · 企业 |
| [Gemini CLI](../providers.md#gemini-cli)\* | 企业 |
| GitHub Copilot | 个人 · [企业](../providers.md#github-copilot)\* |
| [Google AGY](../providers.md#google-agy-quick-setup)\* | 个人 · 企业 |
| Ollama Cloud | 个人 |
| OpenAI | 个人 · 企业 |
| OpenCode Go | 个人 |
| OpenCode Zen | 个人 · 企业 |
| OpenRouter | 个人 · 企业 |
| xAI | 个人 · 企业 |

</td>
<td valign="top">

| 中国 | 套餐 |
| --- | --- |
| [Alibaba Coding Plan](../providers.md#alibaba-coding-plan)\* | 个人 |
| [Alibaba Token Plan](../providers.md#alibaba-token-plan)\* | 个人 · 企业 |
| DeepSeek | 个人 |
| Kimi Code | 个人 · 企业 |
| Kimi Code (CN) | 个人 · 企业 |
| MiniMax Token Plan | 个人 · 企业 |
| MiniMax Token Plan (CN) | 个人 · 企业 |
| [Xiaomi MiMo](../providers.md#xiaomi-mimo)\* | 个人 |
| Z.ai Coding Plan | 个人 |
| Zhipu Coding Plan | 个人 · 企业 |

</td>
</tr>
</table>

\* 带链接的名称还需要多做一步；其余的登录后即可使用。[每个提供商报告哪些内容](../providers.md#pre-configured-providers)。

OpenAI ChatGPT 配额需要 Codex 登录（[方法](../providers.md#openai-and-xai)）。Gemini CLI 仅适用于 Gemini Code Assist Standard 或 Enterprise（组织）账号。个人 Google 用户请使用 Google AGY。中国提供商的企业套餐只显示你自己的成员 API 密钥的用量，但 Alibaba Token Plan 会为每个团队席位显示一行 Credits。API 密钥来自 OpenCode 或[环境变量](../providers.md#api-keys)。

### 自定义提供商

跟踪任何其他提供商，数据来自它的配额 API 或本地估算。让你的代理添加一个自定义提供商：它保存时处于关闭状态，你在 `/quota_settings` → **Providers** 中把它打开。[可复制粘贴的提示词](../providers.md#custom-providers)。

## 更新

```bash
opencode plugin update
```

重启 OpenCode。从 4.x 或 5.x 升级？你的设置会在首次启动时转换，旧的 `/tokens_*` 命令也仍然可用。参见[更新](../updating.md)。

## 故障排查

1. 在 OpenCode 会话中运行 `/quota_status`，或在终端中运行 `npx @slkiser/opencode-quota@latest status`。
2. 缺少某个提供商？在 OpenCode 2 中重新登录它。
3. 在用配套插件（Cursor、Google）？在 `opencode.json` 中把它列在 `@slkiser/opencode-quota` **之前**。
4. 找不到 `claude` 或 `bl`？参见[服务环境](../troubleshooting.md#service-environment)。
5. `/quota_usage` 为空？先启动一次 OpenCode，然后使用一个模型。
6. Desktop 中没有 Quota 界面？它需要 OpenCode `2.2.0+`，并在 **Settings → Extensions → Plugins** 中打开它的开关。Web 不显示插件界面。

更多解决方法：[故障排查](../troubleshooting.md)。

## 参考

指南：[配置](../configuration.md) · [提供商](../providers.md) · [故障排查](../troubleshooting.md) · [外部集成](../external-integration.md) · [更新](../updating.md)

外部链接：[OpenCode 文档](https://opencode.ai/docs/) · [OpenCode 配置](https://opencode.ai/docs/config/) · [OpenCode 插件](https://opencode.ai/docs/plugins/) · [OpenCode TUI](https://opencode.ai/docs/tui/) · [models.dev 价格数据](https://models.dev/) · [Node.js 下载](https://nodejs.org/en/download)

## 贡献者

感谢每一位为 OpenCode Quota 做出贡献的人。

<a href="https://github.com/slkiser/opencode-quota/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=slkiser/opencode-quota" />
</a>

## 许可证

MIT。OpenCode Quota 并非由 OpenCode 团队开发，与 OpenCode 或上面列出的任何提供商均无关联。
