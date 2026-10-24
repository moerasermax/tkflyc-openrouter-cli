// OpenRouter HTTP 呼叫。錯誤一律帶 HTTP 狀態與 OpenRouter 原文，再附上可以怎麼處理。
const BASE_URL = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

const HINTS = {
  400: '請求格式不被接受，常見原因是模型 id 打錯',
  401: 'key 無效、已撤銷或沒存好，執行 openrouter key 重新設定',
  402: '額度不足，到 https://openrouter.ai/settings/credits 儲值，或改用 :free 模型',
  403: '被拒絕（內容審核或 key 權限不足）',
  404: '找不到模型或沒有可用的供應商；用 openrouter models <關鍵字> 確認 id，免費模型另需檢查 https://openrouter.ai/settings/privacy',
  408: '請求逾時，稍後再試',
  429: '請求太頻繁（免費模型限流較嚴），稍後再試',
  502: '上游模型供應商出錯，稍後再試或換模型',
  503: '目前沒有可用的供應商，稍後再試或換模型',
};

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function withHint(status, message) {
  const hint = HINTS[status];
  return new ApiError(status, hint ? `${message}\n  → ${hint}` : message);
}

async function request(path, { key, method = 'GET', body, signal, timeoutMs = 30_000 } = {}) {
  // OpenRouter 用這兩個標頭標示呼叫來源的 app
  const headers = {
    'HTTP-Referer': 'https://github.com/moerasermax/tkflyc-openrouter-cli',
    'X-Title': '@tkflyc/openrouter-cli',
  };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body) headers['Content-Type'] = 'application/json';

  // timeoutMs 只限制「等到回應標頭」的時間，串流開始後不再計時；signal 給呼叫端中斷用（Ctrl+C）
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new ApiError(0, `等候 OpenRouter 回應逾時（${timeoutMs / 1000} 秒）`)),
    timeoutMs,
  );
  signal?.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });

  let res;
  try {
    res = await fetch(BASE_URL + path, { method, headers, body: body && JSON.stringify(body), signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.reason instanceof ApiError) throw ctrl.signal.reason;
    if (signal?.aborted) throw err;
    throw new ApiError(0, `連不上 OpenRouter：${err.cause?.code || err.cause?.message || err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try {
      detail = JSON.parse(text)?.error?.message || text;
    } catch {
      // 不是 JSON 就用原文
    }
    throw withHint(res.status, `HTTP ${res.status}：${detail || res.statusText}`);
  }
  return res;
}

// 這支要帶 key 才會成功，所以拿來驗證 key；/models 不帶 key 也會回 200，驗不出 key 好壞
export async function getKeyInfo(key) {
  const res = await request('/key', { key });
  return (await res.json()).data ?? {};
}

export async function getCredits(key) {
  const res = await request('/credits', { key });
  return (await res.json()).data ?? {};
}

export async function listModels() {
  const res = await request('/models');
  return (await res.json()).data ?? [];
}

// 回傳 { text, usage, model, finish }；被 signal 中斷時 finish 為 'aborted'，text 保留已收到的部分
export async function chat({ key, model, messages, stream = true, signal, onDelta, onReasoning }) {
  const body = { model, messages, stream, usage: { include: true } };
  const res = await request('/chat/completions', {
    key,
    method: 'POST',
    body,
    signal,
    timeoutMs: stream ? 60_000 : 300_000,
  });

  if (!stream) {
    const json = await res.json();
    if (json.error) throw withHint(json.error.code, `模型回傳錯誤：${json.error.message}`);
    const choice = json.choices?.[0] ?? {};
    const message = choice.message ?? {};
    if (message.reasoning) onReasoning?.(message.reasoning);
    if (message.content) onDelta?.(message.content);
    return {
      text: message.content ?? '',
      usage: json.usage ?? null,
      model: json.model ?? model,
      finish: choice.finish_reason ?? null,
    };
  }

  const out = { text: '', usage: null, model, finish: null };
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        // 只處理 data: 行；": OPENROUTER PROCESSING" 這類註解行是保持連線用的
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return out;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.error) throw withHint(event.error.code, `串流中途出錯：${event.error.message}`);
        if (event.model) out.model = event.model;
        if (event.usage) out.usage = event.usage;
        const choice = event.choices?.[0];
        if (choice?.finish_reason) out.finish = choice.finish_reason;
        const delta = choice?.delta ?? {};
        if (delta.reasoning) onReasoning?.(delta.reasoning);
        if (delta.content) {
          out.text += delta.content;
          onDelta?.(delta.content);
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) return { ...out, finish: 'aborted' };
    throw err;
  }
  return out;
}
