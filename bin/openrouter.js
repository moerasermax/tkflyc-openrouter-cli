#!/usr/bin/env node
// openrouter — 個人用 OpenRouter CLI。設定、對話紀錄、快取都放在專案的 data/ 底下。
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import * as api from '../src/api.js';
import * as store from '../src/store.js';

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
  openrouter chat [-m 模型] [-c | --session ID] [-s 系統提示]
                                      互動對話；-c 接續上一次的對話
  openrouter ask [問題...] [-m 模型] [-s 系統提示] [--no-stream]
                                      單次提問，可從 pipe 接內容，例如：
                                      Get-Content app.log | openrouter ask "幫我摘要錯誤"
  openrouter models [關鍵字...] [--free] [--refresh]
                                      搜尋模型（context 長度與每百萬 tokens 價格）
  openrouter use [模型 id 或關鍵字]    設定預設模型；不帶參數會列出最近用過的模型與價格讓你選
  openrouter credits                  查帳戶餘額與這把 key 的用量
  openrouter key [--stdin | --show]   設定 API key（隱藏輸入，先實際驗證才存檔）
  openrouter sessions                 列出對話紀錄
  openrouter help                     顯示這份說明

問題以 - 開頭時，放在 -- 後面：openrouter ask -- "-1 的平方根"

資料位置：${store.DATA_DIR}
環境變數 OPENROUTER_API_KEY 有設定時，會優先於 data/config.json 裡的 key。`;

const REPL_HELP = `對話中的指令：
  /model [關鍵字]        列出最近用過的模型與價格，輸入編號切換、輸入關鍵字搜尋
                         （帶完整 id 或只符合一個的關鍵字會直接切換；只影響這段對話）
  /default               把這段對話的模型設成預設模型
  /models <關鍵字>       只列出搜尋結果與價格，不切換
  /system [文字]         設定系統提示；不帶文字就清除
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
  console.log(dim(`${indent}${'模型'.padEnd(width - 2)}  context    入/1M    出/1M`));
  shown.forEach((m, i) => {
    const mark = m.id === current ? green('*') : ' ';
    const num = numbered ? `${String(i + 1).padStart(numWidth)} ` : '';
    const ctx = contextSize(m.context_length).padStart(7);
    const input = perMillion(m.pricing?.prompt).padStart(7);
    const output = perMillion(m.pricing?.completion).padStart(7);
    console.log(`${mark} ${num}${m.id.padEnd(width)}  ${ctx}  ${input}  ${output}`);
  });
  if (list.length > limit) console.log(dim(`…還有 ${list.length - limit} 個，加關鍵字縮小範圍`));
  console.log(dim('價格為每百萬 tokens（USD），入＝送出的內容，出＝模型的回覆；* 是目前的模型'));
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

function usageLine(usage, served, requested) {
  if (!usage) return '';
  const parts = [`${usage.prompt_tokens ?? 0} 入／${usage.completion_tokens ?? 0} 出 tokens`];
  if (typeof usage.cost === 'number') parts.push(usage.cost === 0 ? '免費' : usd(usage.cost, 6));
  if (served && served !== requested) parts.push(`實際回覆模型 ${served}`);
  return `[${parts.join('，')}]`;
}

function addUsage(session, usage) {
  if (!usage) return;
  const total = session.usage;
  total.prompt_tokens += usage.prompt_tokens ?? 0;
  total.completion_tokens += usage.completion_tokens ?? 0;
  total.cost += typeof usage.cost === 'number' ? usage.cost : 0;
  total.requests += 1;
}

// 送出 session 目前的訊息並把回覆接到 session 上。
// 失敗或模型回空白時撤回這一輪的提問，讓對話紀錄保持乾淨、使用者可以直接重送。
async function runTurn(key, session, { showReasoning = false, signal } = {}) {
  const history = session.messages.map(({ role, content }) => ({ role, content }));
  const messages = session.system ? [{ role: 'system', content: session.system }, ...history] : history;
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
    session.messages.pop();
    throw err;
  }

  if (!started && thinkingNotice) process.stderr.write('\n');
  if ((started && !result.text.endsWith('\n')) || (!started && reasoningShown)) process.stdout.write('\n');
  addUsage(session, result.usage);
  if (result.finish === 'aborted') console.error(yellow('（已中斷）', process.stderr));

  if (!result.text) {
    session.messages.pop();
    if (result.finish !== 'aborted') {
      console.error(yellow(`（模型沒有回任何內容，finish_reason=${result.finish ?? '無'}；這一輪沒有記進對話）`, process.stderr));
    }
    return result;
  }
  session.messages.push({ role: 'assistant', content: result.text, model: result.model });
  const info = usageLine(result.usage, result.model, session.model);
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

  const ctrl = new AbortController();
  process.once('SIGINT', () => ctrl.abort());
  const result = await runTurn(key, session, { signal: ctrl.signal });
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
            console.log(dim(arg ? '已設定系統提示' : '已清除系統提示'));
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
      await runTurn(key, session, { showReasoning, signal: ctrl.signal });
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
