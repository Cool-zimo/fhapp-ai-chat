/**
 * AI 聊天 · 界面
 *
 * 风格跟 FaceHub 对齐（微信那套：绿气泡在右、白气泡在左）。
 * 这个页面被 FaceHub 当"小程序"用 iframe 嵌进去，同源，
 * 所以能直接读 GitHub token —— 但这里不需要，AI 的 key 自己输。
 */
(function (global) {
    var doc = global.document;

    var msgs = [];            // {role, text}
    var ctrl = null;          // AbortController
    var convKey = 'fhapp.ai.conv';

    // ── 小工具 ─────────────────────────────────────────────
    function $(id) { return doc.getElementById(id); }
    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    /** 极简 Markdown：只处理代码块和行内 code，其余原样 */
    /**
     * Markdown 渲染
     *
     * 支持：代码块 / 标题 / 列表 / 引用 / 表格 / 分隔线
     * 行内：粗体 斜体 删除线 code 链接
     *
     * ★ 顺序极重要：先 esc，再做语法替换。
     *   esc 之后字符串里已经没有真实标签了，此时生成的 <b>/<pre>
     *   全是我们自己造的 —— 用户输入里的 <script> 早已变成
     *   &lt;script&gt;，不可能被当标签执行。反过来先替换后转义就完蛋了。
     *
     * ★ 代码块先抽成占位符：否则块级/行内规则会把代码里面的
     *   * _ # 当成 markdown 语法，把代码改坏。
     */
    function md(s) {
        if (s === null || s === undefined) return '';
        var holds = [];   // 存抽出来的 HTML 片段（代码块 / 行内 code）

        function inline(x) {
            x = x.replace(/`([^`\n]+)`/g, function (m, c) {
                holds.push('<code>' + c + '</code>');
                return '\u0001H' + (holds.length - 1) + '\u0001';
            });
            x = x.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
            x = x.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
            x = x.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
            // 链接只放行 http/https —— javascript: 之类不能变成可点的
            x = x.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (m, t, u) {
                if (!/^https?:\/\//i.test(u)) return m;
                return '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>';
            });
            return x;
        }

        function blk(src) {
            var ln = src.split('\n');
            var out = '', list = null, buf = [];

            function flushP() {
                if (!buf.length) return;
                out += '<p>' + inline(buf.join('<br>')) + '</p>';
                buf = [];
            }
            function closeL() {
                if (list) { out += '</' + list + '>'; list = null; }
            }

            for (var i = 0; i < ln.length; i++) {
                var raw = ln[i];
                // ★ rt = 原始行，只用于**判断**语法类型
                //   t  = 转义后，用于**渲染**
                //   两者必须分开：'>' 转义后是 '&gt;'，拿去匹配 /^>/
                //   永远匹配不上，引用就会退化成普通段落。
                var rt = raw.trim();
                var t = esc(raw).trim();

                if (!rt) { flushP(); closeL(); continue; }

                // 整行就是占位符 → 块级元素，直接吐出去，别裹 <p>
                var ph = /^\u0001H(\d+)\u0001$/.exec(rt);
                if (ph) { flushP(); closeL(); out += '\u0001H' + ph[1] + '\u0001'; continue; }

                var h = /^(#{1,6})\s+(.*)$/.exec(rt);
                if (h) {
                    flushP(); closeL();
                    var lv = h[1].length;
                    out += '<h' + lv + '>' + inline(esc(h[2])) + '</h' + lv + '>';
                    continue;
                }
                if (/^(-{3,}|\*{3,}|_{3,})$/.test(rt)) {
                    flushP(); closeL(); out += '<hr>'; continue;
                }
                if (/^>\s?/.test(rt)) {
                    flushP(); closeL();
                    out += '<blockquote>' +
                        inline(esc(rt.replace(/^>\s?/, ''))) + '</blockquote>';
                    continue;
                }
                var ul = /^[-*+]\s+(.*)$/.exec(rt);
                if (ul) {
                    flushP();
                    if (list !== 'ul') { closeL(); out += '<ul>'; list = 'ul'; }
                    out += '<li>' + inline(esc(ul[1])) + '</li>';
                    continue;
                }
                var ol = /^\d+[.)]\s+(.*)$/.exec(rt);
                if (ol) {
                    flushP();
                    if (list !== 'ol') { closeL(); out += '<ol>'; list = 'ol'; }
                    out += '<li>' + inline(esc(ol[1])) + '</li>';
                    continue;
                }
                // 表格
                if (/^\|/.test(rt)) {
                    flushP(); closeL();
                    var rows = [];
                    while (i < ln.length && /^\s*\|/.test(ln[i])) {
                        rows.push(ln[i].trim().replace(/^\||\|$/g, '').split('|'));
                        i++;
                    }
                    i--;
                    // 去掉 |---|---| 那条分隔行
                    if (rows.length > 1 && /^[-: |]+$/.test(rows[1].join(''))) rows.splice(1, 1);
                    var tb = '<table>';
                    for (var r = 0; r < rows.length; r++) {
                        tb += '<tr>';
                        for (var c = 0; c < rows[r].length; c++) {
                            var v = esc(rows[r][c].trim());
                            tb += (r === 0 ? '<th>' : '<td>') + inline(v) +
                                  (r === 0 ? '</th>' : '</td>');
                        }
                        tb += '</tr>';
                    }
                    out += tb + '</table>';
                    continue;
                }
                buf.push(t);   // 普通段落行，攒着
            }
            flushP(); closeL();
            return out;
        }

        // ── 主流程：先抽代码块 ─────────────────────────────
        var parts = String(s).split('```');
        var body = '';
        for (var i = 0; i < parts.length; i++) {
            if (i % 2 === 1) {
                // 去掉语言标记（```python）
                var code = parts[i].replace(/^[a-zA-Z0-9]*\n/, '');
                // 含换行 = 块级 <pre>；不含 = 行内 <code>
                var isBlock = code.indexOf('\n') >= 0;
                holds.push(isBlock
                    ? '<pre><code>' + esc(code) + '</code></pre>'
                    : '<code>' + esc(code) + '</code>');
                body += '\u0001H' + (holds.length - 1) + '\u0001';
            } else {
                body += parts[i];
            }
        }

        var html = blk(body);
        // 还原占位符
        html = html.replace(/\u0001H(\d+)\u0001/g, function (m, n) {
            return holds[Number(n)] || '';
        });
        return html;
    }
    function bottom() {
        var m = $('msgs');
        m.scrollTop = m.scrollHeight;
    }

    // ── 渲染 ───────────────────────────────────────────────
    function row(role, html, isErr) {
        var d = doc.createElement('div');
        d.className = 'row' + (role === 'user' ? ' me' : '');
        var av = doc.createElement('div');
        av.className = 'av';
        av.textContent = role === 'user' ? '我' : '🤖';
        var b = doc.createElement('div');
        b.className = 'bub' + (isErr ? ' err' : '');
        var c = doc.createElement('i');
        c.className = 'caret-l';
        b.appendChild(c);
        var t = doc.createElement('div');
        t.innerHTML = html;
        b.appendChild(t);
        d.appendChild(av);
        d.appendChild(b);
        $('msgs').appendChild(d);
        bottom();
        return t;
    }

    function renderAll() {
        var box = $('msgs');
        box.innerHTML = '';
        msgs.forEach(function (m) {
            row(m.role, md(m.text));
        });
        bottom();
    }

    function save() {
        try {
            global.localStorage.setItem(convKey, JSON.stringify(msgs.slice(-50)));
        } catch (e) { /* 满了就算了 */ }
    }
    function load() {
        try {
            var raw = global.localStorage.getItem(convKey);
            msgs = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(msgs)) msgs = [];
        } catch (e) { msgs = []; }
    }

    /**
     * ── 提示条 ──────────────────────────────────────────
     *
     * ★ 实测更正：智谱 open.bigmodel.cn **允许浏览器直连**。
     *
     *   之前这里写着"必须填代理，否则发不出去" —— 那个结论是错的。
     *   它是拿被中间网关污染的 403 当证据推出来的（网关拦截和厂商
     *   拒绝长得一模一样，当时没分辨出来）。
     *
     *   真实环境跑通后证明：不填代理直接就能聊。
     *   所以这里不再吓唬人，代理降级为"连不上时的可选方案"。
     */
    function banner() {
        var c = global.AI.cfg();
        var b = $('banner');

        if (!c.key) {
            b.className = 'banner on';
            $('banner-text').textContent = '还没填 API Key，填了才能聊。';
            $('banner-act').textContent = '去设置';
            $('banner-act').onclick = function () { openSet(); };
            return;
        }
        b.className = 'banner';
    }

    function chip() {
        var c = global.AI.cfg();
        var p = global.AI.PROVIDERS[c.provider] || {};
        var m = (p.models || []).filter(function (x) { return x.id === c.model; })[0];
        $('model-name').textContent = c.model || (m ? m.name : '选择模型');
    }

    // ── 发送 ───────────────────────────────────────────────
    async function send() {
        if (ctrl) return;                       // 正在生成
        var inp = $('inp');
        var text = (inp.value || '').trim();
        if (!text) return;

        inp.value = '';
        autoH(inp);

        msgs.push({ role: 'user', text: text });
        row('user', md(text));
        save();

        // 系统提示词只在第一条前插，不每次都塞（省 token）
        var sent = msgs.slice();
        var c = global.AI.cfg();
        if (c.sys && c.sys.trim()) {
            sent = [{ role: 'system', content: c.sys.trim() }].concat(
                msgs.map(function (m) {
                    return { role: m.role === 'user' ? 'user' : 'assistant', content: m.text };
                })
            );
        } else {
            sent = msgs.map(function (m) {
                return { role: m.role === 'user' ? 'user' : 'assistant', content: m.text };
            });
        }

        var holder = row('assistant', '<span class="cursor"></span>');
        ctrl = new AbortController();
        $('btn-send').hidden = true;
        $('btn-stop').hidden = false;

        var full = '';
        var t0 = Date.now();
        try {
            full = await global.AI.chat({
                messages: sent,
                signal: ctrl.signal,
                onDelta: function (d) {
                    full += d;
                    holder.innerHTML = md(full) + '<span class="cursor"></span>';
                    bottom();
                }
            });
            holder.innerHTML = md(full);
            msgs.push({ role: 'assistant', text: full });
            save();
        } catch (e) {
            if (e && e.name === 'AbortError') {
                holder.innerHTML = md(full) + '<div class="meta">已停止</div>';
                if (full) msgs.push({ role: 'assistant', text: full });
            } else {
                var msg = e.message || String(e);
                if (global.AI.advice) {
                    var ad = global.AI.advice(e.code);
                    if (ad) msg += '\n\n' + ad;
                }
                holder.parentNode.querySelector('.bub').className = 'bub err';
                holder.innerHTML = esc(msg);
            }
            save();
        } finally {
            ctrl = null;
            $('btn-send').hidden = false;
            $('btn-stop').hidden = true;
            bottom();
        }
    }

    function stop() {
        if (ctrl) ctrl.abort();
    }

    // ── 面板 ───────────────────────────────────────────────
    function openSheet(title, build) {
        $('sheet-title').textContent = title;
        var body = $('sheet-body');
        body.innerHTML = '';
        build(body);
        $('sheet').hidden = false;
        $('sheet-mask').hidden = false;
    }
    function closeSheet() {
        $('sheet').hidden = true;
        $('sheet-mask').hidden = true;
    }

    /** 设置 */
    function openSet() {
        var c = global.AI.cfg();
        openSheet('设置', function (box) {
            function fld(label, hint) {
                var d = doc.createElement('div');
                d.className = 'fld';
                var l = doc.createElement('label');
                l.textContent = label;
                d.appendChild(l);
                if (hint) {
                    var h = doc.createElement('div');
                    h.className = 'hint';
                    h.innerHTML = hint;
                    d.appendChild(h);
                }
                box.appendChild(d);
                return d;
            }

            // 厂商
            var pf = fld('厂商');
            var seg = doc.createElement('div');
            seg.className = 'seg';
            Object.keys(global.AI.PROVIDERS).forEach(function (k) {
                var b = doc.createElement('button');
                b.textContent = global.AI.PROVIDERS[k].name;
                b.className = k === c.provider ? 'on' : '';
                b.onclick = function () {
                    c.provider = k;
                    c.base = '';
                    var ms = global.AI.PROVIDERS[k].models;
                    if (ms && ms.length) c.model = ms[0].id;
                    openSet();
                };
                seg.appendChild(b);
            });
            pf.appendChild(seg);

            // Key
            var kf = fld('API Key', '只存在这台机器的浏览器里，不会上传。');
            var ki = doc.createElement('input');
            ki.type = 'password';
            ki.value = c.key;
            ki.placeholder = 'sk-…';
            ki.oninput = function () { c.key = ki.value.trim(); };
            kf.appendChild(ki);

            // Base（自定义才显示）
            if (c.provider === 'custom') {
                var bf = fld('Base URL', '例如 https://api.xxx.com/v1');
                var bi = doc.createElement('input');
                bi.value = c.base;
                bi.placeholder = 'https://…/v1';
                bi.oninput = function () { c.base = bi.value.trim(); };
                bf.appendChild(bi);
            }

            // 模型（自定义手填）
            if (c.provider === 'custom') {
                var mf = fld('模型名');
                var mi = doc.createElement('input');
                mi.value = c.model;
                mi.oninput = function () { c.model = mi.value.trim(); };
                mf.appendChild(mi);
            }

            // 代理 —— 智谱必需
            var xf = fld('代理地址',
                '一般<b>不用填</b> —— 智谱实测可以直连。' +
                '只有确认直连被拦时才需要：部署 worker.js 到 Cloudflare，' +
                '拿到 https://xxx.workers.dev 填这儿。<br>' +
                '⚠️ 别用网上公开的 CORS 代理 —— 你的 Key 会从人家服务器过一遍。');
            var xi = doc.createElement('input');
            xi.value = c.proxy;
            xi.placeholder = 'https://你的名字.workers.dev';
            xi.oninput = function () { c.proxy = xi.value.trim(); };
            xf.appendChild(xi);

            // 系统提示
            var sf = fld('系统提示');
            var si = doc.createElement('textarea');
            si.value = c.sys;
            si.oninput = function () { c.sys = si.value; };
            sf.appendChild(si);

            // 温度
            var tf = fld('温度 ' + c.temp);
            var ti = doc.createElement('input');
            ti.type = 'range';
            ti.min = '0'; ti.max = '1'; ti.step = '0.1';
            ti.value = c.temp;
            ti.oninput = function () { c.temp = ti.value; tf.childNodes[0].textContent = '温度 ' + ti.value; };
            tf.insertBefore(ti, tf.childNodes[1]);
            tf.className = 'fld';

            // 自检
            var df = fld('连接自检');
            var dt = doc.createElement('div');
            dt.className = 'diag';
            var db = doc.createElement('button');
            db.className = 'txt-btn';
            db.textContent = '测试连接';
            db.onclick = async function () {
                dt.className = 'diag on';
                dt.textContent = '测试中…';
                var r = await global.AI.test();
                dt.className = 'diag on ' + (r.ok ? 'ok' : 'bad');
                dt.textContent = r.text;
            };
            df.appendChild(db);
            df.appendChild(dt);
        });

        $('sheet-save').onclick = function () {
            global.AI.save(c);
            closeSheet();
            banner();
            chip();
        };
    }

    /** 选模型 */
    function openModels() {
        var c = global.AI.cfg();
        var p = global.AI.PROVIDERS[c.provider] || {};
        openSheet('选择模型', function (box) {
            (p.models || []).forEach(function (m) {
                var d = doc.createElement('div');
                d.className = 'mdl' + (m.id === c.model ? ' on' : '');
                var n = doc.createElement('div');
                n.className = 'n';
                n.innerHTML = '<b>' + esc(m.name) + '</b>' +
                    '<span class="tag' + (m.free ? '' : ' pay') + '">' +
                    (m.free ? '免费' : '付费') + '</span>' +
                    '<div class="d">' + esc(m.d) + '</div>';
                d.appendChild(n);
                d.onclick = function () {
                    c.model = m.id;
                    global.AI.save(c);
                    chip();
                    closeSheet();
                };
                box.appendChild(d);
            });
            if (!(p.models || []).length) {
                box.innerHTML = '<div class="hint">自定义模式在设置里手填模型名。</div>';
            }
        });
        $('sheet-save').onclick = closeSheet;
    }

    function autoH(el) {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 110) + 'px';
    }

    // ── 绑定 ───────────────────────────────────────────────
    function bind() {
        $('btn-send').onclick = send;
        $('btn-stop').onclick = stop;
        $('btn-set').onclick = openSet;
        $('model-chip').onclick = openModels;
        $('sheet-close').onclick = closeSheet;
        $('sheet-mask').onclick = closeSheet;

        $('btn-clear').onclick = function () {
            if (!global.confirm('清空当前对话？')) return;
            msgs = [];
            save();
            renderAll();
        };
        $('btn-hist').onclick = function () {
            // 新对话：先存一份旧的，再开空白
            msgs = [];
            save();
            renderAll();
        };
        $('btn-back').onclick = function () {
            // 被 iframe 嵌着时，请求宿主把自己收起来
            try {
                global.parent.postMessage({ type: 'fhapp-close' }, '*');
            } catch (e) { /* 独立打开就忽略 */ }
        };

        // Esc 关面板。之前只能点 ✕，而那个按钮一度被 CSS 坑到失效，
        // 多一条退路能少卡住一次。
        doc.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !$('sheet').hidden) closeSheet();
        });

        var inp = $('inp');
        inp.addEventListener('input', function () { autoH(inp); });
        inp.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });
    }

    function init() {
        load();
        bind();
        banner();
        chip();
        renderAll();
        if (!msgs.length) {
            row('assistant', '你好，我是 AI 聊天小程序。<br>' +
                '点右上角 ⚙ 填 API Key 就能聊（智谱可以直连，不用配代理）。<br>' +
                '不确定就点设置里的"测试连接"，它会告诉你是哪一步卡住。');
        }
        $('inp').focus();
    }

    if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window);
