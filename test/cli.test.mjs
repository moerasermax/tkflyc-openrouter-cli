// CLI 端到端測試：npm test
// 以 node --import test/mock-fetch.mjs 啟動 bin/openrouter.js，不連網、不花錢；
// 每個測試用自己的暫存資料位置（OPENROUTER_CLI_HOME），不碰使用者真正的 key 與對話紀錄。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLI, FAKE_KEY, MOCK, makeProject, removeDir, tempDir } from './fixture.mjs';

const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
let base;
let fx;
let homes = 0;
before(() => {
  base = tempDir('orc-cli-');
  fx = makeProject(base);
});
after(() => removeDir(base));

function newHome(config) {
  const home = path.join(base, `home-${++homes}`);
  fs.mkdirSync(home);
  if (config) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  return home;
}

function buildEnv(home, extra) {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    MOCK_MODE: 'plain',
    OPENROUTER_API_KEY: FAKE_KEY,
    OPENROUTER_CLI_HOME: home,
    MOCK_LOG: path.join(home, 'requests.jsonl'),
    ...extra,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

const readRequests = (home) => {
  const log = path.join(home, 'requests.jsonl');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

const readSessions = (home) => {
  const dir = path.join(home, 'sessions');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
};

const roles = (session) => session.messages.map((m) => m.role + (m.tool_calls ? '(tool_calls)' : '')).join(' → ');

function cli(args, { home = newHome(), env = {}, input = '' } = {}) {
  const r = spawnSync(process.execPath, ['--import', MOCK, CLI, ...args], {
    cwd: fx.root,
    input,
    encoding: 'utf8',
    timeout: 30_000,
    env: buildEnv(home, env),
  });
  return { code: r.status, out: r.stdout, err: r.stderr, home, requests: readRequests(home) };
}

// 互動對話：每 400ms 餵一行，模擬使用者逐行輸入
function repl(args, lines, { home = newHome(), env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', MOCK, CLI, 'chat', ...args], {
      cwd: fx.root,
      env: buildEnv(home, { MOCK_TTY: '1', ...env }),
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.stdin.on('error', () => {}); // CLI 先結束時，後續寫入會 EPIPE
    let next = 0;
    const timer = setInterval(() => {
      if (next < lines.length) child.stdin.write(`${lines[next++]}\n`);
      else {
        clearInterval(timer);
        child.stdin.end();
      }
    }, 400);
    const killer = setTimeout(() => child.kill(), 30_000);
    child.on('close', (code) => {
      clearInterval(timer);
      clearTimeout(killer);
      resolve({ code, out, home, requests: readRequests(home) });
    });
  });
}

describe('基本指令', () => {
  test('help 印出實際的資料位置；不認得的指令回 exit 2', () => {
    const help = cli(['help']);
    assert.equal(help.code, 0);
    assert.ok(help.out.includes(`資料位置：${help.home}`), help.out);
    const bad = cli(['modles']);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /不認得的指令：modles/);
  });

  test('models 列出價格與工具欄；credits 印出餘額', () => {
    const models = cli(['models', 'qwen']);
    assert.match(models.out, /工具/);
    assert.match(models.out, /qwen\/qwen3\.7-max +262K +\$1\.60 +\$6\.40 +✓/);
    assert.match(cli(['credits']).out, /帳戶餘額：\$8\.7700/);
  });

  test('use：符合多個時報錯並列出；只符合一個時直接設成預設', () => {
    const many = cli(['use', 'qwen']);
    assert.equal(many.code, 1);
    assert.match(many.err, /符合 3 個模型/);
    const one = cli(['use', 'tiny']);
    assert.equal(one.code, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(one.home, 'config.json'), 'utf8')).model, 'qwen/qwen3.7-tiny');
  });
});

describe('API key', () => {
  test('只存進一個 ? 這類輸入：格式檢查當場擋下，不存檔', () => {
    const r = cli(['key', '--stdin'], { input: '?', env: { OPENROUTER_API_KEY: undefined } });
    assert.equal(r.code, 1);
    assert.match(r.err, /開頭不是 sk-or-（收到 1 個字元）/);
    assert.ok(!fs.existsSync(path.join(r.home, 'config.json')));
  });

  test('驗證不過不存檔；驗證通過才存，--show 只顯示遮罩', () => {
    const rejected = cli(['key', '--stdin'], { input: FAKE_KEY, env: { OPENROUTER_API_KEY: undefined, MOCK_MODE: '401' } });
    assert.equal(rejected.code, 1);
    assert.match(rejected.err, /User not found/);
    assert.match(rejected.err, /key 沒有存檔/);
    assert.ok(!fs.existsSync(path.join(rejected.home, 'config.json')));

    const saved = cli(['key', '--stdin'], { input: FAKE_KEY, env: { OPENROUTER_API_KEY: undefined } });
    assert.equal(saved.code, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(saved.home, 'config.json'), 'utf8')).apiKey, FAKE_KEY);
    const shown = cli(['key', '--show'], { home: saved.home, env: { OPENROUTER_API_KEY: undefined } });
    assert.match(shown.out, /sk-or-v1-…0000（73 字元）/);
    assert.ok(!shown.out.includes(FAKE_KEY));
  });
});

describe('ask', () => {
  test('stdout 只有回答，思考提示與用量走 stderr；預設繁中＋讀檔規則；存成對話紀錄', () => {
    const r = cli(['ask', '嗨']);
    assert.equal(r.code, 0);
    assert.equal(r.out, `你好，世界🌏（${DEFAULT_MODEL}，2 則訊息，工具結果 0 筆：無）\n`);
    assert.match(r.err, /（思考中…）/);
    assert.match(r.err, /\[10 入／3 出 tokens，\$0\.000010\]/);
    const system = r.requests[0].messages[0].content;
    assert.match(system, /繁體中文/);
    assert.match(system, /不要反問路徑/);
    assert.ok(system.includes(fx.root), '系統提示要帶工作資料夾');
    assert.equal(r.requests[0].tools.length, 4);
    assert.equal(roles(readSessions(r.home)[0]), 'user → assistant');
  });

  test('pipe 進來的內容接在問題後面', () => {
    const r = cli(['ask', '摘要'], { input: '第一行\n第二行' });
    assert.equal(r.requests[0].messages.at(-1).content, '摘要\n\n第一行\n第二行');
  });

  test('--no-agent：不帶工具，系統提示只剩語言要求', () => {
    const r = cli(['ask', '--no-agent', '嗨']);
    assert.equal(r.requests[0].tools, undefined);
    assert.equal(r.requests[0].messages[0].content, '請一律使用繁體中文（台灣用語）回答。');
  });

  test('中途出錯：已印出的部分換行、回 exit 1、不存紀錄', () => {
    const r = cli(['ask', '嗨'], { env: { MOCK_MODE: 'midstream' } });
    assert.equal(r.code, 1);
    assert.equal(r.out, '部分\n');
    assert.match(r.err, /串流中途出錯：Provider disconnected/);
    assert.match(r.err, /上游模型供應商出錯/);
    assert.equal(readSessions(r.home).length, 0);
  });

  test('模型回空白：警告並回 exit 1', () => {
    const r = cli(['ask', '嗨'], { env: { MOCK_MODE: 'empty' } });
    assert.equal(r.code, 1);
    assert.match(r.err, /finish_reason=length/);
  });

  test('401：顯示 OpenRouter 原文與處理方法', () => {
    const r = cli(['ask', '嗨'], { env: { MOCK_MODE: '401' } });
    assert.equal(r.code, 1);
    assert.match(r.err, /HTTP 401：User not found\./);
    assert.match(r.err, /openrouter key 重新設定/);
  });
});

describe('agent 迴圈', () => {
  test('分段送來的工具呼叫接回完整參數、結果交回模型、紀錄保留整段往返', () => {
    const r = cli(['ask', '-m', 'mock/model', '分析'], { env: { MOCK_MODE: 'agent' } });
    assert.equal(r.code, 0);
    assert.equal(r.requests.length, 2);
    const assistant = r.requests[1].messages.find((m) => m.tool_calls);
    assert.deepEqual(
      assistant.tool_calls.map((c) => [c.id, c.function.name, c.function.arguments]),
      [
        ['call_1', 'read_file', '{"path":"README.md"}'],
        ['call_2', 'read_file', '{"path":"../outside/secret.txt"}'],
      ],
    );
    const results = r.requests[1].messages.filter((m) => m.role === 'tool');
    assert.match(results[0].content, /^檔案 README\.md/);
    assert.match(results[1].content, /OUTSIDE SECRET/); // 預設所有磁碟：工作資料夾外讀得到
    assert.match(r.err, /↳ 讀取 README\.md/);
    assert.match(r.err, /工具 2 次/);
    assert.equal(roles(readSessions(r.home)[0]), 'user → assistant(tool_calls) → tool → tool → assistant');
  });

  test('agentScope: cwd 時，工作資料夾外又讀不到', () => {
    const r = cli(['ask', '-m', 'mock/model', '分析'], { home: newHome({ agentScope: 'cwd' }), env: { MOCK_MODE: 'agent' } });
    const results = r.requests[1].messages.filter((m) => m.role === 'tool');
    assert.match(results[1].content, /^錯誤：只能讀取工作資料夾內/);
  });

  test('文字格式（XML）工具呼叫走備援解析', () => {
    const r = cli(['ask', '-m', 'mock/model', '讀 README'], { env: { MOCK_MODE: 'xml' } });
    assert.equal(r.code, 0);
    assert.match(r.err, /備援解析/);
    assert.match(r.out, /工具結果 1 筆：檔案 README\.md/);
  });

  test('模型清單標示不能用工具：這一輪退回一般聊天', () => {
    const r = cli(['ask', '-m', 'mock/notools', '嗨'], { env: { MOCK_MODE: 'agent' } });
    assert.match(r.err, /不支援工具呼叫/);
    assert.equal(r.requests[0].tools, undefined);
  });

  test('供應商回 404 拒絕工具：自動改用一般聊天重試一次', () => {
    const r = cli(['ask', '-m', 'mock/model', '嗨'], { env: { MOCK_MODE: '404tools' } });
    assert.equal(r.code, 0);
    assert.match(r.err, /供應商不支援工具呼叫/);
    assert.equal(r.requests.length, 2);
    assert.ok(r.requests[0].tools && !r.requests[1].tools);
  });
});

describe('互動對話', () => {
  test('/model 搜尋並用編號切換、並列新舊價格；/agent off 之後不再帶工具', async () => {
    const r = await repl([], ['/model', 'qwen', '1', '嗨', '/agent off', '嗨', '/cost', '/exit']);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.includes(`${DEFAULT_MODEL} → qwen/qwen3.7-max`), r.out);
    assert.match(r.out, /原本：入 \$0\.15／出 \$0\.60/);
    assert.match(r.out, /現在：入 \$1\.60／出 \$6\.40/);
    assert.match(r.out, /這次對話：2 次請求/);
    assert.equal(r.requests.length, 2);
    assert.equal(r.requests[0].model, 'qwen/qwen3.7-max');
    assert.equal(r.requests[0].tools.length, 4);
    assert.equal(r.requests[1].tools, undefined);
  });
});
