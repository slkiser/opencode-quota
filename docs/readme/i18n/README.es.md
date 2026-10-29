<p align="center">
  <a href="https://github.com/slkiser/opencode-quota">
    <picture>
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" alt="Logo de OpenCode Quota">
    </picture>
  </a>
</p>
<p align="center">Cuotas, uso y costos en la TUI y en Desktop de OpenCode.</p>
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
  <a href="https://github.com/slkiser/opencode-quota"><img src="https://shawnkiser.com/opencode-quota/opencode-quota-v6-hero.gif" alt="OpenCode Quota en OpenCode: la barra lateral, las pestañas Usage y Limits de la ventana de cuota y sus ajustes" /></a>
</p>

---

## Instalación

```bash
opencode plugin add @slkiser/opencode-quota
```

Reinicia OpenCode y escribe `/quota`. Se abre una ventana con tus límites. Haz clic en una pestaña (Usage, Limits, Plugin o una de las pestañas de Settings) o presiona `tab` para moverte entre ellas; haz clic o presiona `esc` para cerrarla.

> [!IMPORTANT]
> Necesitas OpenCode `2.0.26+`; los comandos de terminal también necesitan Node.js `22.13+` o `23.4+`.

> [!NOTE]
> ¿Sigues en OpenCode 1? Ejecuta `npx @slkiser/opencode-quota@4 init` en su lugar y consulta el [README de OpenCode 1](https://github.com/slkiser/opencode-quota/blob/release/4.x/README.md).

<details>
<summary>Editar <code>opencode.json</code> a mano</summary>

Agrega el plugin a `opencode.jsonc` o `opencode.json` y conserva tus otros plugins. En `~/.config/opencode` funciona en todos los proyectos; en la carpeta de un proyecto, solo allí. Esta única entrada carga tanto el servidor como la TUI:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

</details>

## Funciones

- **TUI:** `/quota` abre una ventana con las pestañas Usage, Limits, Plugin y Settings. La TUI también tiene un panel Quota en la barra lateral, una línea de estado bajo el cuadro de mensaje y notificaciones toast.
- **Desktop (experimental, OpenCode `2.2.0+`):** el comando **Quota** abre una ventana de uso (Limits, Cost, Tokens). Desktop también tiene una pestaña lateral Quota fijada, una píldora en la barra de título, una franja en la parte inferior, una píldora sobre el cuadro de mensaje, notificaciones toast, el elemento **Quota usage for this session** en el menú de la sesión y una página Quota en los ajustes de OpenCode. La misma entrada del plugin lo carga; desactívalo en **Settings → Extensions → Plugins**.
  <details>
  <summary>Dónde aparece cada ajuste en la TUI y en Desktop</summary>
  <table>
  <tr><th>Grupo de ajustes</th><th>TUI</th><th>Desktop</th></tr>
  <tr><td><code>sidebar</code></td><td>Panel Quota en la barra lateral</td><td>Pestaña lateral Quota</td></tr>
  <tr><td><code>collapsed</code></td><td>Panel de la barra lateral plegado a una línea por proveedor</td><td>Píldora de la barra de título, y la pestaña lateral Quota cuando está plegada</td></tr>
  <tr><td><code>statusLine</code></td><td>Línea bajo el cuadro de mensaje</td><td>Franja en la parte inferior de la ventana, y la píldora sobre el cuadro de mensaje</td></tr>
  <tr><td><code>toast</code></td><td>Toasts con barras</td><td>Toasts con las filas y barras de la pestaña lateral Quota; un aviso de reinicio es una frase</td></tr>
  </table>
  <p><b>Nota:</b> en la TUI, la línea de estado se oculta mientras la barra lateral muestra cuotas, salvo que <b>Next to the sidebar</b> (<code>statusLine.withSidebar</code>) esté activado. En Desktop, la franja también se muestra junto a la pestaña lateral Quota de forma predeterminada; <b>Next to the side panel</b> (<code>statusLine.withSidePanel</code>) lo desactiva.</p>
  </details>
- **Web y Desktop:** `/quota`, `/quota_usage` y `/quota_status` publican su informe en el chat como un mensaje tuyo. La IA nunca lo responde, y el plugin lo filtra de cada solicitud a la IA. Después de desinstalar el plugin, los informes antiguos de chats pasados ya no se filtran. Es posible que la fuente de Web no alinee las columnas.
- **Terminal:** `npx @slkiser/opencode-quota@latest show` funciona incluso con OpenCode cerrado.
- **Scripts y barras de estado:** JSON, un archivo de exportación y métricas. Consulta [Integración externa](../external-integration.md).
- **Hecho para OpenCode 2:** los ajustes se aplican al instante, en cada OpenCode abierto.

## Comandos

| Comando | Qué muestra |
| --- | --- |
| `/quota` | Límites. Web y Desktop: los límites junto al uso de los últimos 7 días |
| `/quota_usage [range]` | Tokens y costo de API: `today` (predeterminado), `24h`, `7d`, `30d`, `90d`, `all`, `session` (con sus subagentes), `between` dos fechas |
| `/quota_status` | Comprobación de la configuración: inicios de sesión, proveedores, precios y avisos |
| `/quota_settings` | Pestañas de ajustes (solo TUI) |

Por ejemplo, `/quota_usage 30d` o `/quota_usage between 2026-09-01 2026-09-25`. En una terminal, con OpenCode abierto o cerrado, `npx @slkiser/opencode-quota@latest show` muestra tu cuota y `npx @slkiser/opencode-quota@latest status` comprueba tu configuración ([en qué se diferencian](../troubleshooting.md#terminal-commands)). Agrega `--help` para ver todas las opciones.

## Ajustes

Cambia la barra lateral, la línea de estado, las notificaciones toast, los colores, los textos y los proveedores en `/quota_settings`. **Save** escribe solo lo que cambiaste en `opencode-quota/settings.jsonc`, dentro de la carpeta de configuración de OpenCode, y conserva tus comentarios. Una edición del archivo llega a cada TUI abierta en pocos segundos. En Desktop, la página Quota de los ajustes de OpenCode guarda en el mismo archivo. Los proveedores personalizados, la ruta de Claude CLI y la ruta de exportación solo se configuran en el archivo. [Ajustes y valores predeterminados](../configuration.md).

## Proveedores

Inicia sesión con `/connect` y el proveedor aparece. Activa o desactiva proveedores en `/quota_settings` → **Providers**.

<table>
<tr>
<td valign="top">

| Estadounidenses | Planes |
| --- | --- |
| [Anthropic (Claude)](../providers.md#anthropic-claude)\* | Personal · Empresa |
| [Cursor](../providers.md#cursor)\* | Personal · Empresa |
| [Gemini CLI](../providers.md#gemini-cli)\* | Empresa |
| GitHub Copilot | Personal · [Empresa](../providers.md#github-copilot)\* |
| [Google AGY](../providers.md#google-agy-quick-setup)\* | Personal · Empresa |
| Ollama Cloud | Personal |
| OpenAI | Personal · Empresa |
| OpenCode Go | Personal |
| OpenCode Zen | Personal · Empresa |
| OpenRouter | Personal · Empresa |
| xAI | Personal · Empresa |

</td>
<td valign="top">

| Chinos | Planes |
| --- | --- |
| [Alibaba Coding Plan](../providers.md#alibaba-coding-plan)\* | Personal |
| [Alibaba Token Plan](../providers.md#alibaba-token-plan)\* | Personal · Empresa |
| DeepSeek | Personal |
| Kimi Code | Personal · Empresa |
| Kimi Code (CN) | Personal · Empresa |
| MiniMax Token Plan | Personal · Empresa |
| MiniMax Token Plan (CN) | Personal · Empresa |
| [Xiaomi MiMo](../providers.md#xiaomi-mimo)\* | Personal |
| Z.ai Coding Plan | Personal |
| Zhipu Coding Plan | Personal · Empresa |

</td>
</tr>
</table>

\* Los nombres con enlace necesitan un paso más; el resto funciona en cuanto inicias sesión. [Qué informa cada uno](../providers.md#pre-configured-providers).

La cuota de ChatGPT de OpenAI necesita iniciar sesión con Codex ([cómo](../providers.md#openai-and-xai)). Gemini CLI solo funciona con cuentas de Gemini Code Assist Standard o Enterprise (organización). Los usuarios personales de Google deben usar Google AGY. Los planes Empresa de los proveedores chinos muestran solo el uso de tu propia clave de API de miembro, excepto Alibaba Token Plan, que muestra una fila Credits por cada puesto del equipo. Las claves de API vienen de OpenCode o de una [variable de entorno](../providers.md#api-keys).

### Proveedores personalizados

Sigue cualquier otro proveedor, desde su API de cuota o con una estimación local. Pídele a tu agente que agregue un proveedor personalizado: se guarda desactivado y tú lo activas en `/quota_settings` → **Providers**. [Prompt para copiar y pegar](../providers.md#custom-providers).

## Actualizar

```bash
opencode plugin update
```

Reinicia OpenCode. ¿Vienes de 4.x o 5.x? Tus ajustes se convierten en el primer inicio, y los antiguos comandos `/tokens_*` siguen funcionando. Consulta [Actualizar](../updating.md).

## Solución de problemas

1. Ejecuta `/quota_status` en una sesión de OpenCode, o `npx @slkiser/opencode-quota@latest status` en una terminal.
2. ¿Falta un proveedor? Vuelve a iniciar sesión en él en OpenCode 2.
3. ¿Usas un plugin complementario (Cursor, Google)? Ponlo **antes** de `@slkiser/opencode-quota` en `opencode.json`.
4. ¿No se encuentra `claude` o `bl`? Consulta [Entorno del servicio](../troubleshooting.md#service-environment).
5. ¿`/quota_usage` está vacío? Inicia OpenCode una vez y luego usa un modelo.
6. ¿No hay interfaz de Quota en Desktop? Necesita OpenCode `2.2.0+` y su interruptor activado en **Settings → Extensions → Plugins**. Web no muestra interfaces de plugins.

Más soluciones: [Solución de problemas](../troubleshooting.md).

## Referencia

Guías: [Configuración](../configuration.md) · [Proveedores](../providers.md) · [Solución de problemas](../troubleshooting.md) · [Integración externa](../external-integration.md) · [Actualizar](../updating.md)

Enlaces externos: [Documentación de OpenCode](https://opencode.ai/docs/) · [Configuración de OpenCode](https://opencode.ai/docs/config/) · [Plugins de OpenCode](https://opencode.ai/docs/plugins/) · [TUI de OpenCode](https://opencode.ai/docs/tui/) · [Datos de precios de models.dev](https://models.dev/) · [Descargas de Node.js](https://nodejs.org/en/download)

## Colaboradores

Gracias a todas las personas que han contribuido a OpenCode Quota.

<a href="https://github.com/slkiser/opencode-quota/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=slkiser/opencode-quota" />
</a>

## Licencia

MIT. OpenCode Quota no lo desarrolla el equipo de OpenCode y no está afiliado a OpenCode ni a ninguno de los proveedores mencionados arriba.
