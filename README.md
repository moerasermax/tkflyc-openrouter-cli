# @tkflyc/openrouter-cli

在終端機裡使用 [OpenRouter](https://openrouter.ai) 的命令列工具：互動對話（串流輸出）、單次提問（可接 pipe）、模型搜尋與切換（附價格），以及額度查詢。

- 沒有第三方相依套件，只用 Node.js 內建功能
- 設定 API key 時會先實際向 OpenRouter 驗證，通過才存檔
- 錯誤會顯示 HTTP 狀態與 OpenRouter 的原始訊息，並附上處理建議

## 安裝

需要 Node.js 22 以上。

```sh
npm install -g @tkflyc/openrouter-cli
```

## 開始使用

```sh
openrouter key   # 設定 API key（隱藏輸入，只顯示 *）
openrouter       # 開始互動對話
```

API key 在 <https://openrouter.ai/settings/keys> 建立。也可以改用環境變數 `OPENROUTER_API_KEY`，有設定時會優先於設定檔裡的 key。

## 指令

| 指令 | 說明 |
|---|---|
| `openrouter` / `openrouter chat` | 互動對話。`-m <模型>` 指定模型，`-c` 接續上一段對話，`--session <id>` 接續指定對話 |
| `openrouter ask "問題"` | 單次提問。可從 pipe 接內容，例如 `cat app.log \| openrouter ask "摘要錯誤"` |
| `openrouter models [關鍵字...]` | 搜尋模型，顯示 context 長度與每百萬 tokens 價格。`--free` 只看免費模型，`--refresh` 重新抓清單 |
| `openrouter use [模型或關鍵字]` | 設定預設模型；不帶參數會列出最近用過的模型與價格讓你選 |
| `openrouter credits` | 查帳戶餘額與這把 key 的用量 |
| `openrouter key [--stdin \| --show]` | 設定 API key；`--stdin` 從 pipe 讀入，`--show` 顯示目前 key（遮罩）與用量 |
| `openrouter sessions` | 列出對話紀錄 |
| `openrouter help` | 顯示說明 |

`ask` 的回答輸出到 stdout，token 用量與花費輸出到 stderr，所以導向檔案時只會留下回答本身。

## 對話中的指令

| 指令 | 說明 |
|---|---|
| `/model [關鍵字]` | 列出目前與最近用過的模型與價格，輸入編號切換、輸入關鍵字搜尋；切換後並列新舊模型的價格 |
| `/default` | 把這段對話的模型設成預設模型 |
| `/models <關鍵字>` | 只列出搜尋結果與價格，不切換 |
| `/system [文字]` | 設定系統提示；不帶文字就清除 |
| `/think on\|off` | 顯示或隱藏模型的思考過程 |
| `/stream on\|off` | 串流輸出開關 |
| `/new` | 開新對話 |
| `/cost` | 這段對話的 token 與花費 |
| `/credits` | 查餘額 |
| `/exit` | 離開（也可以按 Ctrl+D） |

單獨一行輸入 `"""` 開始多行輸入，再一行 `"""` 結束送出。回覆中按 Ctrl+C 只會中斷這次回覆。

## 資料位置

設定（含 API key）、對話紀錄與模型清單快取存在：

- 從 npm 安裝：`~/.tkflyc-openrouter/`（Windows 是 `%USERPROFILE%\.tkflyc-openrouter\`）
- 從 git clone 的專案資料夾直接執行：專案內的 `data/`（已列入 `.gitignore`）

設定環境變數 `OPENROUTER_CLI_HOME` 可以改到任何位置。`openrouter help` 會顯示目前實際使用的位置。

API key 以明文存在 `config.json`，請不要把這個資料夾分享或放進版控。

## Windows 小提醒

Windows PowerShell 5.1 透過 pipe 傳給外部程式的文字預設不是 UTF-8，中文會變成 `?`。建議改用 PowerShell 7，或先執行：

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new()
```

## 授權

MIT
