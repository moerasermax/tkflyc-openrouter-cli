// 測試用：以 node --import 預先載入，取代 global fetch 模擬 OpenRouter，不連網也不花錢。
//   MOCK_MODE = plain（預設）| agent | xml | 404tools | midstream | empty | 401
//   MOCK_LOG  指定時，把每次 /chat/completions 的 request body 逐行寫進去
//   MOCK_TTY=1 讓 CLI 以為 stdin 是終端機，用 pipe 逐行餵輸入來測互動對話
import fs from 'node:fs';

const mode = process.env.MOCK_MODE ?? 'plain';
const log = process.env.MOCK_LOG;
if (process.env.MOCK_TTY) Object.defineProperty(process.stdin, 'isTTY', { value: true });

const withTools = ['tools', 'tool_choice'];
const MODELS = [
  { id: 'mock/model', name: 'Mock', context_length: 128000, pricing: { prompt: '0.0000003', completion: '0.0000012' }, supported_parameters: withTools },
  { id: 'mock/notools', name: 'NoTools', context_length: 32768, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['temperature'] },
  { id: 'qwen/qwen3.7-max', name: 'Qwen 3.7 Max', context_length: 262144, pricing: { prompt: '0.0000016', completion: '0.0000064' }, supported_parameters: withTools },
  { id: 'qwen/qwen3.7-plus', name: 'Qwen 3.7 Plus', context_length: 1000000, pricing: { prompt: '0.00000032', completion: '0.00000128' }, supported_parameters: withTools },
  { id: 'qwen/qwen3.7-tiny', name: 'Qwen 3.7 Tiny', context_length: 32768, pricing: { prompt: '0.00000002', completion: '0.00000005' }, supported_parameters: withTools },
  { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash', context_length: 1048576, pricing: { prompt: '0.00000015', completion: '0.0000006' }, supported_parameters: withTools },
];
const USAGE = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.00001 } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// 每 7 bytes 切一塊送出，故意把 JSON、行尾與多位元組字元切開
function sse(events, { done = true } = {}) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
  const bytes = new TextEncoder().encode(`: OPENROUTER PROCESSING\n\n${text}`);
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (mode === '401') return json({ error: { message: 'User not found.', code: 401 } }, 401);
  if (u.endsWith('/models')) return json({ data: MODELS });
  if (u.endsWith('/key')) return json({ data: { label: 'sk-or-v1-abc...xyz', usage: 1.23, limit: null, is_free_tier: false, usage_daily: 0.1, usage_weekly: 0.5, usage_monthly: 1.2 } });
  if (u.endsWith('/credits')) return json({ data: { total_credits: 10, total_usage: 1.23 } });
  if (!u.endsWith('/chat/completions')) return new Response('not mocked', { status: 500 });

  const body = JSON.parse(init.body);
  if (log) fs.appendFileSync(log, JSON.stringify(body) + '\n');
  const last = body.messages.at(-1);
  const wantsTool = body.tools && last.role !== 'tool';

  if (mode === '404tools' && body.tools) return json({ error: { message: 'No endpoints found that support tool use.', code: 404 } }, 404);
  if (mode === 'midstream') {
    return sse([{ choices: [{ delta: { content: '部分' } }] }, { error: { message: 'Provider disconnected', code: 502 } }], { done: false });
  }
  if (mode === 'empty') return sse([{ choices: [{ delta: {}, finish_reason: 'length' }] }]);
  if (mode === 'agent' && wantsTool) {
    return sse([
      { choices: [{ delta: { content: '我先看看 README。' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"README.md"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"../outside/secret.txt"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      USAGE,
    ]);
  }
  if (mode === 'xml' && wantsTool) {
    return sse([{ choices: [{ delta: { content: '<function=read_file>\n<parameter=path>\nREADME.md\n</parameter>\n</function>' } }] }, USAGE]);
  }
  // 最終回答：帶出模型、收到幾則訊息與各工具結果的第一行，方便測試檢查
  const results = body.messages.filter((m) => m.role === 'tool');
  const firstLines = results.map((m) => m.content.split('\n')[0]).join(' | ');
  return sse([
    { model: body.model, choices: [{ delta: { reasoning: '想一下' } }] },
    { choices: [{ delta: { content: `你好，世界🌏（${body.model}，${body.messages.length} 則訊息，工具結果 ${results.length} 筆：${firstLines || '無'}）` } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    USAGE,
  ]);
};
