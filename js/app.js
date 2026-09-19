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
    function md(s) {
        var parts = String(s).split('```');
        var out = '';
        for (var i = 0; i < parts.length; i++) {
            if (i % 2 === 1) {
                var code = parts[i].replace(/^[a-zA-Z0-9]*\n/, '');
                out += '<pre><code>' + esc(code) + '</code></pre>';
            } else {
                out += esc(parts[i]).replace(/`([^`\n]+)`/g, '<code>$1</code>');
            }
        }
        return out;
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

    // ── 提示条 ─────────────────────────────────────────────
    function banner() {
        var c = global.AI.cfg();
        var b = $('banner');
        var hasKey = !!c.key;
        var needProxy = !c.proxy && c.provider === 'zhipu';

        if (!hasKey) {
            b.className = 'banner on';
            $('banner-text').textContent = '还没填 API Key，填了才能聊。';
            $('banner-act').textContent = '去设置';
            $('banner-act').onclick = function () { openSet(); };
        } else if (needProxy) {
            b.className = 'banner on warn';
            $('banner-text').textContent =
                '智谱的端点不允许浏览器直连，必须填代理地址，否则发不出去。';
            $('banner-act').textContent = '怎么办';
            $('banner-act').onclick = function () { openSet(); };
        } else {
            b.className = 'banner';
        }
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
                '智谱 / DeepSeek 等不允许浏览器直连，<b>必须填</b>。' +
                '部署 worker.js 到 Cloudflare 后拿到 https://xxx.workers.dev。<br>' +
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
                '先点右上角 ⚙ 填 API Key；智谱的话还得填代理地址，' +
                '点"测试连接"能直接看是哪一步卡住。');
        }
        $('inp').focus();
    }

    if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window);
