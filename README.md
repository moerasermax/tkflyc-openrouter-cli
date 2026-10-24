# @tkflyc/openrouter-cli

在終端機裡使用 [OpenRouter](https://openrouter.ai) 的命令列工具：互動對話（串流輸出）、讓模型讀你專案檔案的唯讀 agent 模式、單次提問（可接 pipe）、模型搜尋與切換（附價格），以及額度查詢。

- 沒有第三方相依套件，只用 Node.js 內建功能
- 設定 API key 時會先實際向 OpenRouter 驗證，通過才存檔
- 錯誤會顯示 HTTP 狀態與 OpenRouter 的原始訊息，並附上處理建議
- 預設用繁體中文回答

## 安裝

需要 Node.js 22 以上與 git。這個套件沒有發佈到 npm，直接從 GitHub 安裝：

```sh
npm install -g github:moerasermax/tkflyc-openrouter-cli
```

## 開始使用

```sh
openrouter key   # 設定 API key（隱藏輸入，只顯示 *）
openrouter       # 開始互動對話
```

API key 在 <https://openrouter.ai/settings/keys> 建立。也可以改用環境變數 `OPENROUTER_API_KEY`，有設定時會優先於設定檔裡的 key。

## 唯讀 agent 模式（預設開啟）

在專案資料夾裡啟動 `openrouter`，就可以直接說「幫我分析這個專案」。模型會自己列目錄、找檔案、搜尋內容、讀需要的檔案，再回答你；每次讀檔都會在畫面上顯示一行，例如：

```
  ↳ 列出 ./（12 項）
  ↳ 讀取 src/server.cs（第 1–400 行，共 850 行）
```

模型能用的工具只有四個，全部是唯讀的：

| 工具 | 用途 |
|---|---|
| `list_dir` | 列出資料夾內容（可展開 1–4 層） |
| `read_file` | 讀文字檔，可分段讀大檔；自動辨識 UTF-8、UTF-16、Big5、GBK |
| `search` | 搜尋檔案內容（正規表示式或純文字），可用 `*.cs` 這類 glob 過濾 |
| `find_files` | 用檔名或路徑 glob 找檔案 |

安全範圍：

- **唯讀**：沒有寫入、刪除或執行指令的工具，模型就算想改也改不了
- **範圍**：只能讀「啟動 CLI 時所在的資料夾」裡的東西；`../`、絕對路徑、連結（symlink／junction）都出不去
- **拒讀**：`.env`、私鑰（`*.pem`、`*.key`、`id_rsa`…）、`.npmrc` 等敏感檔案，以及 CLI 自己的資料位置（裡面有你的 API key）
- **略過**：`.git`、`node_modules` 等資料夾在搜尋時略過

⚠️ 讀到的檔案內容會送到 OpenRouter 與模型供應商。處理機密或受保密協議約束的專案時，請加 `--no-agent` 或在對話中輸入 `/agent off`。

不是每個模型都支援工具呼叫。`openrouter models` 與 `/model` 清單裡「工具」欄標 ✓ 的模型才能讀檔；不支援的模型會自動退回一般聊天。

## 指令

| 指令 | 說明 |
|---|---|
| `openrouter` / `openrouter chat` | 互動對話。`-m <模型>` 指定模型，`-c` 接續上一段對話，`--session <id>` 接續指定對話，`--no-agent` 關閉讀檔 |
| `openrouter ask "問題"` | 單次提問，同樣會讀檔（`--no-agent` 關閉）。可從 pipe 接內容，例如 `cat app.log \| openrouter ask "摘要錯誤"` |
| `openrouter models [關鍵字...]` | 搜尋模型，顯示 context 長度、每百萬 tokens 價格與是否支援工具。`--free` 只看免費模型，`--refresh` 重新抓清單 |
| `openrouter use [模型或關鍵字]` | 設定預設模型；不帶參數會列出最近用過的模型與價格讓你選 |
| `openrouter credits` | 查帳戶餘額與這把 key 的用量 |
| `openrouter key [--stdin \| --show]` | 設定 API key；`--stdin` 從 pipe 讀入，`--show` 顯示目前 key（遮罩）與用量 |
| `openrouter sessions` | 列出對話紀錄 |
| `openrouter help` | 顯示說明 |

`ask` 的回答輸出到 stdout，讀檔紀錄、token 用量與花費輸出到 stderr，所以導向檔案時只會留下回答本身。

## 對話中的指令

| 指令 | 說明 |
|---|---|
| `/model [關鍵字]` | 列出目前與最近用過的模型與價格，輸入編號切換、輸入關鍵字搜尋；切換後並列新舊模型的價格 |
| `/default` | 把這段對話的模型設成預設模型 |
| `/models <關鍵字>` | 只列出搜尋結果與價格，不切換 |
| `/agent on\|off` | 這段對話開／關唯讀工具 |
| `/system [文字]` | 自訂系統提示（取代預設的「用繁體中文回答」）；不帶文字就恢復預設 |
| `/think on\|off` | 顯示或隱藏模型的思考過程 |
| `/stream on\|off` | 串流輸出開關 |
| `/new` | 開新對話 |
| `/cost` | 這段對話的 token 與花費 |
| `/credits` | 查餘額 |
| `/exit` | 離開（也可以按 Ctrl+D） |

單獨一行輸入 `"""` 開始多行輸入，再一行 `"""` 結束送出。回覆中按 Ctrl+C 只會中斷這次回覆。

讀檔時模型會來回好幾次，每次都會把對話（含讀到的內容）重新送出，所以花費比一般聊天高；每輪結束會顯示這一輪的總 token、花費與工具次數。

## 資料位置

設定（含 API key）、對話紀錄與模型清單快取存在：

- 從 GitHub 安裝：`~/.tkflyc-openrouter/`（Windows 是 `%USERPROFILE%\.tkflyc-openrouter\`）
- 從 git clone 的專案資料夾直接執行：專案內的 `data/`（已列入 `.gitignore`）

設定環境變數 `OPENROUTER_CLI_HOME` 可以改到任何位置。`openrouter help` 會顯示目前實際使用的位置。想讓讀檔功能預設關閉，在該位置的 `config.json` 加上 `"agent": false`。

API key 以明文存在 `config.json`，請不要把這個資料夾分享或放進版控。

## Windows 小提醒

Windows PowerShell 5.1 透過 pipe 傳給外部程式的文字預設不是 UTF-8，中文會變成 `?`。建議改用 PowerShell 7，或先執行：

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new()
```

## 授權

MIT
