<p align="center">
  <img src="plugin/logo.svg" width="88" alt="cliproxy-kit">
</p>

<h1 align="center">cliproxy-kit</h1>

<p align="center">
  <b>讓每個 Claude Code session 都跑在對的訂閱帳號上，<br>也看得清楚額度用到哪裡去。</b>
</p>

<p align="center">
  <a href="https://github.com/kuan0808/cliproxy-kit/actions/workflows/ci.yml"><img src="https://github.com/kuan0808/cliproxy-kit/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/kuan0808/cliproxy-kit/releases/latest"><img src="https://img.shields.io/github/v/release/kuan0808/cliproxy-kit?include_prereleases&label=release" alt="最新版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="授權：MIT"></a>
  <img src="https://img.shields.io/badge/status-preview-orange.svg" alt="狀態：預覽版">
</p>

<p align="center">
  <a href="#快速開始">快速開始</a> ·
  <a href="#使用">使用</a> ·
  <a href="#設定">設定</a> ·
  <a href="#疑難排解">疑難排解</a> ·
  <a href="docs/architecture.md">運作原理</a>
  <br>
  <a href="README.md">English</a> · 繁體中文
</p>

<p align="center">
  <img src="docs/images/band.png" alt="Claude Code 輸入框上方的額度列：帳號、5 小時與每週用量、context、快取與所有帳號">
</p>

給透過 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 使用多個訂閱帳號跑 Claude Code 和 Codex 的人：一個 proxy 插件（**quota-pilot**），附帶管理面板裡的用量頁，以及 Claude Code 裡的額度列（**quota-band**）。

- 🧭 **每個 session 分到對的帳號。** 新的 session 分到每週額度最快重置的帳號，快過期的額度先用掉；之後就留在那個帳號，prompt 快取也跟著保留。Codex 的 session 和 review 也一樣。
- 📊 **額度用到哪裡去。** 管理面板裡的頁面，把每個帳號的 5 小時視窗、這一週、近 7 或 30 天，依專案和 session 拆開。
- 🎛️ **在工作的地方看額度。** Claude Code 輸入框上方的額度列，顯示帳號、用量、context 和 prompt 快取，一鍵就能切換。
- 🔀 **供應商之間交接。** Claude 帳號全部用完時，session 可以手動換到 Codex 的模型，也可以設定成自動。

<table>
  <tr>
    <td width="50%"><b>用量</b>：每個帳號這一週，依專案和日期</td>
    <td width="50%"><b>帳本</b>：依分配順序列出每個帳號</td>
  </tr>
  <tr>
    <td><img src="docs/images/zh-TW/usage.png" alt="用量頁"></td>
    <td><img src="docs/images/zh-TW/ledger.png" alt="帳本"></td>
  </tr>
</table>

> [!NOTE]
> **預覽版。** 1.0 之前，設定和資料檔都可能變動。支援 Claude 和 Codex 帳號；其他供應商照常由 CLIProxyAPI 自己分配。

## 快速開始

需要 macOS 或 Linux 上的 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 8.0.14 以上，並已登入你的帳號；以及 [Claude Code](https://code.claude.com) 2.1.287 以上。

**1. 安裝 quota-pilot。** 在 CLIProxyAPI 的 `config.yaml` 開啟插件，並加入這個商店：

```yaml
plugins:
  enabled: true
  store-sources:
    - "https://raw.githubusercontent.com/kuan0808/cliproxy-kit/main/registry.json"
```

接著在管理面板的**插件商店**安裝 **Quota Pilot**，重新整理面板：它的頁面在**插件**底下。

<details>
<summary>手動安裝，或從原始碼安裝</summary>

- **手動：** 從 [release](https://github.com/kuan0808/cliproxy-kit/releases/latest) 下載你的系統的 zip（Apple 晶片選 `darwin_arm64`，大多數伺服器選 `linux_amd64`），把裡面的程式庫放進 CLIProxyAPI 的插件資料夾（`plugins.dir`），設定 `plugins.configs.quota-pilot.enabled: true`，再重新啟動 CLIProxyAPI。
- **從原始碼**（需要 Go 1.26、Bun 和 C 編譯器）：`scripts/install-plugin.sh` 會建置、測試並安裝，由 Homebrew 或 systemd 執行的 proxy 會自動重新啟動，最後確認 proxy 跑的就是這個版本。其他執行方式請指定位置和重啟方式：`CPA_PLUGINS_DIR=/path/to/plugins CPA_RESTART_CMD="docker restart cliproxyapi" scripts/install-plugin.sh`。

</details>

**2. 連接 Claude Code。** 在你執行 Claude Code 的機器上：

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/kuan0808/cliproxy-kit/main/scripts/connect-claude-code.sh)
```

它會詢問一把 proxy 的 client key，確認 proxy 接受它，讓 Claude Code 改走 proxy，並安裝額度列。開一個新的 session，額度列就會出現在輸入框上方。

<details>
<summary>它改了什麼（要手動設定時）</summary>

在 `~/.claude/settings.json`（舊檔會保留在旁邊，名為 `settings.json.bak-<時間>`）的 `env` 底下：

```json
"ANTHROPIC_BASE_URL": "http://127.0.0.1:8317",
"ANTHROPIC_AUTH_TOKEN": "<proxy 的一把 client key>",
"CLAUDE_CODE_PROMPT_CACHE_TTL": "1h",
"ENABLE_TOOL_SEARCH": "true",
"ENABLE_CLAUDEAI_MCP_SERVERS": "false"
```

1 小時的快取讓長 session 比較省；tool search 讓經過 proxy 的 prompt 保持精簡；claude.ai 的連接器無法經過 proxy 使用。接著：

```sh
claude plugin marketplace add kuan0808/cliproxy-kit
claude plugin install quota-band@cliproxy-kit
```

</details>

**3. 讓 Codex 經過 proxy**（選用）。quota-pilot 只看得到經過 proxy 的請求：照 CLIProxyAPI 的[Codex 指南](https://help.router-for.me/agent-client/codex)設定 Codex。

<details>
<summary><code>~/.codex/config.toml</code></summary>

```toml
model_provider = "cliproxyapi"

[model_providers.cliproxyapi]
name = "OpenAI"
base_url = "http://127.0.0.1:8317/v1"
model_catalog_url = "http://127.0.0.1:8317/v1/models"   # Codex 0.156 起需要
experimental_bearer_token = "<proxy 的一把 client key>"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = true

[features]
api_key_model_discovery = true   # Codex 0.156 起需要
```

少了這兩行，Codex 0.156 以上讀不到模型的資料，請求會大很多。

</details>

### 其他機器與 Docker

其他機器上的 Claude Code 可以透過加密的位址使用同一個 proxy，例如[Tailscale Serve](https://tailscale.com/kb/1312/serve) 提供的位址。先把那台要用的 key 加進 `band_tokens`，再到那台執行同一行指令，加上 proxy 的位址：

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/kuan0808/cliproxy-kit/main/scripts/connect-claude-code.sh) https://proxy.example.ts.net:8317
```

- 那台的 session，以及那台經過 proxy 的 Codex session，都會在用量頁標示為其他裝置。
- 切換 session 的帳號，只在執行 proxy 的那台機器上提供。
- proxy 跑在 Docker 裡時也一樣：額度列用的 key 要加進 `band_tokens`。沒有經過反向代理、直接連到容器的請求，不會標示為其他裝置。
- 其他機器上的 `http://` 位址會被腳本拒絕；網路本身已經加密時（例如 VPN），可以設定 `ALLOW_HTTP=1`。

## 使用

### 在 Claude Code 裡

額度列在 Claude 等待時顯示方塊，工作時縮成一行。

| 按鈕 | 作用 |
| --- | --- |
| `switch` | 把這個 session 換到另一個帳號，或另一個供應商的模型，也能換回來。 |
| `quota` | 所有帳號的各個額度週期；輸入 `/quota` 也一樣。 |
| `more` / `less` | 在換輪之前固定顯示方塊或一行。 |
| `compact`、`handoff` | prompt 快取快過期或即將換帳號時出現，避免下一輪重寫一大段對話的快取。 |

### 在管理面板裡

打開**插件**底下的 **quota-pilot**。登入面板時勾選了「記住密碼」，頁面就直接沿用；否則每個分頁會詢問一次 management key。

- **帳本：** 依新 session 分配順序列出每個帳號、各額度週期，以及限制它的原因。
- **用量：** 每個帳號的 5 小時視窗、這一週，或近 7、30 天，依專案和 session 拆開，附上 token 和快取命中率。日期依你的時區劃分。
- **重新整理：** 立刻讀取每個帳號的額度，讀不到的帳號會列出來並說明原因。

![某個帳號這一週背後的專案和 session，依裝置和執行方式加上標籤](docs/images/zh-TW/projects.png)

### 值得知道

- **額度提前重新計算時**（例如變更方案），從那一刻重新計算；之前的用量仍在近 7、30 天的檢視裡。
- **歷史資料：** 安裝 quota-pilot 之前的日子沒有額度讀數。在 proxy 那台執行一次 `python3 scripts/usage-backfill.py`，可以從 Claude Code 的對話記錄補回這些日子的 token 數。
- **Fast 模式：** Codex 的 Fast（`service_tier = "fast"`）以 2.5 倍速度消耗方案額度，也照這個比例計算。Claude Code 的 `/fast` 計入用量點數，不計入方案額度，所以不算進帳號的額度；經過 proxy 時，要設定 `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1`，Claude Code 才會提供 `/fast`。
- **多個 Codex 帳號**會像 Claude 帳號一樣分配 session；改用另一個供應商只適用於 Claude Code 的 session。

## 設定

在面板的**插件管理**頁面，或 `config.yaml` 的 `plugins.configs.quota-pilot` 底下：

| 設定 | 預設 | 作用 |
| --- | --- | --- |
| `min_five_hour_left_percent` | `25` | 新的 session 不會分到 5 小時額度剩不到這個百分比的帳號，除非它 30 分鐘內就重置。 |
| `cross_provider` | `off` | `auto`：某個供應商的帳號全部用完時，自動把 Claude Code 的 session 改送到 `fallback_map` 的模型；`off`：交給 `switch` 手動切換。 |
| `fallback_map` | 無 | 各供應商改用的模型，寫成 `供應商: 供應商:模型`，例如 `claude: codex:gpt-6.1-sol`。 |
| `idle_poll_minutes` | `10` | 多久讀一次閒置帳號的額度。 |
| `context_lengths` | 內建表 | 各模型的 context 大小，用來判斷對話放不放得進另一個模型。 |
| `band_tokens` | 無 | 允許其他機器上的額度列讀取額度的 client key。 |

## 更新與移除

- **更新：** 面板的插件商店會提供 quota-pilot 的新版本；額度列用 `claude plugin update quota-band@cliproxy-kit` 更新。
- **移除：** 在面板的**插件**頁面刪除 Quota Pilot，執行 `claude plugin uninstall quota-band@cliproxy-kit`，再把 `~/.claude/settings.json.bak-<時間>` 放回去（或刪掉上面那幾個 `env` 設定）。記錄和狀態放在 `~/.cache/cliproxy-kit/`。

## 疑難排解

| 你看到 | 這樣處理 |
| --- | --- |
| 從商店安裝失敗 | 面板只等 30 秒，從 GitHub 下載 2 MB 太慢就會失敗：改用手動安裝（步驟 1）。 |
| 插件底下沒有 quota-pilot | 重新整理面板，並確認 `plugins.enabled: true`。 |
| 額度列說 proxy 拒絕了這把 key | 把 Claude Code 用的 key 加進 `band_tokens`。 |
| 額度列說額度資料太舊 | proxy 或裡面的插件停了：重新啟動 CLIProxyAPI。 |
| 用量頁看不到 Codex 的 session | Codex 還沒經過 proxy（步驟 3）。 |
| Codex 帳號沒有 5 小時視窗 | 它的方案本來就沒有；頁面和額度列都會標明。 |

## 隱私與安全

- **單一擁有者。** proxy 的每一把 client key 都視為可信：client 可以用請求替 session 命名，列在 `band_tokens` 的 key 能讀到所有帳號的額度。只把 key 給你願意讓他看到用量的人。
- **留在本機。** 所有資料都放在執行 proxy 那台機器的 `~/.cache/cliproxy-kit/`（權限 0600）。除了轉送的請求，插件只會用帳號既有的 token 呼叫供應商自己的用量和帳號資料端點。
- **對話記錄。** 為了替 session 命名，它會讀那台機器上 Claude Code 的對話記錄，所以 proxy 應該用和 Claude Code 相同的使用者執行。
- **都在金鑰後面。** 頁面本身不含任何資料，一切都經過 management 路由讀取，需要 management key。額度列走網路時需要 `band_tokens` 裡的 key，而且不含 email 或路徑。

## 開發

```sh
cd plugin && go test ./...                                   # 插件
cd ui && bun install && bun run verify                       # 頁面：測試、lint、型別、建置
cd mod && claude plugin test . && claude plugin validate .   # 額度列
```

`scripts/install-plugin.sh` 會安裝本機建置的版本。`git config core.hooksPath scripts/git-hooks` 會開啟 commit 前的憑證檢查（需要 PyYAML；讀 Codex 的設定需要 Python 3.11 以上）。打上 `v<版本>` tag 會發布商店安裝用的 release，版本必須和 `mod/.claude-plugin/plugin.json` 一致。各部分怎麼決定、存了什麼：[docs/architecture.md](docs/architecture.md)。

## 授權

[MIT](LICENSE)。頁面沿用了 CLIProxyAPI 管理面板的樣式和元件，依其 MIT 授權使用（[ui/LICENSE.panel](ui/LICENSE.panel)）。

與 Anthropic、OpenAI 或 CLIProxyAPI 專案無關。透過 proxy 使用訂閱帳號可能違反供應商的條款；使用前請先確認，並自行承擔風險。
