#!/usr/bin/env node
// openrouter — OpenRouter 命令列工具。資料位置見 src/store.js；唯讀檔案工具見 src/tools.js。
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import * as api from '../src/api.js';
import * as store from '../src/store.js';
import * as tools from '../src/tools.js';

const color = (code) => (text, stream = process.stdout) =>
  stream.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
const dim = color('2');
const red = color('31');
const green = color('32');
const yellow = color('33');
const cyan = color('36');

const HELP = `openrouter — OpenRouter 命令列工具

用法：
  openrouter                          開始互動對話（同 chat）
  openrouter chat [-m 模型] [-c | --session ID] [-s 系統提示] [--no-agent]
                                      互動對話；-c 接續上一次的對話
  openrouter ask [問題...] [-m 模型] [-s 系統提示] [--no-stream] [--no-agent]
                                      單次提問，可從 pipe 接內容，例如：
                                      Get-Content app.log | openrouter ask "幫我摘要錯誤"
  openrouter models [關鍵字...] [--free] [--refresh]
                                      搜尋模型（context 長度與每百萬 tokens 價格）
  openrouter use [模型 id 或關鍵字]    設定預設模型；不帶參數會列出最近用過的模型與價格讓你選
  openrouter credits                  查帳戶餘額與這把 key 的用量
  openrouter key [--stdin | --show]   設定 API key（隱藏輸入，先實際驗證才存檔）
  openrouter sessions                 列出對話紀錄
  openrouter help                     顯示這份說明

唯讀工具（預設開啟）：模型可以列目錄、讀檔、搜尋這台電腦所有磁碟上的檔案（相對路徑以
啟動 CLI 時所在的資料夾為準），不能修改或執行任何東西。讀到的內容會送到 OpenRouter 與模型供應商；
.env、私鑰、使用者目錄的 AppData／.ssh／.config／.local 等放憑證的位置、Windows 系統資料夾一律拒讀。
不想讓模型讀檔時加 --no-agent，或在對話中輸入 /agent off；只想開放啟動資料夾時，
在資料位置的 config.json 設 "agentScope": "cwd"。

問題以 - 開頭時，放在 -- 後面：openrouter ask -- "-1 的平方根"

資料位置：${store.DATA_DIR}
環境變數 OPENROUTER_API_KEY 有設定時，會優先於資料位置裡 config.json 的 key。`;

const REPL_HELP = `對話中的指令：
  /model [關鍵字]        列出最近用過的模型與價格，輸入編號切換、輸入關鍵字搜尋
                         （帶完整 id 或只符合一個的關鍵字會直接切換；只影響這段對話）
  /default               把這段對話的模型設成預設模型
  /models <關鍵字>       只列出搜尋結果與價格，不切換
  /agent on|off          這段對話開／關唯讀工具（讓模型讀工作資料夾裡的檔案）
  /system [文字]         自訂系統提示（取代預設的「用繁體中文回答」）；不帶文字就恢復預設
  /think on|off          顯示或隱藏模型的思考過程
  /stream on|off         串流輸出開關
  /new                   開新對話
  /cost                  這次對話的 token 與花費
  /credits               查餘額
  /exit                  離開（也可以按 Ctrl+D）
  """                    單獨一行輸入 """ 開始多行輸入，再一行 """ 結束送出
回覆中按 Ctrl+C 只中斷這次回覆；輸入到一半按 Ctrl+C 清掉這行；空白時按 Ctrl+C 離開。`;

const COMMANDS = new Set(['chat', 'ask', 'models', 'use', 'credits', 'key', 'sessions', 'help']);

async function main() {
  let [cmd, ...rest] = process.argv.slice(2);
  // 沒指令（或直接帶選項）：在終端機就進對話，從 pipe 進來就當單次提問
  if (cmd === undefined || (cmd.startsWith('-') && cmd !== '-h' && cmd !== '--help')) {
    rest = process.argv.slice(2);
    cmd = process.stdin.isTTY ? 'chat' : 'ask';
  }
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') return console.log(HELP);
  if (!COMMANDS.has(cmd)) {
    console.error(red(`不認得的指令：${cmd}（openrouter help 看用法）`, process.stderr));
    process.exitCode = 2;
    return;
  }

  const { values: opts, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      model: { type: 'string', short: 'm' },
      system: { type: 'string', short: 's' },
      'no-stream': { type: 'boolean' },
      'no-agent': { type: 'boolean' },
      continue: { type: 'boolean', short: 'c' },
      session: { type: 'string' },
      free: { type: 'boolean' },
      refresh: { type: 'boolean' },
      stdin: { type: 'boolean' },
      show: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (opts.help) return console.log(HELP);

  switch (cmd) {
    case 'chat':
      return cmdChat(opts);
    case 'ask':
      return cmdAsk(positionals, opts);
    case 'models':
      return cmdModels(positionals, opts);
    case 'use':
      return cmdUse(positionals);
    case 'credits':
      return printCredits(await requireKey());
    case 'key':
      return opts.show ? cmdKeyShow() : setupKey(opts);
    case 'sessions':
      return cmdSessions();
  }
}

// ── API key ─────────────────────────────────────────────

async function requireKey() {
  const { key } = store.resolveApiKey();
  if (key) return key;
  if (!process.stdin.isTTY) throw new Error('還沒設定 API key，先執行 openrouter key');
  console.log(yellow('還沒設定 API key，先設定一次。'));
  return setupKey({});
}

async function setupKey(opts) {
  let key;
  if (opts.stdin) {
    key = (await readStdin()).trim();
  } else {
    console.log(dim('到 https://openrouter.ai/settings/keys 建立 key，貼上後按 Enter（畫面只會顯示 *）'));
    key = (await promptHidden('API key: ')).trim();
  }
  const problem = store.checkKeyFormat(key);
  if (problem) throw new Error(`這不像 OpenRouter 的 key：${problem}。沒有存檔。`);

  console.log(dim('向 OpenRouter 驗證中…'));
  let info;
  try {
    info = await api.getKeyInfo(key);
  } catch (err) {
    throw new api.ApiError(err.status, `${err.message}\n  （key 沒有存檔）`);
  }
  store.saveConfig({ apiKey: key });
  console.log(green(`✓ key 有效，已存到 ${store.CONFIG_FILE}`));
  printKeyInfo(info);
  if (process.env.OPENROUTER_API_KEY) {
    console.log(yellow('注意：環境變數 OPENROUTER_API_KEY 有設定，執行時會優先用它，而不是剛存的這把。'));
  }
  return key;
}

async function cmdKeyShow() {
  const { key, source } = store.resolveApiKey();
  if (!key) return console.log('還沒設定 API key（執行 openrouter key）');
  console.log(`目前 key：${store.maskKey(key)}\n來源：${source}`);
  const problem = store.checkKeyFormat(key);
  if (problem) throw new Error(`這把 key 格式有問題：${problem}`);
  printKeyInfo(await api.getKeyInfo(key));
}

// 隱藏輸入：每個字顯示 *，支援貼上與退格；濾掉控制字元與終端機的括號貼上標記
function promptHidden(question) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return Promise.reject(new Error('隱藏輸入需要終端機；從 pipe 輸入請用 openrouter key --stdin'));
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (err) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8').replace(/\x1b\[20[01]~/g, '')) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\x03') return finish(new Error('已取消'));
        if (ch === '\x7f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
        } else if (ch >= ' ') {
          value += ch;
          stdout.write('*');
        }
      }
    };
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
}

// ── 額度 ────────────────────────────────────────────────

const usd = (n, digits = 4) => `$${Number(n ?? 0).toFixed(digits)}`;

function printKeyInfo(info) {
  const limit = info.limit == null ? '沒有設上限' : `上限 ${usd(info.limit, 2)}，剩 ${usd(info.limit_remaining)}`;
  console.log(`這把 key：${info.label ?? '（無標籤）'}`);
  console.log(`  累計用了 ${usd(info.usage)}，${limit}`);
  if (info.usage_daily != null) {
    console.log(`  今日 ${usd(info.usage_daily)}／本週 ${usd(info.usage_weekly)}／本月 ${usd(info.usage_monthly)}`);
  }
  if (info.is_free_tier) console.log(dim('  免費方案（沒有儲值過，免費模型每日可用次數較少）'));
}

async function printCredits(key) {
  const [info, credits] = await Promise.allSettled([api.getKeyInfo(key), api.getCredits(key)]);
  if (info.status === 'rejected') throw info.reason;
  if (credits.status === 'fulfilled') {
    const total = Number(credits.value.total_credits ?? 0);
    const used = Number(credits.value.total_usage ?? 0);
    console.log(`帳戶餘額：${usd(total - used)}（儲值 ${usd(total, 2)}，已用 ${usd(used)}）`);
  } else {
    console.log(yellow(`帳戶餘額查不到：${credits.reason.message}`));
  }
  printKeyInfo(info.value);
}

// ── 模型 ────────────────────────────────────────────────

async function getModels(refresh = false) {
  let models = refresh ? null : store.readModelsCache();
  if (!models) {
    models = await api.listModels();
    store.writeModelsCache(models);
  }
  return models;
}

const defaultModel = () => store.loadConfig().model ?? store.DEFAULT_MODEL;

const isFree = (m) =>
  m.id.endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);

// 每個關鍵字都要出現在 id 或名稱裡（不分大小寫）
function searchModels(models, terms, { free = false } = {}) {
  const words = terms.flatMap((t) => t.toLowerCase().split(/\s+/)).filter(Boolean);
  return models
    .filter((m) => (!free || isFree(m)) && words.every((w) => `${m.id} ${m.name ?? ''}`.toLowerCase().includes(w)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function perMillion(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0) return 'var';
  if (n === 0) return 'free';
  const perM = n * 1e6;
  return `$${perM.toFixed(perM < 0.1 ? 3 : 2)}`;
}

function contextSize(n) {
  if (!n) return '?';
  return n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}

function printModels(list, { limit = 30, current, numbered = false } = {}) {
  if (!list.length) return console.log(yellow('沒有符合的模型'));
  const shown = list.slice(0, limit);
  const width = Math.max(...shown.map((m) => m.id.length), 4);
  const numWidth = String(shown.length).length;
  const indent = ' '.repeat(2 + (numbered ? numWidth + 1 : 0));
  console.log(dim(`${indent}${'模型'.padEnd(width - 2)}  context    入/1M    出/1M  工具`));
  shown.forEach((m, i) => {
    const mark = m.id === current ? green('*') : ' ';
    const num = numbered ? `${String(i + 1).padStart(numWidth)} ` : '';
    const ctx = contextSize(m.context_length).padStart(7);
    const input = perMillion(m.pricing?.prompt).padStart(7);
    const output = perMillion(m.pricing?.completion).padStart(7);
    const toolMark = m.supported_parameters?.includes('tools') ? '  ✓' : '';
    console.log(`${mark} ${num}${m.id.padEnd(width)}  ${ctx}  ${input}  ${output}${toolMark}`);
  });
  if (list.length > limit) console.log(dim(`…還有 ${list.length - limit} 個，加關鍵字縮小範圍`));
  console.log(dim('價格為每百萬 tokens（USD），入＝送出的內容，出＝模型的回覆；* 是目前的模型；工具 ✓＝能讀檔'));
}

const findModel = (models, id) => models.find((m) => m.id === id);

function priceTag(model) {
  if (!model) return '（模型清單裡查不到價格）';
  const input = perMillion(model.pricing?.prompt);
  const output = perMillion(model.pricing?.completion);
  return `入 ${input}／出 ${output} 每百萬 tokens，context ${contextSize(model.context_length)}`;
}

// 最近用過的模型（新的在前，最多 8 個），給 /model 和 openrouter use 列選單用
function rememberModels(...ids) {
  const recent = store.loadConfig().recentModels ?? [];
  store.saveConfig({ recentModels: [...new Set([...ids, ...recent])].slice(0, 8) });
}

// rl.question 在 readline 關閉（Ctrl+D）時不一定會結束，所以和 close 事件賽跑，關閉時回傳 null
function questioner(rl) {
  const closed = new Promise((resolve) => rl.once('close', () => resolve(null)));
  return (prompt) => Promise.race([rl.question(prompt).catch(() => null), closed]);
}

// 選模型：完整 id 直接用；關鍵字只符合一個就用那個。
// 沒給關鍵字（列最近用過的）或符合多個時，列出編號與價格讓使用者選；
// prompt 為 null 是非互動模式，符合多個就報錯。回傳 model id，使用者取消時回傳 null。
async function pickModel(query, { prompt = null, current } = {}) {
  if (!query && !prompt) return current ?? null;
  let models;
  try {
    models = await getModels();
  } catch (err) {
    if (query?.includes('/')) return query; // 模型清單抓不到時，看起來像完整 id 就照用
    throw err;
  }
  for (;;) {
    let list;
    if (query) {
      if (findModel(models, query)) return query;
      list = searchModels(models, [query]);
      if (list.length === 1) return list[0].id;
      if (!prompt) {
        if (!list.length) throw new Error(`找不到符合「${query}」的模型（openrouter models <關鍵字> 可以搜尋）`);
        printModels(list, { limit: 10, current });
        throw new Error(`「${query}」符合 ${list.length} 個模型，請給完整 id 或更精確的關鍵字`);
      }
      console.log(list.length ? dim(`符合「${query}」的模型：`) : yellow(`找不到符合「${query}」的模型`));
    } else {
      const recent = [current, ...(store.loadConfig().recentModels ?? [])];
      list = [...new Set(recent)].map((id) => findModel(models, id)).filter(Boolean);
      console.log(dim('目前與最近用過的模型：'));
    }
    if (list.length) printModels(list, { limit: 20, current, numbered: true });
    const answer = ((await prompt(cyan('輸入編號切換，或輸入關鍵字搜尋（例如 qwen、claude、free）；直接 Enter 取消 > '))) ?? '').trim();
    if (!answer) return null;
    if (/^\d+$/.test(answer)) {
      const n = Number(answer);
      if (n >= 1 && n <= Math.min(list.length, 20)) return list[n - 1].id;
      console.log(yellow(`沒有編號 ${answer}`)); // 純數字一律當編號，不拿去搜尋
      continue;
    }
    query = answer;
  }
}

async function cmdModels(terms, opts) {
  const hits = searchModels(await getModels(opts.refresh), terms, { free: opts.free });
  printModels(hits, { limit: terms.length || opts.free ? 50 : 30, current: defaultModel() });
}

async function cmdUse(terms) {
  const current = defaultModel();
  const interactive = process.stdin.isTTY;
  if (!terms.length) {
    console.log(`目前預設模型：${current}\n  ${priceTag(findModel(await getModels().catch(() => []), current))}`);
    if (!interactive) return;
  }
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  let id;
  try {
    id = await pickModel(terms.join(' ') || null, { prompt: rl && questioner(rl), current });
  } finally {
    rl?.close();
  }
  if (!id || id === current) return console.log(dim(`預設模型不變：${current}`));
  store.saveConfig({ model: id });
  rememberModels(id, current);
  console.log(green(`預設模型改為 ${id}`));
  console.log(`  ${priceTag(findModel(await getModels(), id))}`);
}

// ── 對話 ────────────────────────────────────────────────

function usageLine(usage, served, requested, toolRuns = 0) {
  if (!usage) return '';
  const parts = [`${usage.prompt_tokens ?? 0} 入／${usage.completion_tokens ?? 0} 出 tokens`];
  if (typeof usage.cost === 'number') parts.push(usage.cost === 0 ? '免費' : usd(usage.cost, 6));
  if (toolRuns) parts.push(`工具 ${toolRuns} 次`);
  if (served && served !== requested) parts.push(`實際回覆模型 ${served}`);
  return `[${parts.join('，')}]`;
}

// 一輪裡可能有好幾次請求（agent 迴圈），用量要加總後再顯示
function mergeUsage(total, usage) {
  if (!usage) return total;
  const sum = total ?? { prompt_tokens: 0, completion_tokens: 0 };
  sum.prompt_tokens += usage.prompt_tokens ?? 0;
  sum.completion_tokens += usage.completion_tokens ?? 0;
  if (typeof usage.cost === 'number') sum.cost = (sum.cost ?? 0) + usage.cost;
  return sum;
}

function addUsage(session, usage) {
  if (!usage) return;
  const total = session.usage;
  total.prompt_tokens += usage.prompt_tokens ?? 0;
  total.completion_tokens += usage.completion_tokens ?? 0;
  total.cost += typeof usage.cost === 'number' ? usage.cost : 0;
  total.requests += 1;
}

// 送出一次請求並把串流內容印出來；思考過程依 showReasoning 顯示，或只提示「思考中」
async function callModel(key, session, messages, { showReasoning = false, signal, toolDefs, toolChoice } = {}) {
  let reasoningShown = false;
  let thinkingNotice = false;
  let started = false;

  let result;
  try {
    result = await api.chat({
      key,
      model: session.model,
      messages,
      stream: session.stream !== false,
      signal,
      tools: toolDefs,
      toolChoice,
      onReasoning(text) {
        if (showReasoning) {
          process.stdout.write(dim(text));
          reasoningShown = true;
        } else if (!thinkingNotice) {
          process.stderr.write(dim('（思考中…）', process.stderr));
          thinkingNotice = true;
        }
      },
      onDelta(text) {
        if (!started) {
          if (reasoningShown) process.stdout.write('\n\n');
          else if (thinkingNotice) process.stderr.write(process.stderr.isTTY ? '\r\x1b[K' : '\n');
          started = true;
        }
        process.stdout.write(text);
      },
    });
  } catch (err) {
    if (started) process.stdout.write('\n'); // 已印出部分回答時，讓錯誤訊息換行顯示
    else if (thinkingNotice) process.stderr.write('\n');
    throw err;
  }
  // 只有「思考中」提示、沒有內容（例如接著要呼叫工具）時，把提示清掉
  if (!started && thinkingNotice) process.stderr.write(process.stderr.isTTY ? '\r\x1b[K' : '\n');
  if ((started && !result.text.endsWith('\n')) || (!started && reasoningShown)) process.stdout.write('\n');
  return result;
}

const DEFAULT_SYSTEM = '請一律使用繁體中文（台灣用語）回答。';
const MAX_TOOL_STEPS = 25;

const agentScope = (config) => (config.agentScope === 'cwd' ? 'cwd' : 'all');

function scopeText(ctx) {
  return ctx.scope === 'all'
    ? `可讀所有磁碟 ${ctx.roots.join('、')}（敏感位置除外），相對路徑以 ${ctx.root} 為準`
    : `只能讀 ${ctx.root}`;
}

function agentPrompt(ctx) {
  const scope =
    ctx.scope === 'all'
      ? `- 可讀範圍：所有磁碟（${ctx.roots.join('、')}）。要看工作資料夾以外的地方，用絕對路徑，例如 D:\\Projects\\app\\README.md；也可以 list_dir 磁碟根目錄（例如 E:\\）找方向。`
      : '- 可讀範圍：只限工作資料夾。';
  return [
    '你在使用者的電腦上執行，可以用唯讀工具查看檔案：',
    `- 工作資料夾：${ctx.root}（使用者就是在這裡啟動你的；相對路徑以這裡為準）`,
    scope,
    `- 作業系統：${process.platform}；今天日期：${new Date().toISOString().slice(0, 10)}`,
    '- 你只有唯讀工具（list_dir、read_file、search、find_files），不能修改、建立或刪除檔案，也不能執行指令；需要修改或執行時，把建議寫給使用者自己做。',
    '- 敏感位置（使用者目錄的 AppData、.ssh、.config、.local 等、Windows 系統資料夾、.env 與私鑰）由工具負責拒讀。其他檔案照常用工具讀取，不要只憑檔名或位置就自己拒絕；工具回報拒讀時，告訴使用者原因，不要換其他路徑嘗試繞過。',
    '- 使用者說「這個專案」「這裡」「這個資料夾」「這支程式」，或沒有指明位置時，一律是指工作資料夾：直接用工具查看再回答，不要反問路徑，也不要請使用者貼檔案內容或目錄樹。只有使用者明確提到其他路徑時，才去其他地方。',
    '- 先用 list_dir 了解結構，再用 find_files 或 search 找相關檔案，最後用 read_file 讀需要的部分；不要一次讀進大量無關的檔案。搜尋整個磁碟很慢而且可能只掃到一部分，先縮小到可能的資料夾。',
    '- 引用檔案時附上路徑與行號：工作資料夾內用相對路徑（例如 src/server.cs:42），其他地方用絕對路徑。',
  ].join('\n');
}

// 使用者自訂的系統提示會取代預設的語言要求；開了唯讀工具時再附上工作資料夾與工具規則
function systemPrompt(session, ctx) {
  const parts = [session.system || DEFAULT_SYSTEM];
  if (ctx) parts.push(agentPrompt(ctx));
  return parts.join('\n\n');
}

// 模型清單有標 supported_parameters；清單裡查不到的模型先當作支援，交給 API 判斷
async function supportsTools(modelId) {
  const model = findModel(await getModels().catch(() => []), modelId);
  return !Array.isArray(model?.supported_parameters) || model.supported_parameters.includes('tools');
}

const toApiMessage = ({ role, content, tool_calls, tool_call_id }) => ({
  role,
  content,
  ...(tool_calls && { tool_calls }),
  ...(tool_call_id && { tool_call_id }),
});

// 送出這一輪並把回覆接到 session 上。開著唯讀工具時跑 agent 迴圈：
// 模型要求工具 → 本機執行 → 結果交回模型，直到模型給出回答。
// 失敗或模型回空白時撤回整輪（提問與中間的工具往返），讓對話紀錄保持乾淨、使用者可以直接重送。
async function runTurn(key, session, { showReasoning = false, signal, toolCtx = null } = {}) {
  const turnStart = session.messages.length - 1;
  let ctx = toolCtx;
  if (ctx && !(await supportsTools(session.model))) {
    console.error(dim('（這個模型不支援工具呼叫，這一輪改用一般聊天；/model 清單裡標 ✓ 的模型才能讀檔）', process.stderr));
    ctx = null;
  }

  let result;
  let turnUsage = null;
  let toolRuns = 0;
  try {
    for (let step = 1; ; step++) {
      const messages = [{ role: 'system', content: systemPrompt(session, ctx) }, ...session.messages.map(toApiMessage)];
      try {
        result = await callModel(key, session, messages, {
          showReasoning,
          signal,
          toolDefs: ctx ? tools.DEFINITIONS : undefined,
          toolChoice: ctx && step >= MAX_TOOL_STEPS ? 'none' : undefined, // 到上限就要求模型直接回答
        });
      } catch (err) {
        // 供應商不支援工具時，第一步就會被拒；退回一般聊天重試一次
        if (ctx && step === 1 && err.status === 404 && /tool/i.test(err.message)) {
          console.error(dim('（這個模型的供應商不支援工具呼叫，這一輪改用一般聊天）', process.stderr));
          ctx = null;
          step = 0;
          continue;
        }
        throw err;
      }
      addUsage(session, result.usage);
      turnUsage = mergeUsage(turnUsage, result.usage);
      if (!ctx || result.finish === 'aborted') break;

      let calls = result.toolCalls;
      let content = result.text;
      if (!calls.length) {
        calls = tools.parseTextToolCalls(result.text);
        if (calls.length) {
          content = tools.stripTextToolCalls(result.text);
          console.error(dim('（模型用文字格式呼叫工具，已改用備援解析）', process.stderr));
        }
      }
      if (!calls.length) break;
      if (step >= MAX_TOOL_STEPS) {
        console.error(yellow(`（已達工具呼叫上限 ${MAX_TOOL_STEPS} 輪，停止）`, process.stderr));
        break;
      }

      session.messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
      });
      for (const call of calls) {
        const output = tools.runTool(ctx, call.name, call.arguments);
        console.error(dim(`  ↳ ${output.summary}`, process.stderr));
        session.messages.push({ role: 'tool', tool_call_id: call.id, content: output.content });
        toolRuns++;
      }
    }
  } catch (err) {
    session.messages.length = turnStart;
    throw err;
  }

  if (result.finish === 'aborted') console.error(yellow('（已中斷）', process.stderr));
  if (!result.text) {
    session.messages.length = turnStart;
    if (result.finish !== 'aborted') {
      console.error(yellow(`（模型沒有回任何內容，finish_reason=${result.finish ?? '無'}；這一輪沒有記進對話）`, process.stderr));
    }
    return result;
  }
  session.messages.push({ role: 'assistant', content: result.text, model: result.model });
  const info = usageLine(turnUsage, result.model, session.model, toolRuns);
  if (info) console.error(dim(info, process.stderr));
  return result;
}

async function cmdAsk(terms, opts) {
  let prompt = terms.join(' ');
  if (!process.stdin.isTTY) {
    const piped = (await readStdin()).trim();
    if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped;
  }
  if (!prompt.trim()) throw new Error('沒有問題內容：openrouter ask "你的問題"，或從 pipe 送內容進來');

  const key = await requireKey();
  const config = store.loadConfig();
  const session = store.newSession(opts.model ? await pickModel(opts.model) : defaultModel(), 'ask');
  session.system = opts.system ?? config.system ?? '';
  session.stream = !opts['no-stream'];
  session.messages.push({ role: 'user', content: prompt });

  const agentOn = !opts['no-agent'] && config.agent !== false;
  const toolCtx = agentOn ? tools.createContext(process.cwd(), { deny: [store.DATA_DIR], scope: agentScope(config) }) : null;

  const ctrl = new AbortController();
  process.once('SIGINT', () => ctrl.abort());
  const result = await runTurn(key, session, { signal: ctrl.signal, toolCtx });
  if (session.messages.length) store.saveSession(session);
  if (!result.text) process.exitCode = 1;
}

async function cmdChat(opts) {
  if (!process.stdin.isTTY) throw new Error('互動對話需要在終端機執行；要用 pipe 請改用 openrouter ask');
  const key = await requireKey();
  const config = store.loadConfig();
  const fresh = () => {
    const s = store.newSession(defaultModel(), 'chat');
    s.system = config.system ?? '';
    return s;
  };

  let session = null;
  if (opts.session) session = store.loadSession(opts.session);
  else if (opts.continue) session = store.listSessions().find((s) => s.kind === 'chat') ?? null;
  if (opts.continue && !session) console.log(dim('沒有可以接續的對話，開一個新的。'));
  session ??= fresh();
  if (opts.model) session.model = await pickModel(opts.model);
  if (opts.system !== undefined) session.system = opts.system;
  if (opts['no-stream']) session.stream = false;
  let showReasoning = config.showReasoning ?? false;
  let agentOn = !opts['no-agent'] && config.agent !== false;
  const toolCtx = tools.createContext(process.cwd(), { deny: [store.DATA_DIR], scope: agentScope(config) });
  const agentStatus = () => (agentOn ? `開（${scopeText(toolCtx)}；/agent off 關閉）` : '關（/agent on 開啟）');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 500 });
  const ask = questioner(rl);
  let ctrl = null;
  rl.on('SIGINT', () => {
    if (ctrl) ctrl.abort(); // 回覆中：只中斷這次回覆
    else if (rl.line) rl.write(null, { ctrl: true, name: 'u' }); // 輸入到一半：清掉這行
    else rl.close();
  });

  console.log(`${cyan('OpenRouter 對話')} ${dim(`· ${session.id} · /help 看指令，/model 換模型，/exit 離開`)}`);
  console.log(dim(`模型 ${session.model}：${priceTag(findModel(await getModels().catch(() => []), session.model))}`));
  console.log(dim(`唯讀工具：${agentStatus()}`));
  if (session.messages.length) console.log(dim(`接續先前的對話（${session.messages.length} 則訊息）`));

  for (;;) {
    let line = await ask(cyan(`(${session.model}) > `));
    if (line === null) break;
    if (line.trim() === '"""') {
      const lines = [];
      for (;;) {
        const more = await ask(dim('... '));
        if (more === null || more.trim() === '"""') break;
        lines.push(more);
      }
      line = lines.join('\n');
    }
    if (!line.trim()) continue;

    try {
      if (line.startsWith('/')) {
        const [name, ...args] = line.slice(1).trim().split(/\s+/);
        const arg = args.join(' ');
        if (name === 'exit' || name === 'quit') break;
        switch (name) {
          case 'help':
            console.log(REPL_HELP);
            break;
          case 'new':
            session = fresh();
            console.log(dim(`開新對話 ${session.id}`));
            break;
          case 'model': {
            const id = await pickModel(arg || null, { prompt: ask, current: session.model });
            if (!id || id === session.model) {
              console.log(dim(`沿用 ${session.model}`));
              break;
            }
            const models = await getModels();
            console.log(`${session.model} → ${green(id)}`);
            console.log(dim(`  原本：${priceTag(findModel(models, session.model))}`));
            console.log(`  現在：${priceTag(findModel(models, id))}`);
            rememberModels(id, session.model);
            session.model = id;
            console.log(dim('只影響這段對話；輸入 /default 可設成預設模型'));
            break;
          }
          case 'default':
            store.saveConfig({ model: session.model });
            rememberModels(session.model);
            console.log(green(`預設模型改為 ${session.model}`));
            break;
          case 'models':
            printModels(searchModels(await getModels(), args), { current: session.model });
            break;
          case 'system':
            session.system = arg;
            console.log(dim(arg ? '已設定系統提示（取代預設的繁體中文要求）' : '已清除自訂系統提示，恢復預設（用繁體中文回答）'));
            break;
          case 'agent':
            if (arg === 'on' || arg === 'off') agentOn = arg === 'on';
            console.log(dim(`唯讀工具：${agentStatus()}`));
            break;
          case 'think':
            if (arg === 'on' || arg === 'off') {
              showReasoning = arg === 'on';
              store.saveConfig({ showReasoning });
            }
            console.log(dim(`思考過程：${showReasoning ? '顯示' : '隱藏'}`));
            break;
          case 'stream':
            if (arg === 'on' || arg === 'off') session.stream = arg === 'on';
            console.log(dim(`串流輸出：${session.stream === false ? '關' : '開'}`));
            break;
          case 'cost': {
            const u = session.usage;
            console.log(`這次對話：${u.requests} 次請求，${u.prompt_tokens} 入／${u.completion_tokens} 出 tokens，${usd(u.cost, 6)}`);
            break;
          }
          case 'credits':
            await printCredits(key);
            break;
          default:
            console.log(yellow(`不認得的指令 /${name}，輸入 /help 看清單`));
        }
        continue;
      }

      session.messages.push({ role: 'user', content: line });
      ctrl = new AbortController();
      await runTurn(key, session, { showReasoning, signal: ctrl.signal, toolCtx: agentOn ? toolCtx : null });
    } catch (err) {
      console.error(red(err.message, process.stderr));
    } finally {
      ctrl = null;
    }
    if (session.messages.length) store.saveSession(session);
  }

  rl.close();
  if (session.messages.length) console.log(dim(`對話已存檔：${session.id}（openrouter chat -c 可以接著聊）`));
}

// ── 紀錄 ────────────────────────────────────────────────

function cmdSessions() {
  const list = store.listSessions();
  if (!list.length) return console.log(dim(`還沒有對話紀錄（${store.SESSIONS_DIR}）`));
  for (const s of list.slice(0, 30)) {
    const first = s.messages.find((m) => m.role === 'user')?.content ?? '';
    const count = String(s.messages.length).padStart(3);
    console.log(`${s.id}  ${s.kind.padEnd(4)}  ${count} 則  ${s.model}  ${dim(first.replace(/\s+/g, ' ').slice(0, 40))}`);
  }
  console.log(dim(`共 ${list.length} 筆，存在 ${store.SESSIONS_DIR}`));
  console.log(dim('接續：openrouter chat --session <id>，或 openrouter chat -c 接上一次'));
}

main().catch((err) => {
  console.error(red(err.message, process.stderr));
  process.exitCode = 1;
});
