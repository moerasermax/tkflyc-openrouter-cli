// 唯讀工具：讓模型查看這台電腦上的檔案。
// 只有讀的能力——沒有寫入、刪除或執行指令的工具，唯讀由工具層保證，不靠模型自律。
// 可讀範圍（scope）：'all' 是所有磁碟、'cwd' 只限工作資料夾；相對路徑一律以工作資料夾為準。
// 讀到的內容會送到 OpenRouter 與模型供應商，所以範圍內仍一律拒讀：敏感檔案（.env、私鑰等）、
// 使用者目錄下放憑證與設定的資料夾（AppData、.ssh…）、Windows 系統資料夾，以及呼叫端指定的位置
// （CLI 自己的資料夾，裡面有 API key）。路徑先解析成作業系統的真實路徑（解開連結與 8.3 短檔名）再判斷。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '__pycache__', '.venv', '.vs', '.idea', '$Recycle.Bin', 'System Volume Information']);
const SECRET_FILES = [
  /^\.env(\.(?!example$|sample$|template$)[\w.-]+)?$/i,
  /\.(pem|key|pfx|p12|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|netrc|pgpass|git-credentials)$/i,
  /^_netrc$/i,
];
// 使用者目錄下一律拒讀的資料夾與檔案（放憑證、登入資訊與各工具設定的地方）
const SENSITIVE_HOME_DIRS = ['AppData', '.ssh', '.config', '.local', '.claude', '.codex', '.aws', '.docker', '.gnupg', '.azure', '.kube'];
const SENSITIVE_HOME_FILES = ['.claude.json'];
const DEFAULT_READ_LINES = 400;
const MAX_READ_LINES = 1000;
const MAX_OUTPUT_CHARS = 60_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_ENTRIES = 20_000; // search 要讀檔案內容，掃描量壓低
const MAX_FIND_ENTRIES = 200_000; // find_files 只比對名稱，可以掃比較多
const MAX_WALK_MS = 15_000; // 不論掃了多少，超過這個時間就停，避免整個磁碟掃很久
const MAX_LIST_ENTRIES = 400;
const MAX_SEARCH_RESULTS = 100;
const MAX_FIND_RESULTS = 200;

class ToolError extends Error {}

const PATH_HINT = 'Relative paths are resolved from the working folder; absolute paths such as "D:\\Projects\\app" can point anywhere within the readable scope.';

// 給模型看的工具定義（OpenAI function calling 格式）
export const DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: `List files and folders in a directory. Use this first to understand a layout. ${PATH_HINT}`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path. Default "." (the working folder). A drive root like "D:\\" is allowed.' },
          depth: { type: 'integer', description: 'How many levels to expand, 1-4. Default 1.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: `Read a text file. Returns numbered lines. For large files, read in chunks with start_line. ${PATH_HINT}`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          start_line: { type: 'integer', description: 'First line to read (1-based). Default 1.' },
          max_lines: { type: 'integer', description: `How many lines to read, up to ${MAX_READ_LINES}. Default ${DEFAULT_READ_LINES}.` },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description: `Search file contents (like grep). Returns matching lines as path:line: text. Searching a whole drive is slow and may only cover part of it; narrow the path first. ${PATH_HINT}`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression or plain text to search for.' },
          path: { type: 'string', description: 'File or directory to search in. Default ".".' },
          file_glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.cs" or "src/**/*.{js,ts}".' },
          ignore_case: { type: 'boolean', description: 'Case-insensitive search. Default true.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: `Find files by name or path glob, e.g. "*.sln", "**/config/*.xml". ${PATH_HINT}`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob. Without "/" it matches file names; with "/" it matches paths relative to the search directory.' },
          path: { type: 'string', description: 'Directory to search in. Default ".". A drive root like "E:\\" is allowed.' },
        },
        required: ['pattern'],
      },
    },
  },
];

// 作業系統原生的真實路徑：解開 symlink／junction，Windows 上也會把 8.3 短檔名（APPDAT~1）還原成完整名稱
function realpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw err;
    return fs.realpathSync(p);
  }
}

function realOrResolve(p) {
  try {
    return realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export function listDrives() {
  if (process.platform !== 'win32') return ['/'];
  const drives = [];
  for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      fs.accessSync(root);
      drives.push(root);
    } catch {
      // 沒有這個磁碟（或光碟機裡沒有片）
    }
  }
  return drives;
}

function sensitiveLocations(drives) {
  const home = os.homedir();
  const list = [...SENSITIVE_HOME_DIRS, ...SENSITIVE_HOME_FILES].map((name) => path.join(home, name));
  if (process.env.SystemRoot) list.push(process.env.SystemRoot);
  for (const drive of drives) list.push(path.join(drive, '$Recycle.Bin'), path.join(drive, 'System Volume Information'));
  return list;
}

// scope：'all' 開放所有磁碟，'cwd' 只開放工作資料夾；deny：另外要拒讀的位置
export function createContext(cwd, { deny = [], scope = 'cwd' } = {}) {
  const root = realOrResolve(cwd);
  const drives = listDrives();
  return {
    root,
    scope,
    roots: scope === 'all' ? drives.map(realOrResolve) : [root],
    deny: [...deny, ...sensitiveLocations(drives)].map(realOrResolve),
  };
}

const HANDLERS = { list_dir: listDir, read_file: readFile, search, find_files: findFiles };
export const TOOL_NAMES = Object.keys(HANDLERS);

// 回傳 { content: 交給模型的結果, summary: 顯示給使用者的一行摘要 }；錯誤也以結果回給模型，讓它自己修正
export function runTool(ctx, name, rawArgs) {
  const handler = HANDLERS[name];
  if (!handler) return fail(name, `沒有這個工具（可用：${TOOL_NAMES.join('、')}）`);
  let args;
  try {
    args = typeof rawArgs === 'string' ? (rawArgs.trim() ? JSON.parse(rawArgs) : {}) : (rawArgs ?? {});
  } catch {
    return fail(name, '參數不是合法的 JSON');
  }
  try {
    return handler(ctx, args);
  } catch (err) {
    return fail(name, err instanceof ToolError ? err.message : `${err.code ?? ''} ${err.message}`.trim());
  }
}

const fail = (name, message) => ({ content: `錯誤：${message}`, summary: `${name} 失敗：${message}` });

// ── 文字格式的工具呼叫（備援）─────────────────────────────
// Qwen 等模型有時不走標準 tool_calls，而是在內容裡寫
//   <function=read_file><parameter=path>a.txt</parameter></function>
// 或 <tool_call>{"name":"read_file","arguments":{...}}</tool_call>；只接受已知的工具名稱。

const XML_CALL = /<function=([\w-]+)>([\s\S]*?)<\/function>/g;
const XML_PARAM = /<parameter=([\w-]+)>([\s\S]*?)<\/parameter>/g;
const JSON_CALL = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;

export function parseTextToolCalls(text) {
  const calls = [];
  const add = (name, args) => calls.push({ id: `text_call_${Date.now()}_${calls.length}`, name, arguments: JSON.stringify(args) });
  for (const [, name, body] of text.matchAll(XML_CALL)) {
    if (!HANDLERS[name]) continue;
    const args = {};
    for (const [, key, value] of body.matchAll(XML_PARAM)) args[key] = value.trim();
    add(name, args);
  }
  if (calls.length) return calls;
  for (const [, json] of text.matchAll(JSON_CALL)) {
    try {
      const parsed = JSON.parse(json);
      if (HANDLERS[parsed.name]) add(parsed.name, parsed.arguments ?? {});
    } catch {
      // 不是合法 JSON 就不當成工具呼叫
    }
  }
  return calls;
}

export function stripTextToolCalls(text) {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').replace(XML_CALL, '').trim();
}

// ── 路徑與檔案 ───────────────────────────────────────────

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

const isDenied = (ctx, abs) => ctx.deny.some((loc) => isInside(abs, loc));
const isSecret = (name) => SECRET_FILES.some((re) => re.test(name));

// 工作資料夾內顯示相對路徑，其他地方顯示絕對路徑
const displayPath = (ctx, abs) => (isInside(abs, ctx.root) ? path.relative(ctx.root, abs).split(path.sep).join('/') || '.' : abs);
const dirLabel = (shown) => (shown === '.' ? './' : /[\\/]$/.test(shown) ? shown : `${shown}${shown.includes('\\') ? '\\' : '/'}`);

// 解析成真實路徑後，必須在可讀範圍內、且不在拒讀位置
function resolvePath(ctx, p = '.') {
  const input = String(p || '.');
  let real;
  try {
    real = realpath(path.resolve(ctx.root, input));
  } catch {
    throw new ToolError(`找不到：${input}`);
  }
  if (!ctx.roots.some((root) => isInside(real, root))) {
    throw new ToolError(ctx.scope === 'all' ? `不在可讀範圍內：${input}` : `只能讀取工作資料夾內的檔案：${input}`);
  }
  if (isDenied(ctx, real)) throw new ToolError(`這個位置不開放讀取（敏感位置）：${input}`);
  return { abs: real, shown: displayPath(ctx, real) };
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const toInt = (value, fallback, min, max) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const countReplacement = (s) => s.split('\uFFFD').length - 1;

// 依 BOM 辨識 UTF-16；含 NUL 位元組視為二進位（回傳 null）；UTF-8 解出亂碼時改試 Big5／GBK，取亂碼最少的
function decodeText(buf) {
  try {
    if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'UTF-16LE' };
    if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'UTF-16BE' };
  } catch {
    // 不支援的編碼就當一般檔案處理
  }
  if (buf.subarray(0, 8000).includes(0)) return null;
  let best = { text: new TextDecoder('utf-8').decode(buf), encoding: 'UTF-8' };
  if (!best.text.includes('\uFFFD')) return best;
  for (const [label, encoding] of [['big5', 'Big5'], ['gbk', 'GBK']]) {
    try {
      const text = new TextDecoder(label).decode(buf);
      if (countReplacement(text) < countReplacement(best.text)) best = { text, encoding };
    } catch {
      // 這個 Node 沒有該編碼就跳過
    }
  }
  return best;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 支援 *、**、?、{a,b}；不含 / 時比對檔名，含 / 時比對相對路徑（不分大小寫）
function globMatcher(pattern) {
  const p = String(pattern).replace(/\\/g, '/');
  let src = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          src += '(?:.*/)?';
        } else {
          src += '.*';
        }
      } else {
        src += '[^/]*';
      }
    } else if (c === '?') {
      src += '[^/]';
    } else if (c === '{' && p.indexOf('}', i) > i) {
      const end = p.indexOf('}', i);
      src += `(?:${p.slice(i + 1, end).split(',').map(escapeRegex).join('|')})`;
      i = end;
    } else {
      src += escapeRegex(c);
    }
  }
  const re = new RegExp(`^${src}$`, 'i');
  return p.includes('/') ? (rel) => re.test(rel) : (rel) => re.test(rel.split('/').pop());
}

// 遞迴列出檔案：略過 SKIP_DIRS、拒讀位置與連結；超過數量或時間上限就停並設 state.truncated。
// 廣度優先（先掃淺層）：掃整個磁碟時就算中途停下，也已經看過各個頂層資料夾，不會卡在某個很深的目錄裡
function* walkFiles(ctx, base, state, maxEntries) {
  const deadline = Date.now() + MAX_WALK_MS;
  const queue = [base];
  let seen = 0;
  for (let next = 0; next < queue.length; next++) {
    // 每個資料夾都檢查時間：大量空資料夾不會累積項目數，只靠下面的項目數檢查會超時
    if (Date.now() > deadline) {
      state.truncated = true;
      return;
    }
    const dir = queue[next];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++seen > maxEntries || (seen % 200 === 0 && Date.now() > deadline)) {
        state.truncated = true;
        return;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !isDenied(ctx, abs)) queue.push(abs);
      } else if (entry.isFile() && !isDenied(ctx, abs)) {
        yield abs;
      }
    }
  }
}

// ── 工具本體 ─────────────────────────────────────────────

function listDir(ctx, args) {
  const { abs, shown } = resolvePath(ctx, args.path);
  if (!fs.statSync(abs).isDirectory()) throw new ToolError(`${shown} 不是資料夾，請改用 read_file`);
  const depth = toInt(args.depth, 1, 1, 4);
  const lines = [];
  let truncated = false;
  const visit = (dir, level) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      lines.push(`${'  '.repeat(level)}（無法讀取：${err.code}）`);
      return;
    }
    entries.sort((a, b) => b.isDirectory() - a.isDirectory() || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      const indent = '  '.repeat(level);
      const child = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        lines.push(`${indent}${entry.name}（連結，不展開）`);
      } else if (entry.isDirectory()) {
        const skipped = SKIP_DIRS.has(entry.name) || isDenied(ctx, child);
        lines.push(`${indent}${entry.name}/${skipped ? '（略過）' : ''}`);
        if (!skipped && level + 1 < depth) visit(child, level + 1);
      } else {
        let size = '';
        try {
          size = formatSize(fs.statSync(child).size);
        } catch {
          // 讀不到大小（例如系統鎖住的檔案）就不顯示
        }
        const secret = isSecret(entry.name) || isDenied(ctx, child);
        lines.push(`${indent}${entry.name}  ${size}${secret ? '（敏感檔案，不開放讀取）' : ''}`);
      }
    }
  };
  visit(abs, 0);
  if (truncated) lines.push('…項目太多，已截斷；請指定子資料夾或降低 depth');
  return {
    content: `資料夾 ${dirLabel(shown)}（展開 ${depth} 層）\n${lines.join('\n') || '（空資料夾）'}`,
    summary: `列出 ${dirLabel(shown)}（${lines.length} 項）`,
  };
}

function readFile(ctx, args) {
  if (!args.path) throw new ToolError('缺少 path');
  const { abs, shown } = resolvePath(ctx, args.path);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new ToolError(`${shown} 是資料夾，請改用 list_dir`);
  if (isSecret(path.basename(abs))) throw new ToolError(`${shown} 是敏感檔案（例如 .env、私鑰），不開放讀取`);
  if (stat.size > MAX_FILE_BYTES) throw new ToolError(`${shown} 太大（${formatSize(stat.size)}），請先用 search 找出相關行號`);
  if (stat.size === 0) return { content: `檔案 ${shown} 是空的`, summary: `讀取 ${shown}（空檔案）` };
  const decoded = decodeText(fs.readFileSync(abs));
  if (!decoded) throw new ToolError(`${shown} 看起來是二進位檔（${formatSize(stat.size)}），無法以文字讀取`);

  const all = decoded.text.split(/\r?\n/);
  if (all.length > 1 && all.at(-1) === '') all.pop();
  const start = toInt(args.start_line, 1, 1, all.length);
  const want = toInt(args.max_lines, DEFAULT_READ_LINES, 1, MAX_READ_LINES);
  const out = [];
  let chars = 0;
  let end = start - 1;
  for (let i = start - 1; i < Math.min(all.length, start - 1 + want); i++) {
    const line = all[i].length > 500 ? `${all[i].slice(0, 500)}…（此行過長，已截斷）` : all[i];
    if (chars + line.length > MAX_OUTPUT_CHARS) break;
    out.push(`${i + 1}\t${line}`);
    chars += line.length + 8;
    end = i + 1;
  }
  const encoding = decoded.encoding === 'UTF-8' ? '' : `，編碼 ${decoded.encoding}`;
  let content = `檔案 ${shown}（共 ${all.length} 行，顯示第 ${start}–${end} 行${encoding}）\n${out.join('\n')}`;
  if (end < all.length) content += `\n…還有 ${all.length - end} 行；用 start_line=${end + 1} 繼續讀`;
  return { content, summary: `讀取 ${shown}（第 ${start}–${end} 行，共 ${all.length} 行${encoding}）` };
}

function search(ctx, args) {
  if (!args.pattern) throw new ToolError('缺少 pattern');
  const { abs, shown } = resolvePath(ctx, args.path);
  const flags = args.ignore_case === false || args.ignore_case === 'false' ? '' : 'i';
  let re;
  try {
    re = new RegExp(args.pattern, flags);
  } catch {
    re = new RegExp(escapeRegex(args.pattern), flags); // 不是合法的正規表示式就當純文字找
  }
  const glob = args.file_glob ? globMatcher(args.file_glob) : null;
  const state = { truncated: false };
  const isDir = fs.statSync(abs).isDirectory();
  const results = [];
  let scanned = 0;
  let full = false;

  scan: for (const file of isDir ? walkFiles(ctx, abs, state, MAX_SEARCH_ENTRIES) : [abs]) {
    if (isSecret(path.basename(file))) continue;
    if (glob && isDir && !glob(path.relative(abs, file).split(path.sep).join('/'))) continue;
    let decoded;
    try {
      if (fs.statSync(file).size > MAX_SEARCH_FILE_BYTES) continue;
      decoded = decodeText(fs.readFileSync(file));
    } catch {
      continue;
    }
    if (!decoded) continue;
    scanned++;
    const lines = decoded.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      results.push(`${displayPath(ctx, file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      if (results.length >= MAX_SEARCH_RESULTS) {
        full = true;
        break scan;
      }
    }
  }
  const notes = [
    full && `已達上限 ${MAX_SEARCH_RESULTS} 筆`,
    state.truncated && '範圍太大，只掃了一部分；請縮小到更精確的資料夾',
  ].filter(Boolean);
  const header = `搜尋「${args.pattern}」於 ${dirLabel(shown)}（掃過 ${scanned} 個文字檔，${results.length} 筆${notes.length ? `；${notes.join('；')}` : ''}）`;
  return {
    content: `${header}\n${results.join('\n') || '沒有符合的結果'}`,
    summary: `搜尋「${args.pattern}」於 ${dirLabel(shown)}（${results.length} 筆${state.truncated ? '，只掃了一部分' : ''}）`,
  };
}

function findFiles(ctx, args) {
  if (!args.pattern) throw new ToolError('缺少 pattern');
  const { abs, shown } = resolvePath(ctx, args.path);
  if (!fs.statSync(abs).isDirectory()) throw new ToolError(`${shown} 不是資料夾`);
  const match = globMatcher(args.pattern);
  const state = { truncated: false };
  const hits = [];
  for (const file of walkFiles(ctx, abs, state, MAX_FIND_ENTRIES)) {
    if (!match(path.relative(abs, file).split(path.sep).join('/'))) continue;
    let size = '';
    try {
      size = formatSize(fs.statSync(file).size);
    } catch {
      // 讀不到大小就不顯示
    }
    hits.push(`${displayPath(ctx, file)}  ${size}`);
    if (hits.length >= MAX_FIND_RESULTS) break;
  }
  hits.sort();
  const notes = [
    hits.length >= MAX_FIND_RESULTS && `已達上限 ${MAX_FIND_RESULTS} 個`,
    state.truncated && '範圍太大，只掃了一部分；請縮小到更精確的資料夾',
  ].filter(Boolean);
  return {
    content: `找檔案「${args.pattern}」於 ${dirLabel(shown)}（${hits.length} 個${notes.length ? `；${notes.join('；')}` : ''}）\n${hits.join('\n') || '沒有符合的檔案'}`,
    summary: `找檔案「${args.pattern}」於 ${dirLabel(shown)}（${hits.length} 個${state.truncated ? '，只掃了一部分' : ''}）`,
  };
}
