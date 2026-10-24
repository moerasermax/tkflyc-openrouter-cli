// 唯讀工具的單元測試：npm test
// 整碟掃描的時限測試很慢（各約 15 秒），預設略過；要跑時先設環境變數 OPENROUTER_TEST_SLOW=1。
// 涉及使用者真實敏感位置的檢查只驗「讀不到」，失敗訊息只帶工具的一行摘要，不帶檔案內容。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tools from '../src/tools.js';
import { makeProject, removeDir, shortPath, tempDir, write } from './fixture.mjs';

let base;
let fx;
before(() => {
  base = tempDir('orc-tools-');
  fx = makeProject(base);
});
after(() => removeDir(base));

const run = (ctx, name, args) => tools.runTool(ctx, name, JSON.stringify(args));
const denied = (result) => result.content.startsWith('錯誤：') && result.content.includes('敏感');

describe('只開放工作資料夾（scope: cwd）', () => {
  let ctx;
  before(() => {
    ctx = tools.createContext(fx.root, { deny: [path.join(fx.root, 'data-deny'), fx.deny] });
  });

  test('list_dir 標出略過的資料夾、敏感檔與連結', () => {
    const { content } = run(ctx, 'list_dir', { path: '.', depth: 2 });
    assert.match(content, /node_modules\/（略過）/);
    assert.match(content, /\.env +\S+ B（敏感檔案/);
    assert.match(content, /link（連結，不展開）/);
    assert.match(content, /data-deny\/（略過）/);
    assert.doesNotMatch(content, /config\.json/);
  });

  test('read_file 讀一般檔案與分段讀大檔', () => {
    assert.match(run(ctx, 'read_file', { path: 'README.md' }).content, /MOCK-README-MARKER/);
    const first = run(ctx, 'read_file', { path: 'src/server.cs' }).content;
    assert.match(first, /400\t\/\/ line 400/);
    assert.match(first, /還有 200 行；用 start_line=401/);
    const rest = run(ctx, 'read_file', { path: 'src/server.cs', start_line: 401 }).content;
    assert.match(rest, /600\t\/\/ line 600/);
    assert.doesNotMatch(rest, /還有/);
  });

  test('read_file 自動辨識 Big5 與 UTF-16LE', () => {
    const big5 = run(ctx, 'read_file', { path: 'legacy/big5.txt' });
    assert.match(big5.summary, /Big5/);
    assert.match(big5.content, /黃易群俠傳 伺服器設定/);
    const utf16 = run(ctx, 'read_file', { path: 'legacy/utf16.xml' });
    assert.match(utf16.summary, /UTF-16LE/);
    assert.match(utf16.content, /登入器/);
  });

  test('read_file 擋下敏感檔、二進位檔，.env.example 照讀', () => {
    assert.match(run(ctx, 'read_file', { path: '.env' }).content, /敏感檔案/);
    assert.match(run(ctx, 'read_file', { path: '.env.example' }).content, /SECRET=/);
    assert.match(run(ctx, 'read_file', { path: 'keys/server.pem' }).content, /^錯誤/);
    assert.match(run(ctx, 'read_file', { path: 'bin.dat' }).content, /二進位/);
    assert.match(run(ctx, 'read_file', { path: 'nope.txt' }).content, /找不到/);
  });

  test('../、絕對路徑、junction 都出不去；拒讀位置讀不到', () => {
    const outsideMsg = /只能讀取工作資料夾內/;
    assert.match(run(ctx, 'read_file', { path: '../outside/secret.txt' }).content, outsideMsg);
    assert.match(run(ctx, 'read_file', { path: path.join(fx.outside, 'secret.txt') }).content, outsideMsg);
    assert.match(run(ctx, 'read_file', { path: 'link/secret.txt' }).content, outsideMsg);
    assert.match(run(ctx, 'read_file', { path: 'data-deny/config.json' }).content, /不開放讀取/);
  });

  test('search：找到內容、略過 node_modules／敏感檔／連結／拒讀位置', () => {
    const hit = run(ctx, 'search', { pattern: 'GameServer' }).content;
    assert.match(hit, /src\/server\.cs:300:/);
    assert.doesNotMatch(hit, /node_modules/);
    assert.match(run(ctx, 'search', { pattern: 'GameServer', file_glob: '*.md' }).content, /0 筆/);
    assert.doesNotMatch(run(ctx, 'search', { pattern: '(' }).content, /^錯誤/);
    const secret = run(ctx, 'search', { pattern: 'SECRET' }).content;
    assert.match(secret, /\.env\.example:1/);
    assert.doesNotMatch(secret, /^\.env:1/m);
    assert.match(run(ctx, 'search', { pattern: 'OUTSIDE' }).content, /0 筆/);
    assert.match(run(ctx, 'search', { pattern: 'apiKey' }).content, /0 筆/);
  });

  test('find_files：glob 的 {a,b} 與 **，不跟進連結', () => {
    const cs = run(ctx, 'find_files', { pattern: '*.{cs,md}' }).content;
    assert.match(cs, /src\/server\.cs/);
    assert.match(cs, /README\.md/);
    const txt = run(ctx, 'find_files', { pattern: '**/*.txt' }).content;
    assert.match(txt, /legacy\/big5\.txt/);
    assert.doesNotMatch(txt, /secret\.txt/);
  });

  test('runTool：未知工具與不合法的 JSON 參數回錯誤給模型', () => {
    assert.match(tools.runTool(ctx, 'write_file', '{}').content, /沒有這個工具/);
    assert.match(tools.runTool(ctx, 'read_file', '{bad').content, /不是合法的 JSON/);
  });
});

describe('文字格式工具呼叫的備援解析', () => {
  test('Qwen 的 XML 格式', () => {
    const calls = tools.parseTextToolCalls('先看看\n<function=read_file>\n<parameter=path>\nREADME.md\n</parameter>\n</function>');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'read_file');
    assert.equal(JSON.parse(calls[0].arguments).path, 'README.md');
  });
  test('<tool_call> JSON 格式', () => {
    const calls = tools.parseTextToolCalls('<tool_call>{"name":"list_dir","arguments":{"depth":2}}</tool_call>');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'list_dir');
  });
  test('未知的工具名稱不算，移除後只剩一般文字', () => {
    assert.equal(tools.parseTextToolCalls('<function=write_file><parameter=path>x</parameter></function>').length, 0);
    assert.equal(tools.stripTextToolCalls('先看看\n<function=read_file><parameter=path>a</parameter></function>'), '先看看');
  });
});

describe('所有磁碟（scope: all）', () => {
  let ctx;
  before(() => {
    ctx = tools.createContext(fx.root, { deny: [path.join(fx.root, 'data-deny'), fx.deny], scope: 'all' });
  });

  test('偵測到磁碟，工作資料夾所在的磁碟一定在內', () => {
    const drive = process.platform === 'win32' ? `${fx.root.slice(0, 2).toUpperCase()}\\` : '/';
    assert.ok(ctx.roots.some((r) => r.toUpperCase() === drive), `roots=${ctx.roots.join(',')}`);
  });

  test('可讀工作資料夾外的絕對路徑，並顯示絕對路徑；透過 junction 也讀得到範圍內位置', () => {
    const outsideFile = path.join(fx.outside, 'secret.txt');
    const result = run(ctx, 'read_file', { path: outsideFile });
    assert.match(result.content, /OUTSIDE SECRET/);
    assert.ok(result.summary.includes(outsideFile), result.summary);
    assert.match(run(ctx, 'read_file', { path: 'link/secret.txt' }).content, /OUTSIDE SECRET/);
  });

  test('junction 指向拒讀位置：read_file 與 search 都擋下', () => {
    assert.ok(denied(run(ctx, 'read_file', { path: 'deny-link/config.json' })));
    assert.match(run(ctx, 'search', { pattern: 'apiKey', path: 'deny-link' }).content, /^錯誤/);
  });

  test('使用者目錄的敏感資料夾在 list_dir 標為略過', () => {
    const appData = path.join(os.homedir(), 'AppData');
    if (!fs.existsSync(appData)) return;
    assert.match(run(ctx, 'list_dir', { path: os.homedir() }).content, /AppData\/（略過）/);
  });

  test('真實的敏感檔案讀不到（存在才檢查）', (t) => {
    const cases = [
      path.join(os.homedir(), '.local', 'share', 'ai-cli', 'providers.json'),
      path.join(os.homedir(), '.claude.json'),
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts'),
    ].filter((p) => fs.existsSync(p));
    if (!cases.length) return t.skip('這台電腦沒有這些檔案');
    for (const p of cases) {
      const result = run(ctx, 'read_file', { path: p });
      assert.ok(denied(result), result.summary); // 只帶摘要，不帶內容
    }
  });
});

describe('8.3 短檔名繞不過拒讀', () => {
  test('自建的長檔名拒讀資料夾：用短檔名也讀不到', (t) => {
    // D: 等關閉 8.3 的磁碟產生不了短檔名，所以依序試暫存資料夾與使用者目錄，測完刪掉
    for (const candidate of [os.tmpdir(), os.homedir()]) {
      const holder = fs.mkdtempSync(path.join(candidate, 'orc8dot3-'));
      try {
        const longDir = path.join(holder, 'LongDirectoryNameForShortNameTest');
        write(path.join(longDir, 'secret.txt'), 'SHORT NAME SECRET');
        const short = shortPath(longDir);
        if (!short) continue;
        const ctx = tools.createContext(holder, { deny: [longDir], scope: 'all' });
        const result = run(ctx, 'read_file', { path: path.join(short, 'secret.txt') });
        assert.ok(denied(result), result.summary);
        // 對照：JS 版 realpath 不會還原短檔名，這正是要用原生版本的原因
        t.diagnostic(`短路徑 ${short}；fs.realpathSync 結果 ${fs.realpathSync(short)}；fs.realpathSync.native 結果 ${fs.realpathSync.native(short)}`);
        return;
      } finally {
        removeDir(holder);
      }
    }
    t.skip('暫存資料夾與使用者目錄所在的磁碟都沒有產生 8.3 短檔名');
  });

  test('使用者目錄真實的敏感資料夾：有短檔名的，用短檔名也讀不到', (t) => {
    const ctx = tools.createContext(os.tmpdir(), { scope: 'all' });
    const names = ['AppData', '.ssh', '.config', '.local', '.claude', '.codex', '.aws', '.docker', '.gnupg', '.azure', '.kube'];
    const tried = [];
    for (const name of names) {
      const full = path.join(os.homedir(), name);
      if (!fs.existsSync(full)) continue;
      const short = shortPath(full);
      if (!short) continue;
      tried.push(`${name} → ${path.basename(short)}`);
      assert.ok(denied(run(ctx, 'list_dir', { path: short })), `${short} 沒有被擋下`);
    }
    if (!tried.length) return t.skip('使用者目錄的敏感資料夾都沒有 8.3 短檔名');
    t.diagnostic(`用短檔名測過：${tried.join('、')}`);
  });
});

describe('整碟掃描的時限（OPENROUTER_TEST_SLOW=1 才跑）', { skip: !process.env.OPENROUTER_TEST_SLOW }, () => {
  const ctx = () => tools.createContext(os.tmpdir(), { scope: 'all' });
  const drive = process.platform === 'win32' ? `${os.tmpdir().slice(0, 2)}\\` : '/';

  test('find_files 掃整個磁碟在 20 秒內結束', () => {
    const started = Date.now();
    run(ctx(), 'find_files', { pattern: '*.zzz-not-exist', path: drive });
    assert.ok(Date.now() - started < 20_000, `花了 ${Date.now() - started} ms`);
  });

  test('search 掃使用者目錄在 20 秒內結束', () => {
    const started = Date.now();
    run(ctx(), 'search', { pattern: 'zzz-not-likely-to-exist-zzz', path: os.homedir() });
    assert.ok(Date.now() - started < 20_000, `花了 ${Date.now() - started} ms`);
  });
});
