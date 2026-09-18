#!/usr/bin/env python3
"""
本地代理 —— 不想注册 Cloudflare 时的备选

作用跟 Cloudflare Worker 一模一样：给小程序加 CORS 头，转发到智谱。
区别是它跑在你自己电脑上。

用法：
    python3 local_proxy.py

然后小程序的「代理地址」填：http://localhost:8787

局限：
    · 电脑得开着、脚本得运行着
    · 手机上访问不了 localhost（除非用内网穿透）
    · 但钥匙只在本机，谁都不经过 —— 反而更私密

按 Ctrl+C 停止。
"""
import http.server
import json
import socketserver
import urllib.request
import urllib.error

PORT = 8787
DEF_BASE = 'https://open.bigmodel.cn/api/paas/v4'
ALLOW = {
    'open.bigmodel.cn',
    'api.deepseek.com',
    'api.z.ai',
}


def hostname(u):
    try:
        from urllib.parse import urlparse
        return urlparse(u).hostname or ''
    except Exception:
        return ''


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def cors(self, extra=()):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Max-Age', '86400')
        for k, v in extra:
            self.send_header(k, v)

    def log_message(self, *a):
        pass

    def do_OPTIONS(self):
        # ★ 预检必须过，否则浏览器根本发不出请求
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        self.send_response(200)
        self.cors([('Content-Type', 'application/json')])
        self.end_headers()
        self.wfile.write(json.dumps({'ok': True}).encode())

    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(n) or b'{}')
        except Exception:
            self.send_response(400)
            self.cors()
            self.end_headers()
            self.wfile.write(b'bad json')
            return

        key = body.get('key', '')
        if not key:
            self.send_response(401)
            self.cors([('Content-Type', 'application/json')])
            self.end_headers()
            self.wfile.write(json.dumps({'error': {'message': '缺少 key'}}).encode())
            return

        base = (body.get('base') or DEF_BASE).rstrip('/')
        if hostname(base) not in ALLOW:
            self.send_response(403)
            self.cors([('Content-Type', 'application/json')])
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
            upstream = urllib.request.urlopen(req, timeout=180)
        except urllib.error.HTTPError as e:
            # 厂商的错误也要原样带回来，小程序要靠它判断是哪一步错了
            data = e.read()
            self.send_response(e.code)
            self.cors([('Content-Type', 'application/json')])
            self.end_headers()
            self.wfile.write(data)
            return
        except Exception as e:
            self.send_response(502)
            self.cors([('Content-Type', 'application/json')])
            self.end_headers()
            self.wfile.write(json.dumps(
                {'error': {'message': '连不上上游：' + str(e)}}).encode())
            return

        self.send_response(upstream.status)
        self.cors([
            ('Content-Type', upstream.headers.get('content-type') or 'text/event-stream'),
            ('Cache-Control', 'no-cache'),
            ('X-Accel-Buffering', 'no'),
        ])
        self.end_headers()

        # ★ 逐块转发，不能 read() 全读完 —— 那样流式就变成一次性了
        while True:
            chunk = upstream.read(8192)
            if not chunk:
                break
            try:
                self.wfile.write(chunk)
                self.wfile.flush()
            except Exception:
                break
        upstream.close()


class S(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    print('本地代理已启动：http://localhost:%d' % PORT)
    print('把这个地址填进小程序的「代理地址」。Ctrl+C 停止。\n')
    with S(('0.0.0.0', PORT), H) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n已停止')
