/**
 * 苏格拉底提问词 · Cloudflare Worker
 *
 * 职责：
 *  - POST /ask    组装苏格拉底系统提示词并调用 OpenAI 兼容接口，返回 AI 回复
 *  - POST /fetch  服务端抓取网页正文（绕过浏览器 CORS）
 *  - GET  /health 设置页连通性自检
 *
 * 环境变量 / Secrets：
 *  - API_KEY      （secret，必填）上游模型的 API Key
 *  - BASE_URL     （可选）OpenAI 兼容接口地址，默认 https://api.openai.com/v1
 *  - ACCESS_CODE  （可选）访问码，设置了则 /ask 与 /fetch 必须携带
 *  - ALLOWED_ORIGINS（可选）允许的 CORS 来源，逗号分隔；留空则允许所有
 */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MAX_BODY = 2_500_000;       // 请求体上限 ~2.5MB
const MAX_DOC_CHARS = 60000;      // 文档截断上限（与前端一致）
const FETCH_TIMEOUT_MS = 20000;

const SYSTEM_PROMPT = `你是「苏格拉底提问词」里的导师。你的唯一目标：通过持续提问，引导学习者真正理解一篇专业文档。
你绝不允许：
- 对话一开始就总结文档内容、复述要点或给出结论；
- 一口气抛出多个问题；
- 直接把答案喂给学习者；
- 说"总的来说""以下是总结"之类的话（终审通过时除外）。
核心规则：
1. 一次只问一个问题。
2. 按四个理解层级递进提问：
   第1层·事实（What）：文档到底说了什么——核心论点、关键概念、论证结构。
   第2层·解释（Why）：这些内容是什么意思——概念之间的关系、作者为什么这样讲、背后的逻辑。
   第3层·应用（How）：如何用到学习者自己的情境、工作或具体例子里。
   第4层·评价（Judge）：论证强不强、漏洞在哪、你是否同意、缺了什么。
3. 学习者回答后，先用一两句话给出明确评价（对/部分对/偏了，并说明为什么）。
   - 答对了：简短肯定，然后问一个更深入的问题（同层深入或进入下一层）。
   - 答错了或含糊：绝不给答案，给一条线索或一个更简单的引导问题，让对方再想一次；确认真正理解后再继续。
4. 只有学习者在本层表现出真实理解才升级；不要把"猜对关键词"当成理解。
5. 问题必须具体引用文档中的实际内容（术语、论点、例子、数字），不要空泛地问"你觉得呢"。
6. 始终用中文。
7. 格式要求（非常重要）：每条回复的【最后一行】必须单独输出半角方括号标记，前面不能有其它文字：
   - 普通对话：根据本轮回复后学习者所处的层级输出 [LEVEL:1]、[LEVEL:2]、[LEVEL:3] 或 [LEVEL:4]；
   - 终审模式（学习者请求"检验"时）：最后一行只能输出 [PASS] 或 [CONTINUE] 之一，绝不能输出 [LEVEL:n]——即使你还在追问，也必须以 [CONTINUE] 结尾。
   示例（在第 1 层提问的回复结尾）：
   （问题内容……）
   [LEVEL:1]
终审模式细则：
- 综合四个层级评估学习者表现。
- 若已基本掌握：明确说"你已经真正弄懂了这份文档"，然后给一段简要总结（此时才允许总结），再列出 1-3 个仍薄弱或值得深挖的点，最后输出 [PASS]。
- 若仍有明显漏洞：先指出薄弱之处，然后针对薄弱层提出一个追问，最后一行输出 [CONTINUE]（追问也必须以 [CONTINUE] 结尾）。`;

const START_HINT = '（这是对话的开始：请直接提出第 1 层·事实的第一个问题，不要总结文档，不要解释规则。）';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

function corsHeaders(env) {
  const origins = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = origins.length ? origins.join(', ') : '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function checkAccess(env, body) {
  if (env.ACCESS_CODE && (!body || body.accessCode !== env.ACCESS_CODE)) {
    return json({ error: 'access_denied', message: '访问码错误或无权限' }, 403);
  }
  return null;
}

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return json({ error: 'too_large' }, 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too_large' }, 413);
  try {
    return JSON.parse(raw);
  } catch (e) {
    return json({ error: 'bad_request', message: '请求体不是合法 JSON' }, 400);
  }
}

/** 把消息列表压缩成单段文本，控制 token 用量 */
function historyToText(history) {
  if (!Array.isArray(history) || !history.length) return '（还没有任何对话，这是第一轮。）';
  return history
    .map((m, i) => `${m.role === 'user' ? '学习者' : '导师'}（第${i + 1}轮）：${m.content}`)
    .join('\n\n');
}

async function callLLM(env, model, messages, maxTokens) {
  const base = (env.BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.6,
        max_tokens: maxTokens,
      }),
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { error: 'upstream_401', message: '模型服务拒绝了 API Key（无效或额度不足）' };
    }
    if (res.status === 429) {
      return { error: 'upstream_429', message: '模型服务限流，请稍后再试' };
    }
    if (res.status >= 500) {
      return { error: 'upstream_5xx', message: '模型服务暂时不可用' };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: 'upstream_error', message: `上游返回 ${res.status}${text ? '：' + text.slice(0, 160) : ''}` };
    }
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) return { error: 'upstream_empty', message: '模型返回了空内容' };
    return { reply };
  } catch (e) {
    if (e.name === 'AbortError') return { error: 'timeout', message: '模型响应超时' };
    return { error: 'upstream_network', message: '无法连接模型服务' };
  } finally {
    clearTimeout(timer);
  }
}

async function handleAsk(request, env) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const denied = checkAccess(env, body);
  if (denied) return denied;

  if (!env.API_KEY) {
    return json({ error: 'worker_key_missing', message: 'Worker 未配置 API_KEY secret' }, 500);
  }

  const mode = body.mode === 'final' ? 'final' : body.mode === 'start' ? 'start' : 'ask';
  const model = (body.model && String(body.model).trim()) || 'gpt-4o-mini';
  const docText = String(body.docText || '').slice(0, MAX_DOC_CHARS);
  const history = Array.isArray(body.history) ? body.history.slice(-30) : [];
  const level = Math.max(1, Math.min(4, Number(body.level) || 1));

  if (!docText.trim()) {
    return json({ error: 'bad_request', message: '缺少文档内容' }, 400);
  }

  const userContent = [
    `你要引导学习的文档全文：`,
    `<document>\n${docText}\n</document>`,
    ``,
    `当前层级：第 ${level} 层（${['事实', '解释', '应用', '评价'][level - 1]}）`,
    mode === 'final' ? `本轮为「终审」：请按终审规则评估并输出 [PASS] 或 [CONTINUE]。` : '',
    mode === 'start' ? START_HINT : '',
    ``,
    `对话历史：`,
    historyToText(history),
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  const maxTokens = mode === 'final' ? 1200 : mode === 'start' ? 500 : 800;
  const result = await callLLM(env, model, messages, maxTokens);
  if (result.error) return json({ error: result.error, message: result.message }, 502);
  let reply = String(result.reply || '');
  // 服务端兜底：模型漏标时按规则补全标记，保证前端层级/终审状态确定
  if (mode === 'final') {
    if (!/\[(PASS|CONTINUE)\]/.test(reply)) {
      const passed = /真正弄懂|已(经|基本)掌握|通过了终审|可以(结束|通过)|\bpass\b/i.test(reply);
      reply = reply.trim() + '\n\n[' + (passed ? 'PASS' : 'CONTINUE') + ']';
    }
  } else if (!/\[LEVEL\s*:\s*[1-4]\]/.test(reply)) {
    reply = reply.trim() + '\n\n[LEVEL:' + level + ']';
  }
  return json({ reply });
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&middot;/g, '·');
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function handleFetch(request, env) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const denied = checkAccess(env, body);
  if (denied) return denied;

  let url = (body.url || '').trim();
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
    url = u.href;
  } catch (e) {
    return json({ error: 'bad_url', message: '请输入合法的 http/https 网址' }, 400);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'text/html,text/plain,*/*',
      },
    });
    if (!res.ok) return json({ error: 'bad_url', message: `目标站点返回 ${res.status}` }, 502);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const buf = await res.arrayBuffer();
    const isText = type.includes('text/') || type.includes('json');
    if (!isText) {
      return json({ error: 'bad_url', message: '该链接不是网页/文本内容（PDF 请下载后上传）' }, 415);
    }
    const decoder = new TextDecoder('utf-8');
    let text = decoder.decode(buf).slice(0, 2000000);
    let title = '';
    const tm = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (tm) title = decodeEntities(tm[1].replace(/<[^>]+>/g, '')).trim().slice(0, 120);
    if (type.includes('html')) text = htmlToText(text);
    else text = decodeEntities(text).replace(/\s+/g, ' ').trim();
    text = decodeEntities(text);
    const truncated = text.length > MAX_DOC_CHARS;
    return json({ title, text: text.slice(0, MAX_DOC_CHARS), truncated });
  } catch (e) {
    if (e.name === 'AbortError') return json({ error: 'timeout', message: '抓取超时' }, 504);
    return json({ error: 'bad_url', message: '无法访问该网址' }, 502);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/health' && request.method === 'GET') {
        return json({ ok: true, hasKey: !!env.API_KEY }, 200, cors);
      }
      if (url.pathname === '/ask' && request.method === 'POST') {
        const r = await handleAsk(request, env);
        for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
        return r;
      }
      if (url.pathname === '/fetch' && request.method === 'POST') {
        const r = await handleFetch(request, env);
        for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
        return r;
      }
      return json({ error: 'not_found', message: '未知路径' }, 404, cors);
    } catch (e) {
      return json({ error: 'internal', message: 'Worker 内部错误：' + (e && e.message ? e.message : e) }, 500, cors);
    }
  },
};
