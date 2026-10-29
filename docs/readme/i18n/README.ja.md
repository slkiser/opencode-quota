<p align="center">
  <a href="https://github.com/slkiser/opencode-quota">
    <picture>
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" alt="OpenCode Quota のロゴ">
    </picture>
  </a>
</p>
<p align="center">OpenCode の TUI と Desktop で、クォータ、使用量、コストを確認できます。</p>
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
  <a href="https://github.com/slkiser/opencode-quota"><img src="https://shawnkiser.com/opencode-quota/opencode-quota-v6-hero.gif" alt="OpenCode で動く OpenCode Quota：サイドバー、クォータウィンドウの Usage タブと Limits タブ、そして設定" /></a>
</p>

---

## インストール

```bash
opencode plugin add @slkiser/opencode-quota
```

OpenCode を再起動して `/quota` と入力します。上限を表示するウィンドウが開きます。Usage（使用量）、Limits（上限）、Plugin（プラグイン）、または Settings（設定）内のタブをクリックするか、`tab` を押してタブを切り替えます。閉じるには、クリックするか `esc` を押します。

> [!IMPORTANT]
> OpenCode `2.0.26+` が必要です。ターミナルのコマンドには Node.js `22.13+` または `23.4+` も必要です。

> [!NOTE]
> まだ OpenCode 1 を使っている場合は、代わりに `npx @slkiser/opencode-quota@4 init` を実行し、[OpenCode 1 の README](https://github.com/slkiser/opencode-quota/blob/release/4.x/README.md) も参照してください。

<details>
<summary><code>opencode.json</code> を自分で編集する</summary>

`opencode.jsonc` または `opencode.json` にプラグインを追加します。ほかのプラグインはそのまま残してください。`~/.config/opencode` に書けばすべてのプロジェクトで、プロジェクトのフォルダーに書けばそのプロジェクトだけで動きます。この 1 つのエントリーで、サーバーと TUI の両方が読み込まれます：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

</details>

## 主な機能

- **TUI：** `/quota` で、Usage、Limits、Plugin、Settings のタブがあるウィンドウが開きます。TUI にはさらに、サイドバーの Quota パネル、入力欄の下のステータスライン、トーストが加わります。
- **Desktop（実験的、OpenCode `2.2.0+`）：** **Quota** コマンドで使用量ウィンドウ（Limits、Cost、Tokens）が開きます。Desktop にはほかに、固定された Quota サイドタブ、タイトルバーのピル、ウィンドウ下部のストリップ、入力欄の上のピル、トースト、セッションメニューの **Quota usage for this session**、OpenCode の設定内の Quota ページが加わります。同じプラグインエントリーで読み込まれます。オフにするには **Settings → Extensions → Plugins** を開きます。
  <details>
  <summary>各設定が TUI と Desktop で表示される場所</summary>
  <table>
  <tr><th>設定グループ</th><th>TUI</th><th>Desktop</th></tr>
  <tr><td><code>sidebar</code></td><td>サイドバーの Quota パネル</td><td>Quota サイドタブ</td></tr>
  <tr><td><code>collapsed</code></td><td>プロバイダーごとに 1 行へ折りたたんだサイドバーパネル</td><td>タイトルバーのピル、および折りたたんだときの Quota サイドタブ</td></tr>
  <tr><td><code>statusLine</code></td><td>入力欄の下の行</td><td>ウィンドウ下部のストリップ、および入力欄の上のピル</td></tr>
  <tr><td><code>toast</code></td><td>バー付きのトースト</td><td>Quota サイドタブと同じ行とバーのトースト</td></tr>
  </table>
  <p><b>補足：</b>TUI では、サイドバーにクォータが表示されている間、ステータスラインは非表示になります。<b>Next to the sidebar</b>（<code>statusLine.withSidebar</code>）をオンにすると表示されます。Desktop では、ストリップはデフォルトで Quota サイドタブの横にも表示されます。<b>Next to the side panel</b>（<code>statusLine.withSidePanel</code>）でこれをオフにできます。</p>
  </details>
- **Web と Desktop：** `/quota`、`/quota_usage`、`/quota_status` は、レポートをあなたのメッセージとしてチャットに投稿します。AI がそれに返答することはなく、プラグインはすべての AI リクエストからそれを除外します。プラグインをアンインストールすると、過去のチャットにある古いレポートは除外されなくなります。Web ではフォントによって列が揃わないことがあります。
- **ターミナル：** `npx @slkiser/opencode-quota@latest show` は OpenCode を閉じていても使えます。
- **スクリプトとステータスバー：** JSON、エクスポートファイル、メトリクス。[外部連携](../external-integration.md)を参照してください。
- **OpenCode 2 向けに設計：** 設定は、開いているすべての OpenCode に即座に反映されます。

## コマンド

| コマンド | 表示内容 |
| --- | --- |
| `/quota` | 上限。Web と Desktop では、上限と直近 7 日間の使用量を並べて表示 |
| `/quota_usage [range]` | トークンと API コスト：`today`（デフォルト）、`24h`、`7d`、`30d`、`90d`、`all`、`session`（サブエージェントを含む）、`between`（2 つの日付の間） |
| `/quota_status` | セットアップの確認：ログイン、プロバイダー、料金、お知らせ |
| `/quota_settings` | 設定タブ（TUI のみ） |

例：`/quota_usage 30d` や `/quota_usage between 2026-09-01 2026-09-25`。ターミナルでは、OpenCode が開いていてもいなくても、`npx @slkiser/opencode-quota@latest show` でクォータを表示し、`npx @slkiser/opencode-quota@latest status` でセットアップを確認できます（[2 つの違い](../troubleshooting.md#terminal-commands)）。`--help` を付けると、すべてのオプションを確認できます。

## 設定

サイドバー、ステータスライン、トースト、色、表記、プロバイダーは `/quota_settings` で変更できます。**Save**（保存）は、変更した項目だけを OpenCode の設定フォルダー内の `opencode-quota/settings.jsonc` に書き込み、コメントはそのまま残します。ファイルを編集すると、数秒以内に開いているすべての TUI に反映されます。Desktop では、OpenCode の設定内の Quota ページも同じファイルに保存します。カスタムプロバイダー、Claude CLI のパス、エクスポート先のパスはファイルでのみ設定できます。[設定とデフォルト値](../configuration.md)。

## プロバイダー

`/connect` でログインすると、そのプロバイダーが表示されます。プロバイダーのオン／オフは `/quota_settings` → **Providers** で切り替えます。

<table>
<tr>
<td valign="top">

| 米国 | プラン |
| --- | --- |
| [Anthropic (Claude)](../providers.md#anthropic-claude)\* | 個人 · ビジネス |
| [Cursor](../providers.md#cursor)\* | 個人 · ビジネス |
| [Gemini CLI](../providers.md#gemini-cli)\* | ビジネス |
| GitHub Copilot | 個人 · [ビジネス](../providers.md#github-copilot)\* |
| [Google AGY](../providers.md#google-agy-quick-setup)\* | 個人 · ビジネス |
| Ollama Cloud | 個人 |
| OpenAI | 個人 · ビジネス |
| OpenCode Go | 個人 |
| OpenCode Zen | 個人 · ビジネス |
| OpenRouter | 個人 · ビジネス |
| xAI | 個人 · ビジネス |

</td>
<td valign="top">

| 中国 | プラン |
| --- | --- |
| [Alibaba Coding Plan](../providers.md#alibaba-coding-plan)\* | 個人 |
| [Alibaba Token Plan](../providers.md#alibaba-token-plan)\* | 個人 · ビジネス |
| DeepSeek | 個人 |
| Kimi Code | 個人 · ビジネス |
| Kimi Code (CN) | 個人 · ビジネス |
| MiniMax Token Plan | 個人 · ビジネス |
| MiniMax Token Plan (CN) | 個人 · ビジネス |
| [Xiaomi MiMo](../providers.md#xiaomi-mimo)\* | 個人 |
| Z.ai Coding Plan | 個人 |
| Zhipu Coding Plan | 個人 · ビジネス |

</td>
</tr>
</table>

\* リンク付きの名前は、追加の手順が 1 つ必要です。それ以外はログインするだけで使えます。[各プロバイダーが報告する内容](../providers.md#pre-configured-providers)。

OpenAI の ChatGPT クォータには Codex でのログインが必要です（[方法](../providers.md#openai-and-xai)）。Gemini CLI は Gemini Code Assist Standard または Enterprise（組織）のアカウントでのみ動作します。個人の Google ユーザーは Google AGY を使ってください。中国のプロバイダーのビジネスプランでは、あなた自身のメンバー API キーの使用量だけが表示されます。ただし Alibaba Token Plan は、チームのシートごとに Credits 行を 1 つ表示します。API キーは OpenCode または[環境変数](../providers.md#api-keys)から取得されます。

### カスタムプロバイダー

ほかのどのプロバイダーでも、そのクォータ API またはローカルでの推定から追跡できます。エージェントにカスタムプロバイダーの追加を頼んでください。オフの状態で保存されるので、`/quota_settings` → **Providers** でオンにします。[コピー＆ペースト用のプロンプト](../providers.md#custom-providers)。

## アップデート

```bash
opencode plugin update
```

OpenCode を再起動します。4.x または 5.x からのアップデートですか？設定は初回起動時に変換され、古い `/tokens_*` コマンドも引き続き使えます。[アップデート](../updating.md)を参照してください。

## トラブルシューティング

1. OpenCode のセッションで `/quota_status` を実行するか、ターミナルで `npx @slkiser/opencode-quota@latest status` を実行します。
2. プロバイダーが表示されない場合は、OpenCode 2 でもう一度ログインしてください。
3. コンパニオンプラグイン（Cursor、Google）を使っている場合は、`opencode.json` でそれを `@slkiser/opencode-quota` より**前**に書いてください。
4. `claude` や `bl` が見つからない場合は、[サービス環境](../troubleshooting.md#service-environment)を参照してください。
5. `/quota_usage` が空の場合は、一度 OpenCode を起動してから、モデルを使ってください。
6. Desktop に Quota の GUI が出ない場合は、OpenCode `2.2.0+` が必要で、**Settings → Extensions → Plugins** のスイッチがオンである必要があります。Web はプラグインの GUI を表示しません。

そのほかの解決方法：[トラブルシューティング](../troubleshooting.md)。

## リファレンス

ガイド：[設定](../configuration.md) · [プロバイダー](../providers.md) · [トラブルシューティング](../troubleshooting.md) · [外部連携](../external-integration.md) · [アップデート](../updating.md)

外部リンク：[OpenCode ドキュメント](https://opencode.ai/docs/) · [OpenCode 設定](https://opencode.ai/docs/config/) · [OpenCode プラグイン](https://opencode.ai/docs/plugins/) · [OpenCode TUI](https://opencode.ai/docs/tui/) · [models.dev の料金データ](https://models.dev/) · [Node.js ダウンロード](https://nodejs.org/en/download)

## コントリビューター

OpenCode Quota に貢献してくださったすべての方に感謝します。

<a href="https://github.com/slkiser/opencode-quota/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=slkiser/opencode-quota" />
</a>

## ライセンス

MIT。OpenCode Quota は OpenCode チームが開発したものではなく、OpenCode や上記のどのプロバイダーとも提携していません。
