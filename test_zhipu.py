#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
══════════════════════════════════════════════════════════════
 智谱 API 直连测试
══════════════════════════════════════════════════════════════

回答一个问题：浏览器能不能直连智谱，不走代理？

  python3 test_zhipu.py

不需要任何参数，key 已经写在文件里（不想硬编码就用环境变量 ZHIPU_KEY）。

会依次测：
  1. 拿免费模型列表
  2. 用最便宜的免费模型发一句话
  3. 顺带看看 CORS 头长什么样

第 2 步成功 → 说明服务端是通的。
但注意：服务端通 ≠ 浏览器能直连，那还取决于 CORS 头（第 3 步会打印出来）。
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

KEY = os.environ.get('ZHIPU_KEY', '').strip() or \
      '3fabdf676493439c82dec3538eae9c69.Z9CoHy7vEHQ4gnuf'

BASE = 'https://open.bigmodel.cn/api/paas/v4'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' \
     '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

# 免费模型（来自智谱官方模型概览）
FREE_MODELS = [
    'glm-4-flash-250414',
    'glm-4.7-flash',
    'glm-4.5-flash',
    'glm-4.6v-flash',
    'glm-4v-flash',
]

PASS = FAIL = 0


def check(label, ok, extra=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print('  ✓ ' + label + (('  ' + extra) if extra else ''))
    else:
        FAIL += 1
        print('  ✗ ' + label + (('  ' + extra) if extra else ''))
    return ok


def show(label, obj):
    print('     ' + label + ': ' + json.dumps(obj, ensure_ascii=False)[:300])


def call(path, payload=None, method='POST', origin=None, timeout=60):
    """统一的 HTTP 调用。返回 (http_code, body_text, headers)"""
    url = BASE + path
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {
        'Authorization': 'Bearer ' + KEY,
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'Accept': 'application/json',
    }
    if origin:
        headers['Origin'] = origin
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        body = resp.read().decode('utf8', 'ignore')
        return resp.status, body, dict(resp.headers)
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf8', 'ignore')
        return e.code, body, dict(e.headers) if hasattr(e, 'headers') else {}
    except Exception as e:
        return 0, str(e)[:300], {}


def main():
    print('═' * 62)
    print(' 智谱 API 直连测试')
    print('═' * 62)
    print(' key: ' + KEY[:12] + '…' + KEY[-6:])
    print(' base: ' + BASE)
    print()

    # ── 0. 网络通不通 ─────────────────────────────────────
    print('【0】网络')
    t0 = time.time()
    code, body, _ = call('/models', method='GET', timeout=25)
    ms = int((time.time() - t0) * 1000)
    reachable = code != 0
    check('能连上 open.bigmodel.cn（%dms）' % ms, reachable,
          '' if reachable else body[:120])
    if not reachable:
        print('\n 连都连不上。可能是本地网络/防火墙问题，跟 CORS 无关。')
        print_result()
        return

    # 403 但 body 里带 policy 字样 → 多半是被中间网关拦了，不是智谱说的
    if code == 403 and ('policy' in body or 'Request denied' in body):
        print('  ⚠ 这个 403 看着像中间网关/防火墙的拦截，不是智谱的响应：')
        show('body', body[:200])
        print('    换个网络（比如手机热点）再试一次会有帮助。')

    # ── 1. 模型列表 ───────────────────────────────────────
    print('\n【1】模型列表 GET /models')
    check('返回 200', code == 200, 'HTTP %d' % code)
    if code == 200:
        try:
            d = json.loads(body)
            ids = [m.get('id') for m in (d.get('data') or [])]
        except Exception:
            ids = []
            d = {}
        check('能解析出模型列表', len(ids) > 0, '共 %d 个' % len(ids))
        if ids:
            hit = [m for m in FREE_MODELS if m in ids]
            check('★ 免费模型在列表里', len(hit) > 0, ', '.join(hit[:3]) or '一个都没找到')
            print('     前几个: ' + ', '.join(ids[:6]))

    # ── 2. 真发一句话 ─────────────────────────────────────
    print('\n【2】★ 发一句话（这才是关键）')
    payload = {
        'model': 'glm-4-flash-250414',
        'messages': [{'role': 'user', 'content': '只回复两个字：收到'}],
        'stream': False,
        'temperature': 0.3,
    }
    t0 = time.time()
    code, body, _ = call('/chat/completions', payload, timeout=90)
    ms = int((time.time() - t0) * 1000)
    check('HTTP 200（%dms）' % ms, code == 200, 'HTTP %d' % code)

    if code == 200:
        try:
            d = json.loads(body)
            txt = d['choices'][0]['message']['content']
        except Exception:
            txt = None
        check('★ 拿到回复', bool(txt), repr(txt)[:80] if txt else body[:200])
        if txt:
            check('★ key 有效', True)
            try:
                u = d.get('usage') or {}
                show('tokens', u)
            except Exception:
                pass
    else:
        # 把错误分类说清楚，这决定下一步干什么
        msg = ''
        try:
            d = json.loads(body)
            msg = (d.get('error') or {}).get('message') or d.get('message') or ''
        except Exception:
            msg = body[:200]
        if code in (401, 403):
            print('     → key 无效/没权限：' + msg[:200])
        elif code == 429:
            print('     → 被限流：' + msg[:200])
        elif code == 404:
            print('     → 地址不对或模型名不对：' + msg[:200])
        else:
            print('     → ' + msg[:200])

    # ── 3. CORS 头（决定浏览器能不能直连）─────────────────
    print('\n【3】★ CORS 头（决定浏览器能不能直连）')
    # 预检：浏览器实际发的就是这个
    req = urllib.request.Request(
        BASE + '/chat/completions', method='OPTIONS')
    for k, v in [
        ('Origin', 'https://cool-zimo.github.io'),
        ('Access-Control-Request-Method', 'POST'),
        ('Access-Control-Request-Headers', 'authorization,content-type'),
        ('User-Agent', UA),
        ('Accept', '*/*'),
    ]:
        req.add_header(k, v)
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        pc, ph = resp.status, dict(resp.headers)
    except urllib.error.HTTPError as e:
        pc, ph = e.code, dict(e.headers) if hasattr(e, 'headers') else {}
    except Exception as e:
        pc, ph = 0, {}
        print('     预检请求没发出去: ' + str(e)[:100])

    ao = ph.get('Access-Control-Allow-Origin', '(没有)')
    ah = ph.get('Access-Control-Allow-Headers', '(没有)')
    print('     预检 HTTP %s' % pc)
    print('     Access-Control-Allow-Origin : %s' % ao)
    print('     Access-Control-Allow-Headers: %s' % ah)

    allows_all = ao.strip() in ('*',) or 'cool-zimo.github.io' in ao
    allows_auth = 'authorization' in ah.lower() or ah.strip() == '*'
    check('★ 允许我们的来源', allows_all)
    check('★ 放行 authorization 头（最关键）', allows_auth)

    if allows_all and allows_auth:
        print('\n     → 直连可行！浏览器能直接调，不用代理。')
    else:
        print('\n     → 浏览器直连会被拦。静态页面需要代理。')

    print_result()


def print_result():
    print('\n' + '═' * 62)
    print(' 结果：%d 通过 / %d 失败' % (PASS, FAIL))
    print('═' * 62)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\n已中断')
        sys.exit(0)
