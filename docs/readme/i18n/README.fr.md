<p align="center">
  <a href="https://github.com/slkiser/opencode-quota">
    <picture>
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" alt="Logo d'OpenCode Quota">
    </picture>
  </a>
</p>
<p align="center">Quotas, consommation et coûts dans la TUI et Desktop d'OpenCode.</p>
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
  <a href="https://github.com/slkiser/opencode-quota"><img src="https://shawnkiser.com/opencode-quota/opencode-quota-v6-hero.gif" alt="OpenCode Quota dans OpenCode : la barre latérale, les onglets Usage et Limits de la fenêtre de quota, et ses paramètres" /></a>
</p>

---

## Installation

```bash
opencode plugin add @slkiser/opencode-quota
```

Redémarrez OpenCode et tapez `/quota`. Une fenêtre s'ouvre avec vos limites. Cliquez sur un onglet (Usage, Limits, Plugin ou l'un des onglets Settings) ou appuyez sur `tab` pour passer de l'un à l'autre ; cliquez ou appuyez sur `esc` pour la fermer.

> [!IMPORTANT]
> Il vous faut OpenCode `2.0.26+` ; les commandes du terminal nécessitent aussi Node.js `22.13+` ou `23.4+`.

> [!NOTE]
> Encore sur OpenCode 1 ? Lancez plutôt `npx @slkiser/opencode-quota@4 init`, et consultez le [README d'OpenCode 1](https://github.com/slkiser/opencode-quota/blob/release/4.x/README.md).

<details>
<summary>Modifier <code>opencode.json</code> vous-même</summary>

Ajoutez le plugin à `opencode.jsonc` ou `opencode.json`, en gardant vos autres plugins. Dans `~/.config/opencode`, il fonctionne dans tous les projets ; dans le dossier d'un projet, seulement dans celui-ci. Cette seule entrée charge à la fois le serveur et la TUI :

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

</details>

## Fonctionnalités

- **TUI :** `/quota` ouvre une fenêtre avec les onglets Usage, Limits, Plugin et Settings. La TUI reçoit aussi un panneau Quota dans la barre latérale, une ligne d'état sous la zone de saisie et des toasts.
- **Desktop (expérimental, OpenCode `2.2.0+`) :** la commande **Quota** ouvre une fenêtre d'utilisation (Limits, Cost, Tokens). Desktop reçoit aussi un onglet latéral Quota épinglé, une pastille dans la barre de titre, une bande en bas de la fenêtre, une pastille au-dessus de la zone de saisie, des toasts, l'élément **Quota usage for this session** dans le menu de la session et une page Quota dans les paramètres d'OpenCode. La même entrée de plugin la charge ; désactivez-la dans **Settings → Extensions → Plugins**.
  <details>
  <summary>Où chaque paramètre s'affiche dans la TUI et dans Desktop</summary>
  <table>
  <tr><th>Groupe de paramètres</th><th>TUI</th><th>Desktop</th></tr>
  <tr><td><code>sidebar</code></td><td>Panneau Quota dans la barre latérale</td><td>Onglet latéral Quota</td></tr>
  <tr><td><code>collapsed</code></td><td>Panneau de la barre latérale replié sur une ligne par fournisseur</td><td>Pastille de la barre de titre, et l'onglet latéral Quota quand il est replié</td></tr>
  <tr><td><code>statusLine</code></td><td>Ligne sous la zone de saisie</td><td>Bande en bas de la fenêtre, et la pastille au-dessus de la zone de saisie</td></tr>
  <tr><td><code>toast</code></td><td>Toasts avec des barres</td><td>Toasts avec les lignes et barres de l'onglet latéral Quota ; un avis de réinitialisation est une phrase</td></tr>
  </table>
  <p><b>Remarque :</b> dans la TUI, la ligne d'état se masque tant que la barre latérale affiche des quotas, sauf si <b>Next to the sidebar</b> (<code>statusLine.withSidebar</code>) est activé. Dans Desktop, la bande s'affiche aussi à côté de l'onglet latéral Quota par défaut ; <b>Next to the side panel</b> (<code>statusLine.withSidePanel</code>) la désactive.</p>
  </details>
- **Web et Desktop :** `/quota`, `/quota_usage` et `/quota_status` publient leur rapport dans le chat sous forme de message de votre part. L'IA n'y répond jamais, et le plugin le retire de chaque requête envoyée à l'IA. Une fois le plugin désinstallé, les anciens rapports des chats passés ne sont plus filtrés. La police du Web n'aligne pas toujours les colonnes.
- **Terminal :** `npx @slkiser/opencode-quota@latest show` fonctionne même quand OpenCode est fermé.
- **Scripts et barres d'état :** JSON, un fichier d'export et des métriques. Voir [Intégration externe](../external-integration.md).
- **Conçu pour OpenCode 2 :** les paramètres s'appliquent en direct, dans chaque OpenCode ouvert.

## Commandes

| Commande | Ce qu'elle affiche |
| --- | --- |
| `/quota` | Limites. Web et Desktop : les limites à côté de la consommation des 7 derniers jours |
| `/quota_usage [range]` | Tokens et coût API : `today` (par défaut), `24h`, `7d`, `30d`, `90d`, `all`, `session` (avec ses sous-agents), `between` deux dates |
| `/quota_status` | Vérification de la configuration : connexions, fournisseurs, tarifs et avis |
| `/quota_settings` | Onglets de paramètres (TUI uniquement) |

Par exemple `/quota_usage 30d` ou `/quota_usage between 2026-09-01 2026-09-25`. Dans un terminal, qu'OpenCode soit ouvert ou fermé, `npx @slkiser/opencode-quota@latest show` affiche votre quota et `npx @slkiser/opencode-quota@latest status` vérifie votre configuration ([ce qui les distingue](../troubleshooting.md#terminal-commands)). Ajoutez `--help` pour voir toutes les options.

## Paramètres

Modifiez la barre latérale, la ligne d'état, les toasts, les couleurs, les formulations et les fournisseurs dans `/quota_settings`. **Save** n'écrit que ce que vous avez modifié dans `opencode-quota/settings.jsonc`, dans le dossier de configuration d'OpenCode, et conserve vos commentaires. Une modification du fichier atteint chaque TUI ouverte en quelques secondes. Dans Desktop, la page Quota des paramètres d'OpenCode enregistre dans le même fichier. Les fournisseurs personnalisés, le chemin du Claude CLI et le chemin d'export se définissent uniquement dans le fichier. [Paramètres et valeurs par défaut](../configuration.md).

## Fournisseurs

Connectez-vous avec `/connect` et le fournisseur apparaît. Activez ou désactivez les fournisseurs dans `/quota_settings` → **Providers**.

<table>
<tr>
<td valign="top">

| Américains | Offres |
| --- | --- |
| [Anthropic (Claude)](../providers.md#anthropic-claude)\* | Particulier · Entreprise |
| [Cursor](../providers.md#cursor)\* | Particulier · Entreprise |
| [Gemini CLI](../providers.md#gemini-cli)\* | Entreprise |
| GitHub Copilot | Particulier · [Entreprise](../providers.md#github-copilot)\* |
| [Google AGY](../providers.md#google-agy-quick-setup)\* | Particulier · Entreprise |
| Ollama Cloud | Particulier |
| OpenAI | Particulier · Entreprise |
| OpenCode Go | Particulier |
| OpenCode Zen | Particulier · Entreprise |
| OpenRouter | Particulier · Entreprise |
| xAI | Particulier · Entreprise |

</td>
<td valign="top">

| Chinois | Offres |
| --- | --- |
| [Alibaba Coding Plan](../providers.md#alibaba-coding-plan)\* | Particulier |
| [Alibaba Token Plan](../providers.md#alibaba-token-plan)\* | Particulier · Entreprise |
| DeepSeek | Particulier |
| Kimi Code | Particulier · Entreprise |
| Kimi Code (CN) | Particulier · Entreprise |
| MiniMax Token Plan | Particulier · Entreprise |
| MiniMax Token Plan (CN) | Particulier · Entreprise |
| [Xiaomi MiMo](../providers.md#xiaomi-mimo)\* | Particulier |
| Z.ai Coding Plan | Particulier |
| Zhipu Coding Plan | Particulier · Entreprise |

</td>
</tr>
</table>

\* Les noms avec un lien demandent une étape de plus ; les autres fonctionnent dès que vous êtes connecté. [Ce que chacun remonte](../providers.md#pre-configured-providers).

Le quota ChatGPT d'OpenAI nécessite une connexion Codex ([comment faire](../providers.md#openai-and-xai)). Gemini CLI ne fonctionne qu'avec les comptes Gemini Code Assist Standard ou Enterprise (organisation). Les utilisateurs Google particuliers doivent utiliser Google AGY. Les offres Entreprise des fournisseurs chinois n'affichent que la consommation de votre propre clé d'API de membre, sauf Alibaba Token Plan, qui affiche une ligne Credits par siège d'équipe. Les clés d'API proviennent d'OpenCode ou d'une [variable d'environnement](../providers.md#api-keys).

### Fournisseurs personnalisés

Suivez n'importe quel autre fournisseur, à partir de son API de quota ou d'une estimation locale. Demandez à votre agent d'ajouter un fournisseur personnalisé : il est enregistré désactivé, et vous l'activez dans `/quota_settings` → **Providers**. [Prompt à copier-coller](../providers.md#custom-providers).

## Mise à jour

```bash
opencode plugin update
```

Redémarrez OpenCode. Vous venez de la 4.x ou de la 5.x ? Vos paramètres sont convertis au premier démarrage, et les anciennes commandes `/tokens_*` fonctionnent toujours. Voir [Mise à jour](../updating.md).

## Dépannage

1. Lancez `/quota_status` dans une session OpenCode, ou `npx @slkiser/opencode-quota@latest status` dans un terminal.
2. Un fournisseur manque ? Reconnectez-vous à ce fournisseur dans OpenCode 2.
3. Vous utilisez un plugin compagnon (Cursor, Google) ? Placez-le **avant** `@slkiser/opencode-quota` dans `opencode.json`.
4. `claude` ou `bl` introuvable ? Voir [Environnement du service](../troubleshooting.md#service-environment).
5. `/quota_usage` est vide ? Lancez OpenCode une fois, puis utilisez un modèle.
6. Pas d'interface Quota dans Desktop ? Elle demande OpenCode `2.2.0+` et son interrupteur activé dans **Settings → Extensions → Plugins**. Le Web n'affiche aucune interface de plugin.

D'autres solutions : [Dépannage](../troubleshooting.md).

## Références

Guides : [Configuration](../configuration.md) · [Fournisseurs](../providers.md) · [Dépannage](../troubleshooting.md) · [Intégration externe](../external-integration.md) · [Mise à jour](../updating.md)

Liens externes : [Documentation OpenCode](https://opencode.ai/docs/) · [Configuration OpenCode](https://opencode.ai/docs/config/) · [Plugins OpenCode](https://opencode.ai/docs/plugins/) · [TUI OpenCode](https://opencode.ai/docs/tui/) · [Données de tarifs models.dev](https://models.dev/) · [Téléchargements Node.js](https://nodejs.org/en/download)

## Contributeurs

Merci à toutes les personnes qui ont contribué à OpenCode Quota.

<a href="https://github.com/slkiser/opencode-quota/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=slkiser/opencode-quota" />
</a>

## Licence

MIT. OpenCode Quota n'est pas développé par l'équipe d'OpenCode et n'est affilié ni à OpenCode ni à aucun des fournisseurs listés ci-dessus.
