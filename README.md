<p align="center">
  <img src="plugin/logo.svg" width="88" alt="cliproxy-kit">
</p>

<h1 align="center">cliproxy-kit</h1>

<p align="center">
  <b>Every Claude Code session on the right subscription account,<br>and a clear view of where the quota went.</b>
</p>

<p align="center">
  <a href="https://github.com/kuan0808/cliproxy-kit/actions/workflows/ci.yml"><img src="https://github.com/kuan0808/cliproxy-kit/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/kuan0808/cliproxy-kit/releases/latest"><img src="https://img.shields.io/github/v/release/kuan0808/cliproxy-kit?include_prereleases&label=release" alt="latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT"></a>
  <img src="https://img.shields.io/badge/status-preview-orange.svg" alt="status: preview">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#use">Use</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="docs/architecture.md">How it works</a>
  <br>
  English · <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <img src="docs/images/band.png" alt="The quota band above the Claude Code prompt: account, 5-hour and weekly use, context, cache and every account">
</p>

For people who run Claude Code and Codex on several subscription accounts through
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI): a proxy plugin (**quota-pilot**) with a
page in the management panel, and a band in Claude Code (**quota-band**).

- 🧭 **The right account for each session.** A new session gets the account whose weekly quota resets
  soonest, so quota that would expire unused goes first; then it stays there and keeps its prompt
  cache. Codex sessions and reviews too.
- 📊 **Where the quota went.** A page in the management panel splits each account's 5-hour window,
  week, or last 7 or 30 days by project and session.
- 🎛️ **The quota where you work.** A band above the Claude Code prompt shows the account, its use,
  the context and the prompt cache, with one-press switching.
- 🔀 **A handover between providers.** When every Claude account is used up, a session moves to a
  Codex model by hand, or by itself if you turn that on.

<table>
  <tr>
    <td width="50%"><b>Usage</b>: each account's week, by project and day</td>
    <td width="50%"><b>Ledger</b>: every account in routing order</td>
  </tr>
  <tr>
    <td><img src="docs/images/usage.png" alt="The usage page"></td>
    <td><img src="docs/images/ledger.png" alt="The ledger"></td>
  </tr>
</table>

> [!NOTE]
> **Preview.** Settings and data files may change before 1.0. Claude and Codex accounts are
> supported; other providers keep CLIProxyAPI's own routing.

## Quick start

You need [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 8.0.14+ on macOS or Linux with
your accounts logged in, and [Claude Code](https://code.claude.com) 2.1.287+.

**1. Install quota-pilot.** Turn plugins on and add this store in CLIProxyAPI's `config.yaml`:

```yaml
plugins:
  enabled: true
  store-sources:
    - "https://raw.githubusercontent.com/kuan0808/cliproxy-kit/main/registry.json"
```

Then open the management panel's **Plugin Store**, install **Quota Pilot** and refresh the panel:
its page is under **Plugins**.

<details>
<summary>Install by hand, or from source</summary>

- **By hand:** put the library from the [release](https://github.com/kuan0808/cliproxy-kit/releases/latest)
  zip for your system (`darwin_arm64` for Apple silicon, `linux_amd64` for most servers) in
  CLIProxyAPI's plugin folder (`plugins.dir`), set `plugins.configs.quota-pilot.enabled: true` and
  restart CLIProxyAPI.
- **From source** (Go 1.26, Bun, a C compiler): `scripts/install-plugin.sh` builds, tests and installs
  it, restarts the proxy when Homebrew or systemd runs it, and checks the proxy runs this build. For
  another setup, say where and how:
  `CPA_PLUGINS_DIR=/path/to/plugins CPA_RESTART_CMD="docker restart cliproxyapi" scripts/install-plugin.sh`.

</details>

**2. Connect Claude Code.** On the machine where you run it:

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/kuan0808/cliproxy-kit/main/scripts/connect-claude-code.sh)
```

It asks for one of the proxy's client keys, checks the proxy accepts it, points Claude Code at the
proxy and installs the band. Start a new session: the band shows above the prompt.

<details>
<summary>What it changes, to do it by hand</summary>

In `~/.claude/settings.json` (the old file is kept beside it as `settings.json.bak-<time>`), under
`env`:

```json
"ANTHROPIC_BASE_URL": "http://127.0.0.1:8317",
"ANTHROPIC_AUTH_TOKEN": "<a client key of the proxy>",
"CLAUDE_CODE_PROMPT_CACHE_TTL": "1h",
"ENABLE_TOOL_SEARCH": "true",
"ENABLE_CLAUDEAI_MCP_SERVERS": "false"
```

A 1-hour cache keeps long sessions cheap, tool search keeps the prompt small through a proxy, and
claude.ai connectors do not work through one. Then:

```sh
claude plugin marketplace add kuan0808/cliproxy-kit
claude plugin install quota-band@cliproxy-kit
```

</details>

**3. Send Codex through the proxy** (optional). quota-pilot sees only what goes through the proxy:
set Codex up as CLIProxyAPI's [Codex guide](https://help.router-for.me/agent-client/codex) describes.

<details>
<summary><code>~/.codex/config.toml</code></summary>

```toml
model_provider = "cliproxyapi"

[model_providers.cliproxyapi]
name = "OpenAI"
base_url = "http://127.0.0.1:8317/v1"
model_catalog_url = "http://127.0.0.1:8317/v1/models"   # needed from Codex 0.156
experimental_bearer_token = "<a client key of the proxy>"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = true

[features]
api_key_model_discovery = true   # needed from Codex 0.156
```

Without the two lines Codex 0.156 and later cannot read the models' details, and send far larger
requests.

</details>

### Other machines and Docker

Claude Code elsewhere can use the same proxy over an encrypted address, such as one from
[Tailscale Serve](https://tailscale.com/kb/1312/serve). Add the key it uses to `band_tokens`, then run
the same command there with the proxy's address:

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/kuan0808/cliproxy-kit/main/scripts/connect-claude-code.sh) https://proxy.example.ts.net:8317
```

- Its sessions, and Codex sessions there, show in the usage page marked as from another device.
- Switching a session's account is offered only on the machine that runs the proxy.
- A proxy in Docker works the same way: its band key goes in `band_tokens`. Requests that reach the
  container directly, with no reverse proxy in front, are not marked as from another device.
- The script refuses a plain `http://` address on another machine; set `ALLOW_HTTP=1` when the
  network already encrypts it (a VPN).

## Use

### In Claude Code

The band shows tiles while Claude waits and one line while it works.

| Control | What it does |
| --- | --- |
| `switch` | Moves this session to another account, or to another provider's model and back. |
| `quota` | Every account's windows; `/quota` opens the same. |
| `more` / `less` | Tiles or one line, until the turn changes. |
| `compact`, `handoff` | Offered when the prompt cache is about to expire or a switch is coming, so the next turn does not rewrite a long conversation. |

### In the management panel

Open **quota-pilot** under **Plugins**. The page uses the panel's login when "remember password" is
ticked, else it asks for the management key once per tab.

- **Ledger:** every account in the order new sessions get them, each window, and what limits it.
- **Usage:** each account's 5-hour window, week, or 7 or 30 days, by project and session, with tokens
  and the cache hit rate. Days follow your time zone.
- **Refresh:** reads every account's quota now, and names any it could not read and why.

![Projects and sessions behind an account's week, tagged by device and by what ran them](docs/images/projects.png)

### Good to know

- **A window that starts over** before its reset, as after a plan change, counts from then; the use
  before stays in the 7- and 30-day views.
- **History:** days before quota-pilot ran have no quota readings. `python3 scripts/usage-backfill.py`,
  run once on the proxy's machine, recovers their token counts from Claude Code's transcripts.
- **Fast modes:** Codex's Fast (`service_tier = "fast"`) uses included limits 2.5 times as fast, and
  counts so. Claude Code's `/fast` is billed to usage credits, not plan limits, so it counts for
  nothing; through a proxy Claude Code offers it only with `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1`.
- **Several Codex accounts** take sessions the way Claude accounts do; moving to another provider is
  for Claude Code sessions only.

## Configuration

On the panel's **Plugins** page, or under `plugins.configs.quota-pilot` in `config.yaml`:

| Key | Default | What it does |
| --- | --- | --- |
| `min_five_hour_left_percent` | `25` | A new session is not given an account with less of its 5-hour window left, unless that window resets within 30 minutes. |
| `cross_provider` | `off` | `auto` moves Claude Code sessions to the `fallback_map` model when every account of their provider is used up; `off` leaves that to `switch`. |
| `fallback_map` | none | The model each provider moves to, as `provider: provider:model`, for example `claude: codex:gpt-6.1-sol`. |
| `idle_poll_minutes` | `10` | How often idle accounts' quota is read. |
| `context_lengths` | built in | Context window per model, to tell whether a conversation fits another model. |
| `band_tokens` | none | Client keys with which a band on another machine may read the quota. |

## Update and uninstall

- **Update:** the panel's Plugin Store offers new versions of quota-pilot;
  `claude plugin update quota-band@cliproxy-kit` updates the band.
- **Uninstall:** delete Quota Pilot on the panel's **Plugins** page, run
  `claude plugin uninstall quota-band@cliproxy-kit`, and put back `~/.claude/settings.json.bak-<time>`
  (or remove the `env` keys above). The log and state live in `~/.cache/cliproxy-kit/`.

## Troubleshooting

| You see | Do this |
| --- | --- |
| The store install fails | The panel waits 30 seconds for the 2 MB download from GitHub: install by hand (step 1). |
| No quota-pilot page under Plugins | Refresh the panel, and check `plugins.enabled: true`. |
| The band says the proxy refused this key | Add the key Claude Code uses to `band_tokens`. |
| The band says quota data is old | The proxy, or the plugin in it, stopped: restart CLIProxyAPI. |
| Codex sessions are missing from the page | Codex does not use the proxy yet (step 3). |
| A Codex account has no 5-hour window | Its plan has none; the page and the band say so. |

## Privacy and security

- **One owner.** Every client key of the proxy is trusted: a client can name sessions with its
  requests, and a key in `band_tokens` reads every account's quota. Give keys only to people you
  would show your usage to.
- **Local.** Everything stays in `~/.cache/cliproxy-kit/` (mode 0600) on the machine that runs the
  proxy. Besides the requests it routes, the plugin calls only the providers' own usage and profile
  endpoints, with the accounts' existing tokens.
- **Transcripts.** To name sessions it reads Claude Code's transcripts there, so the proxy should run
  as the same user as Claude Code.
- **Behind keys.** The page carries no data: it reads everything through management routes, behind
  the management key. The band's network route needs a `band_tokens` key and carries no emails or
  paths.

## Develop

```sh
cd plugin && go test ./...                                   # the plugin
cd ui && bun install && bun run verify                       # the page: tests, lint, types, build
cd mod && claude plugin test . && claude plugin validate .   # the band
```

`scripts/install-plugin.sh` installs a local build. `git config core.hooksPath scripts/git-hooks`
turns on a pre-commit check for credentials (PyYAML; Python 3.11+ to read Codex's config). A
`v<version>` tag publishes the release the store installs, and must match
`mod/.claude-plugin/plugin.json`. How the parts decide and what they store:
[docs/architecture.md](docs/architecture.md).

## License

[MIT](LICENSE). The page reuses styles and components of the CLIProxyAPI management panel, under its
MIT licence ([ui/LICENSE.panel](ui/LICENSE.panel)).

Not affiliated with Anthropic, OpenAI or the CLIProxyAPI project. Using subscription accounts through
a proxy may conflict with a provider's terms; check them first, and use this at your own risk.
