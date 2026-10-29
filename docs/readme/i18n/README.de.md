<p align="center">
  <a href="https://github.com/slkiser/opencode-quota">
    <picture>
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" alt="OpenCode-Quota-Logo">
    </picture>
  </a>
</p>
<p align="center">Kontingente, Nutzung und Kosten in der TUI und in Desktop von OpenCode.</p>
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
  <a href="https://github.com/slkiser/opencode-quota"><img src="https://shawnkiser.com/opencode-quota/opencode-quota-v6-hero.gif" alt="OpenCode Quota in OpenCode: die Seitenleiste, die Tabs Usage und Limits des Quota-Fensters und seine Einstellungen" /></a>
</p>

---

## Installation

```bash
opencode plugin add @slkiser/opencode-quota
```

Starte OpenCode neu und gib `/quota` ein. Ein Fenster mit deinen Limits öffnet sich. Klicke auf einen Tab (Usage, Limits, Plugin oder einen der Settings-Tabs) oder drücke `tab`, um zwischen ihnen zu wechseln; klicke oder drücke `esc`, um es zu schließen.

> [!IMPORTANT]
> Du brauchst OpenCode `2.0.26+`; die Terminal-Befehle brauchen außerdem Node.js `22.13+` oder `23.4+`.

> [!NOTE]
> Noch auf OpenCode 1? Führe stattdessen `npx @slkiser/opencode-quota@4 init` aus und sieh dir die [README für OpenCode 1](https://github.com/slkiser/opencode-quota/blob/release/4.x/README.md) an.

<details>
<summary><code>opencode.json</code> selbst bearbeiten</summary>

Füge das Plugin zu `opencode.jsonc` oder `opencode.json` hinzu und behalte deine anderen Plugins. In `~/.config/opencode` gilt es für alle Projekte, im Ordner eines Projekts nur dort. Dieser eine Eintrag lädt sowohl den Server als auch die TUI:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

</details>

## Funktionen

- **TUI:** `/quota` öffnet ein Fenster mit den Tabs Usage, Limits, Plugin und Settings. Die TUI bekommt außerdem ein Quota-Panel in der Seitenleiste, eine Statuszeile unter dem Eingabefeld und Toasts.
- **Desktop (experimentell, OpenCode `2.2.0+`):** Der Befehl **Quota** öffnet ein Nutzungsfenster (Limits, Cost, Tokens). Desktop bekommt außerdem einen angehefteten Quota-Seitentab, eine Pille in der Titelleiste, eine Leiste am unteren Rand, eine Pille über dem Eingabefeld, Toasts, den Eintrag **Quota usage for this session** im Sitzungsmenü und eine Quota-Seite in den Einstellungen von OpenCode. Derselbe Plugin-Eintrag lädt das; abschalten kannst du es unter **Settings → Extensions → Plugins**.
  <details>
  <summary>Wo jede Einstellung in der TUI und in Desktop erscheint</summary>
  <table>
  <tr><th>Einstellungsgruppe</th><th>TUI</th><th>Desktop</th></tr>
  <tr><td><code>sidebar</code></td><td>Quota-Panel in der Seitenleiste</td><td>Quota-Seitentab</td></tr>
  <tr><td><code>collapsed</code></td><td>Seitenleisten-Panel auf eine Zeile pro Anbieter eingeklappt</td><td>Pille in der Titelleiste und der eingeklappte Quota-Seitentab</td></tr>
  <tr><td><code>statusLine</code></td><td>Zeile unter dem Eingabefeld</td><td>Leiste am unteren Rand des Fensters und die Pille über dem Eingabefeld</td></tr>
  <tr><td><code>toast</code></td><td>Toasts mit Balken</td><td>Toasts mit den Zeilen und Balken des Quota-Seitentabs; ein Reset-Hinweis ist ein Satz</td></tr>
  </table>
  <p><b>Hinweis:</b> In der TUI blendet sich die Statuszeile aus, solange die Seitenleiste Kontingente zeigt, außer <b>Next to the sidebar</b> (<code>statusLine.withSidebar</code>) ist an. In Desktop erscheint die Leiste standardmäßig auch neben dem Quota-Seitentab; <b>Next to the side panel</b> (<code>statusLine.withSidePanel</code>) schaltet das ab.</p>
  </details>
- **Web und Desktop:** `/quota`, `/quota_usage` und `/quota_status` posten ihren Bericht als deine Nachricht in den Chat. Die KI antwortet nie darauf, und das Plugin filtert ihn aus jeder KI-Anfrage heraus. Nach der Deinstallation des Plugins werden alte Berichte in früheren Chats nicht mehr gefiltert. Die Schrift im Web richtet die Spalten eventuell nicht sauber aus.
- **Terminal:** `npx @slkiser/opencode-quota@latest show` funktioniert auch, wenn OpenCode geschlossen ist.
- **Skripte und Statusleisten:** JSON, eine Exportdatei und Metriken. Siehe [Externe Integration](../external-integration.md).
- **Für OpenCode 2 gebaut:** Einstellungen gelten sofort, in jedem offenen OpenCode.

## Befehle

| Befehl | Was er zeigt |
| --- | --- |
| `/quota` | Limits. Web und Desktop: Limits neben der Nutzung der letzten 7 Tage |
| `/quota_usage [range]` | Tokens und API-Kosten: `today` (Standard), `24h`, `7d`, `30d`, `90d`, `all`, `session` (mit ihren Subagenten), `between` (zwischen zwei Daten) |
| `/quota_status` | Setup-Prüfung: Logins, Anbieter, Preise und Hinweise |
| `/quota_settings` | Einstellungs-Tabs (nur TUI) |

Zum Beispiel `/quota_usage 30d` oder `/quota_usage between 2026-09-01 2026-09-25`. Im Terminal, ob OpenCode offen oder geschlossen ist, zeigt `npx @slkiser/opencode-quota@latest show` dein Kontingent und `npx @slkiser/opencode-quota@latest status` prüft dein Setup ([wie sie sich unterscheiden](../troubleshooting.md#terminal-commands)). Mit `--help` siehst du alle Optionen.

## Einstellungen

Seitenleiste, Statuszeile, Toasts, Farben, Formulierungen und Anbieter änderst du in `/quota_settings`. **Save** schreibt nur deine Änderungen nach `opencode-quota/settings.jsonc` im Konfigurationsordner von OpenCode und behält deine Kommentare. Eine Änderung an der Datei erreicht jede offene TUI innerhalb weniger Sekunden. In Desktop speichert die Quota-Seite in den Einstellungen von OpenCode in dieselbe Datei. Eigene Anbieter, der Pfad zur Claude CLI und der Exportpfad lassen sich nur in der Datei festlegen. [Einstellungen und Standardwerte](../configuration.md).

## Anbieter

Melde dich mit `/connect` an, und der Anbieter erscheint. Schalte Anbieter in `/quota_settings` → **Providers** ein oder aus.

<table>
<tr>
<td valign="top">

| USA | Tarife |
| --- | --- |
| [Anthropic (Claude)](../providers.md#anthropic-claude)\* | Privat · Business |
| [Cursor](../providers.md#cursor)\* | Privat · Business |
| [Gemini CLI](../providers.md#gemini-cli)\* | Business |
| GitHub Copilot | Privat · [Business](../providers.md#github-copilot)\* |
| [Google AGY](../providers.md#google-agy-quick-setup)\* | Privat · Business |
| Ollama Cloud | Privat |
| OpenAI | Privat · Business |
| OpenCode Go | Privat |
| OpenCode Zen | Privat · Business |
| OpenRouter | Privat · Business |
| xAI | Privat · Business |

</td>
<td valign="top">

| China | Tarife |
| --- | --- |
| [Alibaba Coding Plan](../providers.md#alibaba-coding-plan)\* | Privat |
| [Alibaba Token Plan](../providers.md#alibaba-token-plan)\* | Privat · Business |
| DeepSeek | Privat |
| Kimi Code | Privat · Business |
| Kimi Code (CN) | Privat · Business |
| MiniMax Token Plan | Privat · Business |
| MiniMax Token Plan (CN) | Privat · Business |
| [Xiaomi MiMo](../providers.md#xiaomi-mimo)\* | Privat |
| Z.ai Coding Plan | Privat |
| Zhipu Coding Plan | Privat · Business |

</td>
</tr>
</table>

\* Verlinkte Namen brauchen einen Schritt mehr; die übrigen funktionieren, sobald du angemeldet bist. [Was jeder Anbieter meldet](../providers.md#pre-configured-providers).

Das ChatGPT-Kontingent von OpenAI braucht einen Codex-Login ([so geht's](../providers.md#openai-and-xai)). Gemini CLI funktioniert nur mit Konten für Gemini Code Assist Standard oder Enterprise (Organisation). Private Google-Nutzer sollten Google AGY verwenden. Business-Tarife der chinesischen Anbieter zeigen nur die Nutzung deines eigenen Mitglieds-API-Schlüssels, außer Alibaba Token Plan, der pro Team-Platz eine Credits-Zeile zeigt. API-Schlüssel kommen aus OpenCode oder aus einer [Umgebungsvariable](../providers.md#api-keys).

### Eigene Anbieter

Verfolge jeden anderen Anbieter, über seine Quota-API oder per lokaler Schätzung. Bitte deinen Agenten, einen eigenen Anbieter hinzuzufügen: Er wird ausgeschaltet gespeichert, und du schaltest ihn in `/quota_settings` → **Providers** ein. [Prompt zum Kopieren](../providers.md#custom-providers).

## Aktualisieren

```bash
opencode plugin update
```

Starte OpenCode neu. Du kommst von 4.x oder 5.x? Deine Einstellungen werden beim ersten Start umgewandelt, und die alten `/tokens_*`-Befehle funktionieren weiterhin. Siehe [Aktualisieren](../updating.md).

## Fehlerbehebung

1. Führe `/quota_status` in einer OpenCode-Sitzung aus oder `npx @slkiser/opencode-quota@latest status` in einem Terminal.
2. Ein Anbieter fehlt? Melde dich in OpenCode 2 erneut bei ihm an.
3. Du nutzt ein Begleit-Plugin (Cursor, Google)? Trage es in `opencode.json` **vor** `@slkiser/opencode-quota` ein.
4. `claude` oder `bl` nicht gefunden? Siehe [Dienstumgebung](../troubleshooting.md#service-environment).
5. `/quota_usage` ist leer? Starte OpenCode einmal und nutze dann ein Modell.
6. Keine Quota-Oberfläche in Desktop? Sie braucht OpenCode `2.2.0+` und ihren eingeschalteten Schalter unter **Settings → Extensions → Plugins**. Web zeigt keine Plugin-Oberflächen.

Weitere Lösungen: [Fehlerbehebung](../troubleshooting.md).

## Referenz

Anleitungen: [Konfiguration](../configuration.md) · [Anbieter](../providers.md) · [Fehlerbehebung](../troubleshooting.md) · [Externe Integration](../external-integration.md) · [Aktualisieren](../updating.md)

Externe Links: [OpenCode-Doku](https://opencode.ai/docs/) · [OpenCode-Konfiguration](https://opencode.ai/docs/config/) · [OpenCode-Plugins](https://opencode.ai/docs/plugins/) · [OpenCode-TUI](https://opencode.ai/docs/tui/) · [models.dev-Preisdaten](https://models.dev/) · [Node.js-Downloads](https://nodejs.org/en/download)

## Mitwirkende

Danke an alle, die zu OpenCode Quota beigetragen haben.

<a href="https://github.com/slkiser/opencode-quota/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=slkiser/opencode-quota" />
</a>

## Lizenz

MIT. OpenCode Quota wird nicht vom OpenCode-Team entwickelt und ist weder mit OpenCode noch mit einem der oben genannten Anbieter verbunden.
