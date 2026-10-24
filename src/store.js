// 資料目錄內容：
//   config.json   API key、預設模型等設定
//   sessions/     每段對話一個 JSON
//   cache/        模型清單快取
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 從 git 專案資料夾執行（開發版、npm link）時放專案的 data/；從 npm 安裝時放使用者目錄，
// 免得更新或重裝套件時連同 key 與對話紀錄一起被清掉。環境變數 OPENROUTER_CLI_HOME 可以覆寫兩者。
const DEFAULT_DATA_DIR = fs.existsSync(path.join(PROJECT_DIR, '.git'))
  ? path.join(PROJECT_DIR, 'data')
  : path.join(os.homedir(), '.tkflyc-openrouter');
export const DATA_DIR = process.env.OPENROUTER_CLI_HOME
  ? path.resolve(process.env.OPENROUTER_CLI_HOME)
  : DEFAULT_DATA_DIR;
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const MODELS_CACHE = path.join(DATA_DIR, 'cache', 'models.json');
const MODELS_TTL_MS = 6 * 60 * 60 * 1000;

export const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`讀取 ${file} 失敗：${err.message}`);
  }
}

// 先寫暫存檔再改名，避免寫到一半中斷留下壞檔
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadConfig() {
  return readJson(CONFIG_FILE, {});
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  writeJson(CONFIG_FILE, next);
  return next;
}

export function resolveApiKey() {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: '環境變數 OPENROUTER_API_KEY' };
  const key = loadConfig().apiKey;
  return key ? { key, source: CONFIG_FILE } : { key: '', source: '' };
}

// 在打任何 API 之前先擋掉明顯不是 key 的輸入（例如只存進一個 '?'）
export function checkKeyFormat(key) {
  if (!key) return '沒有輸入任何內容';
  if (/[^\x21-\x7e]/.test(key)) return 'key 裡有空白、換行或非英數字元';
  if (!key.startsWith('sk-or-')) return `開頭不是 sk-or-（收到 ${key.length} 個字元）`;
  if (key.length < 30) return `只有 ${key.length} 個字元，看起來不完整`;
  return '';
}

export function maskKey(key) {
  return `${key.slice(0, 9)}…${key.slice(-4)}（${key.length} 字元）`;
}

export function newSession(model, kind) {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return {
    id: `${stamp}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    model,
    system: '',
    created: now.toISOString(),
    updated: now.toISOString(),
    messages: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0, requests: 0 },
  };
}

export function saveSession(session) {
  session.updated = new Date().toISOString();
  writeJson(path.join(SESSIONS_DIR, `${session.id}.json`), session);
}

export function loadSession(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error(`對話 id 格式不對：${id}`);
  const session = readJson(path.join(SESSIONS_DIR, `${id}.json`), null);
  if (!session) throw new Error(`找不到對話紀錄 ${id}（openrouter sessions 看清單）`);
  return session;
}

// 由新到舊
export function listSessions() {
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const sessions = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      sessions.push(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8')));
    } catch {
      // 壞掉的紀錄檔略過，不讓整份清單失敗
    }
  }
  return sessions.sort((a, b) => (a.updated < b.updated ? 1 : -1));
}

export function readModelsCache() {
  const cache = readJson(MODELS_CACHE, null);
  return cache && Date.now() - cache.fetchedAt < MODELS_TTL_MS ? cache.data : null;
}

export function writeModelsCache(data) {
  writeJson(MODELS_CACHE, { fetchedAt: Date.now(), data });
}
