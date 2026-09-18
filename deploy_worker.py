#!/usr/bin/env python3
"""
把 worker.js 部署到 Cloudflare Worker —— 一键，不用打开网页。

用法：
    CF_TOKEN='你的Cloudflare令牌' python3 deploy_worker.py
    CF_TOKEN='...' CF_ACCOUNT_ID='...' python3 deploy_worker.py   # 可选，指定账号

需要什么权限：
    Account > Workers Scripts > Edit
    Account > Account Settings > Read      （读 workers.dev 子域用）

脚本会自己列账号，所以不填 CF_ACCOUNT_ID 也行。
"""
import json
import os
import sys
import time
import uuid
import urllib.request
import urllib.error

API = 'https://api.cloudflare.com/client/v4'
TOKEN = os.environ.get('CF_TOKEN', '').strip()
ACCOUNT_ID = os.environ.get('CF_ACCOUNT_ID', '').strip()
SCRIPT = os.environ.get('CF_SCRIPT', 'ai-proxy').strip()
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'repos', 'fhapp-ai-chat', 'worker.js')


def req(path, method='GET', body=None, raw=None, ctype=None, tries=3):
    """统一请求。raw 用于 multipart 这种自己拼好 body 的情况"""
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    last = ''
    for t in range(tries):
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
                return json.loads(last) if last.startswith('{') else {
                    'success': False, 'errors': [{'message': last or str(e.code)}]}
        except Exception as e:
            last = str(e)[:200]
        time.sleep(2)
    return {'success': False, 'errors': [{'message': last}]}


def fail(msg):
    print('\n✗ ' + msg)
    sys.exit(1)


def main():
    if not TOKEN:
        fail('缺 CF_TOKEN 环境变量')

    if not os.path.exists(SRC):
        # 独立运行（比如 curl | python3）时本地没有仓库，去 GitHub 取
        try:
            import urllib.request
            r = urllib.request.Request(
                'https://raw.githubusercontent.com/Cool-zimo/fhapp-ai-chat/main/worker.js',
                headers={'User-Agent': 'deploy'})
            data = urllib.request.urlopen(r, timeout=60).read()
            os.makedirs(os.path.dirname(SRC), exist_ok=True)
            open(SRC, 'wb').write(data)
            print('↓ 已从 GitHub 取到 worker.js')
        except Exception as e:
            fail('找不到 worker.js 也下载不到：' + str(e)[:120])

    # ── 1. 谁在调用（顺便验 token） ────────────────────────
    who = req('/user/tokens/verify')
    if not who.get('success'):
        fail('token 无效或已过期：' + json.dumps(who.get('errors', [])[:1], ensure_ascii=False))
    print('✓ token 有效，status =', (who.get('result') or {}).get('status'))

    # ── 2. 找账号 ──────────────────────────────────────────
    if not ACCOUNT_ID:
        accs = req('/accounts?per_page=50')
        if not accs.get('success'):
            fail('列不出账号（token 需要 Account Settings 读权限）：' +
                 json.dumps(accs.get('errors', [])[:1], ensure_ascii=False))
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

    # ── 3. 上传脚本（multipart，ES module 必须这么传） ──────
    src = open(SRC, 'rb').read()
    main_name = SCRIPT + '.mjs'
    meta = json.dumps({
        'main_module': main_name,
        'compatibility_date': time.strftime('%Y-%m-%d'),
    }, ensure_ascii=False)

    bnd = '----fh' + uuid.uuid4().hex
    CRLF = b'\r\n'

    def part(name, filename, content, ctype):
        b = b'--' + bnd.encode() + CRLF
        b += f'Content-Disposition: form-data; name="{name}"'.encode()
        if filename:
            b += f'; filename="{filename}"'.encode()
        b += CRLF
        b += f'Content-Type: {ctype}'.encode() + CRLF + CRLF
        b += content + CRLF
        return b

    body = part('metadata', None, meta.encode(), 'application/json')
    body += part(main_name, main_name, src, 'application/javascript+module')
    body += b'--' + bnd.encode() + b'--' + CRLF

    print('↑ 上传脚本…')
    up = req(f'/accounts/{aid}/workers/scripts/{SCRIPT}',
             method='PUT', raw=body, ctype=f'multipart/form-data; boundary={bnd}')
    if not up.get('success'):
        errs = up.get('errors') or []
        msg = errs[0].get('message', '') if errs else str(up)[:200]
        if 'workers.dev' in msg or 'subdomain' in msg.lower():
            print('  （先建子域再上传，这是首次部署的常见顺序问题）')
        else:
            fail('上传失败：' + msg)
    else:
        print('✓ 脚本已上传')

    # ── 4. 开 workers.dev 子域 ─────────────────────────────
    print('↑ 启用 workers.dev…')
    sub = req(f'/accounts/{aid}/workers/scripts/{SCRIPT}/subdomain',
              method='POST', body={'enabled': True})
    if not sub.get('success'):
        print('  ⚠ 启用失败：',
              json.dumps((sub.get('errors') or [{}])[0], ensure_ascii=False)[:200])
        print('    （首次部署可能要在网页端点一次「启用」，后面就不用了）')
    else:
        print('✓ 已启用')

    # ── 5. 拿子域名，拼出地址 ──────────────────────────────
    info = req(f'/accounts/{aid}/workers/subdomain')
    ns = (info.get('result') or {}).get('subdomain')
    if ns:
        url = f'https://{SCRIPT}.{ns}.workers.dev'
    else:
        url = f'https://{SCRIPT}.<你的子域>.workers.dev'
    print('✓ 子域:', ns or '(未设置)')

    # ── 6. 等生效后自检 ────────────────────────────────────
    print('\n⏳ 等十几秒让边缘节点生效…')
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
        print('把这个地址填进小程序的「代理地址」即可。')
    else:
        print('⚠ 还没探活成功。可能要再等一两分钟，')
        print('  也可能要在 Cloudflare 后台手动点一次启用：')
        print(f'  Workers 和 Pages → {SCRIPT} → 设置 → 域和路由 → 启用 workers.dev')


if __name__ == '__main__':
    main()
