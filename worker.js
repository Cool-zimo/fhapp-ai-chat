/**
 * Cloudflare Worker —— AI 接口转发
 *
 * ── 为什么需要它 ──────────────────────────────────────────
 *
 * 智谱 open.bigmodel.cn 的预检响应里没有
 *   Access-Control-Allow-Headers: Authorization
 * 所以浏览器根本发不出带 Key 的请求。这不是代码问题，改不掉。
 *
 * 这个 Worker 做的事只有一件：浏览器 → 它 → 厂商，原样转发。
 * 它自己加了 CORS 头，于是浏览器那边就通了。
 *
 * ── 部署（约 1 分钟） ─────────────────────────────────────
 *
 *   1. cloudflare.com 注册（免费，不用信用卡）
 *   2. Workers 和 Pages → 创建 → 创建 Worker → 起名 ai-proxy → 部署
 *   3. 点"编辑代码"，把本文件整个贴进去，保存并部署
 *   4. 拿到地址，形如 https://ai-proxy.你的名字.workers.dev
 *   5. 把这个地址填进小程序的"代理地址"
 *
 * 免费额度：每天 10 万次请求，个人用随便造。
 *
 * ── 安全 ──────────────────────────────────────────────────
 *
 * 两种用法，安全性不一样：
 *
 *   A. 钥匙从浏览器传来（默认）：Worker 不存任何秘密。
 *      钥匙经过你自己的服务器，跟你现在直接用没区别。
 *
 *   B. 钥匙存在 Worker 环境变量 ZHIPU_KEY：浏览器完全不接触钥匙。
 *      但此时务必设置 ALLOW_ORIGIN，否则你的额度会被别人白嫖。
 *
 * 别把 ALLOW_ORIGIN 设成 * 的同时又用 B —— 等于把钥匙挂在网上。
 */

const DEF_BASE = 'https://open.bigmodel.cn/api/paas/v4';

/** 允许的来源。设了就只认这个，建议设成你的 FaceHub 地址 */
const ALLOW_ORIGIN = '*';

function cors(extra = {}) {
  const h = {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    ...extra,
  };
  return h;
}

export default {
  async fetch(request, env, ctx) {
    // 预检：直接放行，这是浏览器能不能调的通关键
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }

    const url = new URL(request.url);

    // 健康检查：浏览器打开这个地址看到 ok 就说明部署成功了
    if (request.method === 'GET') {
      return new Response(
        JSON.stringify({ ok: true, hint: '用 POST 发 {key,base,model,messages}' }),
        { status: 200, headers: cors({ 'Content-Type': 'application/json' }) }
      );
    }

    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405, headers: cors() });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response('bad json', { status: 400, headers: cors() });
    }

    // 钥匙：优先用请求里带的（BYOK），否则退回环境变量
    const key = body.key || env.ZHIPU_KEY || '';
    if (!key) {
      return new Response(
        JSON.stringify({ error: { message: '缺少 key：请求里带 key，或给 Worker 设 ZHIPU_KEY 环境变量' } }),
        { status: 401, headers: cors({ 'Content-Type': 'application/json' }) }
      );
    }

    const base = String(body.base || env.ZHIPU_BASE || DEF_BASE).replace(/\/+$/, '');

    // 只转发白名单内的域名，避免这个 Worker 变成任意地址跳板
    const ok = /(^|\.)open\.bigmodel\.cn$/.test(new URL(base).hostname) ||
      /(^|\.)api\.deepseek\.com$/.test(new URL(base).hostname) ||
      /(^|\.)api\.z\.ai$/.test(new URL(base).hostname) ||
      (env.ALLOW_BASE_HOST && new URL(base).hostname.endsWith(env.ALLOW_BASE_HOST));
    if (!ok) {
      return new Response(
        JSON.stringify({ error: { message: 'base 不在允许列表里：' + base } }),
        { status: 403, headers: cors({ 'Content-Type': 'application/json' }) }
      );
    }

    // 只转发这几个字段，别的参数（比如 stream 之外的）不带过去
    const payload = {
      model: body.model,
      messages: body.messages,
      stream: body.stream !== false,
      temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
    };
    if (body.max_tokens) payload.max_tokens = body.max_tokens;

    let upstream;
    try {
      upstream = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key,
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: { message: '连不上上游：' + e.message } }),
        { status: 502, headers: cors({ 'Content-Type': 'application/json' }) }
      );
    }

    // 流式原样透传 —— 不能 await text()，那会把流堵住
    const headers = cors({
      'Content-Type': upstream.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });

    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
