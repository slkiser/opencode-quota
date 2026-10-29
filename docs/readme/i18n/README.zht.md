<p align="center">
  <a href="https://github.com/slkiser/opencode-quota">
    <picture>
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" alt="OpenCode Quota 標誌">
    </picture>
  </a>
</p>
<p align="center">在 OpenCode 的 TUI 和 Desktop 中查看配額、用量和費用。</p>
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
  <a href="https://github.com/slkiser/opencode-quota"><img src="https://shawnkiser.com/opencode-quota/opencode-quota-v6-hero.gif" alt="OpenCode 中的 OpenCode Quota：側邊欄、配額視窗的 Usage 和 Limits 分頁，以及它的設定" /></a>
</p>

---

## 安裝

```bash
opencode plugin add @slkiser/opencode-quota
```

重新啟動 OpenCode，然後輸入 `/quota`。會開啟一個顯示你各項限額的視窗。點選分頁 Usage（用量）、Limits（限額）、Plugin（外掛）或某個 Settings（設定）分頁，或按 `tab` 在分頁之間切換；點一下或按 `esc` 關閉視窗。

> [!IMPORTANT]
> 需要 OpenCode `2.0.26+`；終端機指令還需要 Node.js `22.13+` 或 `23.4+`。

> [!NOTE]
> 還在用 OpenCode 1？請改為執行 `npx @slkiser/opencode-quota@4 init`，並參見 [OpenCode 1 的 README](https://github.com/slkiser/opencode-quota/blob/release/4.x/README.md)。

<details>
<summary>自行編輯 <code>opencode.json</code></summary>

把外掛加入 `opencode.jsonc` 或 `opencode.json`，並保留你的其他外掛。寫在 `~/.config/opencode` 中會在所有專案生效；寫在某個專案的資料夾中則只在該專案生效。這一個項目會同時載入伺服器端和 TUI：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

</details>

## 功能

- **TUI：** `/quota` 會開啟一個視窗，裡面有 Usage、Limits、Plugin 和 Settings 分頁。TUI 還會有側邊欄中的 Quota 面板、輸入框下方的狀態列和 toast 通知。
- **Desktop（實驗性，OpenCode `2.2.0+`）：** **Quota** 指令會開啟用量視窗（Limits、Cost、Tokens）。Desktop 還會有釘選的 Quota 側邊分頁、標題列膠囊、視窗底部狀態條、輸入框上方的膠囊、toast 通知、工作階段選單中的 **Quota usage for this session**，以及 OpenCode 設定中的 Quota 頁面。同一個外掛項目即可載入它；可在 **Settings → Extensions → Plugins** 中關閉。
  <details>
  <summary>各項設定在 TUI 和 Desktop 中的顯示位置</summary>
  <table>
  <tr><th>設定群組</th><th>TUI</th><th>Desktop</th></tr>
  <tr><td><code>sidebar</code></td><td>側邊欄中的 Quota 面板</td><td>Quota 側邊分頁</td></tr>
  <tr><td><code>collapsed</code></td><td>摺疊成每個供應商一行的側邊欄面板</td><td>標題列膠囊，以及摺疊時的 Quota 側邊分頁</td></tr>
  <tr><td><code>statusLine</code></td><td>輸入框下方的一行</td><td>視窗底部狀態條，以及輸入框上方的膠囊</td></tr>
  <tr><td><code>toast</code></td><td>帶進度條的 toast 通知</td><td>與 Quota 側邊分頁相同的列與進度條的 toast 通知</td></tr>
  </table>
  <p><b>注意：</b>在 TUI 中，側邊欄顯示配額時狀態列會隱藏，除非開啟 <b>Next to the sidebar</b>（<code>statusLine.withSidebar</code>）。在 Desktop 中，狀態條預設也會顯示在 Quota 側邊分頁旁；<b>Next to the side panel</b>（<code>statusLine.withSidePanel</code>）可將其關閉。</p>
  </details>
- **Web 和 Desktop：** `/quota`、`/quota_usage` 和 `/quota_status` 會把報告當成你的訊息貼到聊天中。AI 從不回覆它，外掛也會把它從每次 AI 請求中過濾掉。解除安裝外掛後，過去聊天中的舊報告將不再被過濾。Web 的字型可能無法讓各欄對齊。
- **終端機：** 即使 OpenCode 已關閉，`npx @slkiser/opencode-quota@latest show` 也能使用。
- **腳本和狀態列：** JSON、匯出檔案和指標。請參閱[外部整合](../external-integration.md)。
- **為 OpenCode 2 打造：** 設定即時生效，套用到每個開啟中的 OpenCode。

## 指令

| 指令 | 顯示內容 |
| --- | --- |
| `/quota` | 限額。Web 和 Desktop：限額與最近 7 天的用量並列顯示 |
| `/quota_usage [range]` | token 和 API 費用：`today`（預設）、`24h`、`7d`、`30d`、`90d`、`all`、`session`（含其子代理）、`between` 兩個日期之間 |
| `/quota_status` | 設定檢查：登入、供應商、價格和通知 |
| `/quota_settings` | 設定分頁（僅限 TUI） |

例如 `/quota_usage 30d` 或 `/quota_usage between 2026-09-01 2026-09-25`。在終端機中，無論 OpenCode 是否開啟，`npx @slkiser/opencode-quota@latest show` 都會顯示你的配額，`npx @slkiser/opencode-quota@latest status` 會檢查你的設定（[兩者的差異](../troubleshooting.md#terminal-commands)）。加上 `--help` 可查看所有選項。

## 設定

在 `/quota_settings` 中變更側邊欄、狀態列、toast 通知、顏色、措辭和供應商。**Save**（儲存）只會把你變更的內容寫入 OpenCode 設定資料夾中的 `opencode-quota/settings.jsonc`，並保留你的註解。編輯該檔案後，幾秒內就會套用到每個開啟中的 TUI。在 Desktop 中，OpenCode 設定裡的 Quota 頁面也會儲存到同一個檔案。自訂供應商、Claude CLI 路徑和匯出路徑只能在檔案中設定。[設定與預設值](../configuration.md)。

## 供應商

用 `/connect` 登入後，供應商就會出現。在 `/quota_settings` → **Providers** 中開啟或關閉各個供應商。

<table>
<tr>
<td valign="top">

| 美國 | 方案 |
| --- | --- |
| [Anthropic (Claude)](../providers.md#anthropic-claude)\* | 個人 · 企業 |
| [Cursor](../providers.md#cursor)\* | 個人 · 企業 |
| [Gemini CLI](../providers.md#gemini-cli)\* | 企業 |
| GitHub Copilot | 個人 · [企業](../providers.md#github-copilot)\* |
| [Google AGY](../providers.md#google-agy-quick-setup)\* | 個人 · 企業 |
| Ollama Cloud | 個人 |
| OpenAI | 個人 · 企業 |
| OpenCode Go | 個人 |
| OpenCode Zen | 個人 · 企業 |
| OpenRouter | 個人 · 企業 |
| xAI | 個人 · 企業 |

</td>
<td valign="top">

| 中國 | 方案 |
| --- | --- |
| [Alibaba Coding Plan](../providers.md#alibaba-coding-plan)\* | 個人 |
| [Alibaba Token Plan](../providers.md#alibaba-token-plan)\* | 個人 · 企業 |
| DeepSeek | 個人 |
| Kimi Code | 個人 · 企業 |
| Kimi Code (CN) | 個人 · 企業 |
| MiniMax Token Plan | 個人 · 企業 |
| MiniMax Token Plan (CN) | 個人 · 企業 |
| [Xiaomi MiMo](../providers.md#xiaomi-mimo)\* | 個人 |
| Z.ai Coding Plan | 個人 |
| Zhipu Coding Plan | 個人 · 企業 |

</td>
</tr>
</table>

\* 有連結的名稱還需要多一個步驟；其餘的登入後即可使用。[每個供應商回報哪些內容](../providers.md#pre-configured-providers)。

OpenAI ChatGPT 配額需要 Codex 登入（[作法](../providers.md#openai-and-xai)）。Gemini CLI 僅適用於 Gemini Code Assist Standard 或 Enterprise（組織）帳號。個人 Google 使用者請改用 Google AGY。中國供應商的企業方案只會顯示你自己成員 API 金鑰的用量，但 Alibaba Token Plan 會為每個團隊席位顯示一列 Credits。API 金鑰來自 OpenCode 或[環境變數](../providers.md#api-keys)。

### 自訂供應商

追蹤任何其他供應商，資料來自它的配額 API 或本機估算。請你的代理新增一個自訂供應商：它儲存時處於關閉狀態，你再到 `/quota_settings` → **Providers** 中把它開啟。[可直接複製貼上的提示詞](../providers.md#custom-providers)。

## 更新

```bash
opencode plugin update
```

重新啟動 OpenCode。從 4.x 或 5.x 升級？你的設定會在第一次啟動時轉換，舊的 `/tokens_*` 指令也仍然可用。請參閱[更新](../updating.md)。

## 疑難排解

1. 在 OpenCode 工作階段中執行 `/quota_status`，或在終端機中執行 `npx @slkiser/opencode-quota@latest status`。
2. 少了某個供應商？在 OpenCode 2 中重新登入它。
3. 有使用搭配的外掛（Cursor、Google）？在 `opencode.json` 中把它列在 `@slkiser/opencode-quota` **之前**。
4. 找不到 `claude` 或 `bl`？請參閱[服務環境](../troubleshooting.md#service-environment)。
5. `/quota_usage` 是空的？先啟動一次 OpenCode，然後使用一個模型。
6. Desktop 中沒有 Quota 介面？它需要 OpenCode `2.2.0+`，並在 **Settings → Extensions → Plugins** 中開啟它的開關。Web 不顯示外掛介面。

更多解決方法：[疑難排解](../troubleshooting.md)。

## 參考資料

指南：[組態](../configuration.md) · [供應商](../providers.md) · [疑難排解](../troubleshooting.md) · [外部整合](../external-integration.md) · [更新](../updating.md)

外部連結：[OpenCode 文件](https://opencode.ai/docs/) · [OpenCode 組態](https://opencode.ai/docs/config/) · [OpenCode 外掛](https://opencode.ai/docs/plugins/) · [OpenCode TUI](https://opencode.ai/docs/tui/) · [models.dev 價格資料](https://models.dev/) · [Node.js 下載](https://nodejs.org/en/download)

## 貢獻者

感謝每一位為 OpenCode Quota 做出貢獻的人。

<a href="https://github.com/slkiser/opencode-quota/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=slkiser/opencode-quota" />
</a>

## 授權條款

MIT。OpenCode Quota 並非由 OpenCode 團隊開發，與 OpenCode 或上方列出的任何供應商皆無關聯。
