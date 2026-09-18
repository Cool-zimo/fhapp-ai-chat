#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
════════════════════════════════════════════════════════════════
 AI 代理工具 —— 一个文件，两种用法
════════════════════════════════════════════════════════════════

  python3 ai_proxy_tool.py deploy    →  部署到 Cloudflare Worker（全球可用）
  python3 ai_proxy_tool.py local     →  在本机跑一个代理（不用注册任何东西）

为什么需要代理：
  浏览器的跨域限制。带 Authorization 头的 POST 会先发 OPTIONS 预检，
  而多数 AI 厂商不会放行这个头 —— 于是浏览器直接拦掉，请求根本发不出去。
  代理自己加上 CORS 头，浏览器那边就通了。

────────────────────────────────────────────────────────────────
 deploy 模式
────────────────────────────────────────────────────────────────
  前置：Cloudflare 令牌
        dash.cloudflare.com/profile/api-tokens
        → Create Token → 用模板 "Edit Cloudflare Workers"

  用法：
        CF_TOKEN=你的令牌 python3 ai_proxy_tool.py deploy

  如果报"列不出账号"（模板不带 Account Settings 读权限）：
        CF_TOKEN=你的令牌 CF_ACCOUNT_ID=你的ID python3 ai_proxy_tool.py deploy
        （Account ID 在 Cloudflare 后台右侧栏能看到，32 位十六进制）

  可选环境变量：
        CF_SCRIPT=ai-proxy       Worker 名字，改了地址也跟着变

────────────────────────────────────────────────────────────────
 local 模式
────────────────────────────────────────────────────────────────
  不用注册，不用令牌：

        python3 ai_proxy_tool.py local

  然后代理地址填  http://localhost:8787

  局限：电脑得开着，手机访问不了 localhost。
  好处：钥匙只在本机，谁的服务器都不经过。

════════════════════════════════════════════════════════════════
"""

import json
import os
import sys
import time
import uuid

# ══════════════════════════════════════════════════════════════
#  Cloudflare Worker 的源码（deploy 模式会把它传上去）
# ══════════════════════════════════════════════════════════════

WORKER_JS = r"""
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
    // 预检：直接放行。这是浏览器能不能调通的关键
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }

    // 健康检查：浏览器打开看到 ok 就说明部署成功了
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

    // 只转发白名单内的域名，免得这个 Worker 变成任意地址的跳板
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

    // 流式原样透传 —— 不能 await text()，那样会把流堵死
    const headers = cors({
      'Content-Type': upstream.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });

    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
"""

# 白名单：代理只往这几个域名转发
ALLOW_HOSTS = {'open.bigmodel.cn', 'api.deepseek.com', 'api.z.ai'}
DEF_BASE = 'https://open.bigmodel.cn/api/paas/v4'


def hostname(u):
    try:
        from urllib.parse import urlparse
        return urlparse(u).hostname or ''
    except Exception:
        return ''


# ══════════════════════════════════════════════════════════════
#  deploy —— 部署到 Cloudflare
# ══════════════════════════════════════════════════════════════

def deploy():
    import urllib.request
    import urllib.error

    API = 'https://api.cloudflare.com/client/v4'
    TOKEN = os.environ.get('CF_TOKEN', '').strip()
    ACCOUNT_ID = os.environ.get('CF_ACCOUNT_ID', '').strip()
    SCRIPT = os.environ.get('CF_SCRIPT', 'ai-proxy').strip()

    def req(path, method='GET', body=None, raw=None, ctype=None, tries=3):
        data = raw if raw is not None else (
            json.dumps(body).encode() if body is not None else None)
        last = ''
        for _ in range(tries):
            r = urllib.request.Request(API + path, data=data, method=method)
            r.add_header('Authorization', 'Bearer ' + TOKEN)
            r.add_header('User-Agent', 'facehub-deploy')
            if ctype:
                r.add_header('Content-Type', ctype)
            elif raw is None and body is not None:
                r.add_header('Content-Type', 'application/json')
            try:
                resp = urllib.request.urlopen(r, timeout=120)
                return json.loads(resp.read().decode('utf8', 'ignore'))
            except urllib.error.HTTPError as e:
                last = e.read().decode('utf8', 'ignore')[:400]
                if e.code < 500:
                    return json.loads(last) if last.startswith('{') else \
                        {'success': False, 'errors': [{'message': last or str(e.code)}]}
            except Exception as e:
                last = str(e)[:200]
            time.sleep(2)
        return {'success': False, 'errors': [{'message': last}]}

    def fail(msg):
        print('\n✗ ' + msg)
        sys.exit(1)

    if not TOKEN:
        fail('缺 CF_TOKEN 环境变量。\n'
             '  CF_TOKEN=你的令牌 python3 ai_proxy_tool.py deploy')

    # 1. 验 token
    who = req('/user/tokens/verify')
    if not who.get('success'):
        fail('token 无效或已过期：' + json.dumps(
            who.get('errors', [])[:1], ensure_ascii=False))
    print('✓ token 有效')

    # 2. 找账号
    if not ACCOUNT_ID:
        accs = req('/accounts?per_page=50')
        if not accs.get('success'):
            fail('列不出账号（模板可能不带 Account Settings 读权限）：\n'
                 '  ' + json.dumps(accs.get('errors', [])[:1], ensure_ascii=False) +
                 '\n  解决：加 CF_ACCOUNT_ID=你的ID 再跑一次')
        items = accs.get('result') or []
        if not items:
            fail('这个 token 下面没有账号')
        if len(items) > 1:
            print('  发现多个账号，用第一个：')
            for a in items:
                print('    -', a['id'], a.get('name'))
        acc = items[0]
    else:
        acc = req('/accounts/' + ACCOUNT_ID).get('result') or {'id': ACCOUNT_ID}
    aid = acc['id']
    print('✓ 账号:', acc.get('name') or '(未命名)', aid)

    # 3. 上传（ES module 必须走 multipart）
    main_name = SCRIPT + '.mjs'
    meta = json.dumps({
        'main_module': main_name,
        'compatibility_date': time.strftime('%Y-%m-%d'),
    }, ensure_ascii=False)

    bnd = '----fh' + uuid.uuid4().hex
    CRLF = b'\r\n'

    def part(name, filename, content, ctype):
        b = b'--' + bnd.encode() + CRLF
        b += 'Content-Disposition: form-data; name="%s"' % name
        if filename:
            b += '; filename="%s"' % filename
        b += CRLF + 'Content-Type: ' + ctype + CRLF + CRLF
        return b.encode() + content + CRLF

    body = part('metadata', None, meta.encode(), 'application/json')
    body += part(main_name, main_name, WORKER_JS.encode(),
                 'application/javascript+module')
    body += b'--' + bnd.encode() + b'--' + CRLF

    print('↑ 上传脚本…')
    up = req('/accounts/%s/workers/scripts/%s' % (aid, SCRIPT),
             method='PUT', raw=body,
             ctype='multipart/form-data; boundary=' + bnd)
    if not up.get('success'):
        errs = up.get('errors') or []
        msg = errs[0].get('message', '') if errs else str(up)[:200]
        fail('上传失败：' + msg)
    print('✓ 脚本已上传')

    # 4. 启用 workers.dev
    print('↑ 启用 workers.dev…')
    sub = req('/accounts/%s/workers/scripts/%s/subdomain' % (aid, SCRIPT),
              method='POST', body={'enabled': True})
    if not sub.get('success'):
        print('  ⚠ 启用失败：',
              json.dumps((sub.get('errors') or [{}])[0], ensure_ascii=False)[:200])
        print('    首次部署可能要在网页端点一次「启用」，之后就不用了')
    else:
        print('✓ 已启用')

    # 5. 拼地址
    info = req('/accounts/%s/workers/subdomain' % aid)
    ns = (info.get('result') or {}).get('subdomain')
    url = ('https://%s.%s.workers.dev' % (SCRIPT, ns)) if ns \
        else ('https://%s.<你的子域>.workers.dev' % SCRIPT)
    print('✓ 子域:', ns or '(未设置)')

    # 6. 探活
    print('\n⏳ 等 15 秒让边缘节点生效…')
    time.sleep(15)
    ok = False
    for _ in range(6):
        try:
            r = urllib.request.urlopen(url, timeout=25)
            txt = r.read().decode('utf8', 'ignore')
            if r.status == 200 and 'ok' in txt:
                ok = True
                print('✓ 自检通过：', txt[:100])
                break
        except Exception:
            pass
        time.sleep(8)

    print('\n' + '═' * 56)
    print('代理地址：', url)
    print('═' * 56)
    if ok:
        print('把上面这行填进小程序的「代理地址」，然后点「测试连接」。')
    else:
        print('⚠ 还没探活成功。可能要再等一两分钟，也可能要在后台手动启用：')
        print('  Workers 和 Pages → %s → 设置 → 域和路由 → 启用 workers.dev' % SCRIPT)


# ══════════════════════════════════════════════════════════════
#  local —— 在本机跑
# ══════════════════════════════════════════════════════════════

def local():
    import http.server
    import socketserver
    import urllib.request
    import urllib.error

    PORT = int(os.environ.get('PROXY_PORT', '8787'))

    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *a):
            pass

        def _cors(self, extra=()):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
            self.send_header('Access-Control-Max-Age', '86400')
            for k, v in extra:
                self.send_header(k, v)

        def do_OPTIONS(self):
            # ★ 预检必须过，否则浏览器根本发不出请求
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            self.send_response(200)
            self._cors([('Content-Type', 'application/json')])
            self.end_headers()
            self.wfile.write(json.dumps({'ok': True}).encode())

        def do_POST(self):
            try:
                n = int(self.headers.get('Content-Length') or 0)
                body = json.loads(self.rfile.read(n) or b'{}')
            except Exception:
                self.send_response(400)
                self._cors()
                self.end_headers()
                self.wfile.write(b'bad json')
                return

            key = body.get('key', '')
            if not key:
                self.send_response(401)
                self._cors([('Content-Type', 'application/json')])
                self.end_headers()
                self.wfile.write(json.dumps({'error': {'message': '缺少 key'}}).encode())
                return

            base = (body.get('base') or DEF_BASE).rstrip('/')
            if hostname(base) not in ALLOW_HOSTS:
                self.send_response(403)
                self._cors([('Content-Type', 'application/json')])
                self.end_headers()
                self.wfile.write(json.dumps(
                    {'error': {'message': 'base 不在允许列表：' + base}}).encode())
                return

            payload = {
                'model': body.get('model'),
                'messages': body.get('messages'),
                'stream': body.get('stream', True),
                'temperature': body.get('temperature', 0.7),
            }
            if body.get('max_tokens'):
                payload['max_tokens'] = body['max_tokens']

            req = urllib.request.Request(
                base + '/chat/completions',
                data=json.dumps(payload).encode(),
                method='POST',
                headers={
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + key,
                })

            try:
                up = urllib.request.urlopen(req, timeout=180)
            except urllib.error.HTTPError as e:
                # 厂商的错误原样带回 —— 小程序要靠它判断卡在哪一步
                data = e.read()
                self.send_response(e.code)
                self._cors([('Content-Type', 'application/json')])
                self.end_headers()
                self.wfile.write(data)
                return
            except Exception as e:
                self.send_response(502)
                self._cors([('Content-Type', 'application/json')])
                self.end_headers()
                self.wfile.write(json.dumps(
                    {'error': {'message': '连不上上游：' + str(e)}}).encode())
                return

            self.send_response(up.status)
            self._cors([
                ('Content-Type', up.headers.get('content-type') or 'text/event-stream'),
                ('Cache-Control', 'no-cache'),
                ('X-Accel-Buffering', 'no'),
            ])
            self.end_headers()

            # ★ 逐块转发，不能 read() 全读完 —— 那样流式就变成一次性的了
            while True:
                chunk = up.read(8192)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except Exception:
                    break
            up.close()

    class S(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    print('本地代理已启动：http://localhost:%d' % PORT)
    print('把这个地址填进小程序的「代理地址」。Ctrl+C 停止。\n')
    with S(('0.0.0.0', PORT), H) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n已停止')


# ══════════════════════════════════════════════════════════════

if __name__ == '__main__':
    cmd = (sys.argv[1] if len(sys.argv) > 1 else '').lower()
    if cmd == 'deploy':
        deploy()
    elif cmd == 'local':
        local()
    else:
        print(__doc__)
        print('用法：')
        print('  python3 ai_proxy_tool.py deploy   部署到 Cloudflare')
        print('  python3 ai_proxy_tool.py local    本机跑代理')
        sys.exit(0)
