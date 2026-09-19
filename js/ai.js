/**
 * AI 接口层
 *
 * ── 为什么需要"代理"这个东西 ──────────────────────────────
 *
 * 这是纯静态页面（GitHub Pages）调 AI 的唯一真问题：
 *
 *   浏览器发带 Authorization 头的 POST，会先发 OPTIONS 预检。
 *   智谱的 open.bigmodel.cn 在预检响应里没有把 Authorization
 *   放进 Access-Control-Allow-Headers → 预检失败 → 请求被拦。
 *
 *   这不是代码写错，是服务端策略。DeepSeek、OpenAI 同样如此
 *   （OpenAI 更狠，预检被 CDN 直接挡掉）。
 *
 * 所以这里两条路：
 *   ① 直连  —— 对方端点允许 CORS 才行（Anthropic 加了 opt-in 头就可以）
 *   ② 代理  —— 自己搭一个转发，浏览器只跟自己的代理说话
 *
 * 代理不是可选的"优化"，对智谱来说是**必需**的。仓库里的
 * worker.js 就是一个可以直接部署到 Cloudflare 的转发器。
 *
 * ── 令牌放哪 ──────────────────────────────────────────────
 *
 * 存 localStorage。跟 FaceHub 的 GitHub token 一个待遇：
 * 只在这台机器的这个浏览器里，不上传任何地方。
 * 但凡是能打开 devtools 的人都能看见 —— 这是 BYOK 的固有代价。
 */
(function (global) {

    var KEY = 'fhapp.ai.cfg';

    var AI = {

        /**
         * 内置厂商
         * 免费模型列表来自智谱官方文档 docs.bigmodel.cn 的模型概览
         */
        PROVIDERS: {
            zhipu: {
                name: '智谱 GLM',
                base: 'https://open.bigmodel.cn/api/paas/v4',
                keyUrl: 'https://open.bigmodel.cn/',
                models: [
                    { id: 'glm-4-flash-250414', name: 'GLM-4-Flash', free: true, d: '128K 上下文 · 永久免费' },
                    { id: 'glm-4.7-flash', name: 'GLM-4.7-Flash', free: true, d: '200K 上下文 · 编程更强' },
                    { id: 'glm-4.5-flash', name: 'GLM-4.5-Flash', free: true, d: '128K · 即将下线' },
                    { id: 'glm-4.6v-flash', name: 'GLM-4.6V-Flash', free: true, d: '视觉 · 可看图' },
                    { id: 'glm-4v-flash', name: 'GLM-4V-Flash', free: true, d: '视觉 · 16K' },
                    { id: 'glm-4.6', name: 'GLM-4.6', free: false, d: '200K · 付费' },
                    { id: 'glm-4.5-air', name: 'GLM-4.5-Air', free: false, d: '128K · 付费' }
                ]
            },
            deepseek: {
                name: 'DeepSeek',
                base: 'https://api.deepseek.com',
                keyUrl: 'https://platform.deepseek.com/',
                models: [
                    { id: 'deepseek-chat', name: 'DeepSeek-V3', free: false, d: '通用对话' },
                    { id: 'deepseek-reasoner', name: 'DeepSeek-R1', free: false, d: '推理' }
                ]
            },
            custom: {
                name: '自定义（OpenAI 兼容）',
                base: '',
                keyUrl: '',
                models: []
            }
        },

        /** 默认配置 */
        _def() {
            return {
                provider: 'zhipu',
                base: '',            // 空 = 用厂商默认
                key: '',
                model: 'glm-4-flash-250414',
                proxy: '',           // 代理地址，智谱必需
                sys: '你是乐于助人的助手，回答简洁。',
                temp: 0.7
            };
        },

        cfg() {
            try {
                var raw = global.localStorage.getItem(KEY);
                if (!raw) return this._def();
                var d = JSON.parse(raw);
                var def = this._def();
                for (var k in def) if (!(k in d)) d[k] = def[k];
                return d;
            } catch (e) { return this._def(); }
        },

        save(c) {
            try {
                global.localStorage.setItem(KEY, JSON.stringify(c));
                return true;
            } catch (e) { return false; }
        },

        /** 实际要用的 base（自定义优先） */
        baseOf(c) {
            var p = this.PROVIDERS[c.provider] || {};
            return (c.base || p.base || '').replace(/\/+$/, '');
        },

        // ── 发请求 ─────────────────────────────────────────
        /**
         * @param {object}   o        {messages, onDelta, signal}
         * @returns {Promise<string>} 完整回复
         */
        async chat(o) {
            var c = this.cfg();
            if (!c.key) throw this.err('nokey', '还没填 API Key');

            var base = this.baseOf(c);
            if (!base) throw this.err('nobase', '还没填接口地址');

            var body = {
                model: c.model,
                messages: o.messages,
                stream: true,
                temperature: Number(c.temp) || 0.7
            };

            var useProxy = !!c.proxy;
            var url, headers;

            if (useProxy) {
                // 代理模式：钥匙和地址都交给代理，由代理去转发。
                // 浏览器只跟自己的代理说话，不存在跨域问题。
                url = c.proxy.replace(/\/+$/, '');
                headers = { 'Content-Type': 'application/json' };
                body.key = c.key;
                body.base = base;
            } else {
                url = base + '/chat/completions';
                headers = {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + c.key
                };
            }

            var res;
            try {
                res = await global.fetch(url, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(body),
                    signal: o.signal
                });
            } catch (e) {
                // ★ 浏览器里 CORS 失败和断网长得一模一样：都是
                //   TypeError: Failed to fetch。分不出来，只能一起提示。
                if (e && e.name === 'AbortError') throw e;
                throw this.err('cors',
                    '请求发不出去 —— 通常是跨域被拦（CORS）或网络不通。' +
                    (useProxy ? '检查代理地址对不对、代理是不是还活着。' :
                        '★ 智谱实测能直连，所以多半是网络问题' +
                        '（公司网络/代理软件/防火墙），' +
                        '换手机热点试试；确认是真跨域再配代理。'));
            }

            if (!res.ok) {
                var txt = '';
                try { txt = await res.text(); } catch (e) { /* 忽略 */ }
                throw this.httpErr(res.status, txt);
            }

            return await this.readSSE(res, o.onDelta);
        },

        /**
         * 读 SSE 流
         *
         * ★ 不能拿到 chunk 就按 \n 切：网络是按块到达的，
         *   一个 SSE 事件完全可能被切成两个 chunk，
         *   直接切会把 JSON 截断 —— 不报错，但内容悄悄丢了。
         *   所以必须有缓冲区，只在事件边界（\n\n）才解析。
         */
        async readSSE(res, onDelta) {
            var reader = res.body.getReader();
            var dec = new TextDecoder('utf-8');
            var buf = '';
            var full = '';

            while (true) {
                var r = await reader.read();
                if (r.done) break;
                buf += dec.decode(r.value, { stream: true });

                var parts = buf.split('\n\n');
                buf = parts.pop();              // 最后一段可能不完整，留着

                for (var i = 0; i < parts.length; i++) {
                    var ev = parts[i];
                    var lines = ev.split('\n');
                    for (var j = 0; j < lines.length; j++) {
                        var ln = lines[j];
                        if (ln.indexOf('data:') !== 0) continue;
                        var payload = ln.slice(5).trim();
                        if (!payload) continue;
                        if (payload === '[DONE]') {
                            return full;
                        }
                        var d;
                        try { d = JSON.parse(payload); } catch (e) { continue; }
                        var ch = d.choices && d.choices[0];
                        var t = '';
                        if (ch) {
                            if (ch.delta && ch.delta.content) t = ch.delta.content;
                            else if (ch.message && ch.message.content) t = ch.message.content;
                        }
                        if (t) {
                            full += t;
                            if (onDelta) onDelta(t);
                        }
                    }
                }
            }
            return full;
        },

        // ── 错误 ───────────────────────────────────────────
        err(code, msg) {
            var e = new Error(msg);
            e.code = code;
            return e;
        },

        /** 把 HTTP 状态码翻译成人话 */
        httpErr(status, txt) {
            var m = '';
            try {
                var d = JSON.parse(txt);
                m = (d.error && (d.error.message || d.error.msg)) || d.message || d.msg || '';
            } catch (e) { m = (txt || '').slice(0, 160); }

            if (status === 401 || status === 403) {
                return this.err('auth', 'Key 无效或没权限（HTTP ' + status + '）' + (m ? '：' + m : ''));
            }
            if (status === 429) {
                return this.err('rate', '被限流了（HTTP 429）' + (m ? '：' + m : '') + '，等一下再试');
            }
            if (status === 404) {
                return this.err('404', '接口地址不对（HTTP 404）。检查 Base URL 有没有多/少 /v1');
            }
            return this.err('http', 'HTTP ' + status + (m ? '：' + m : ''));
        },

        /**
         * 连通性自检
         *
         * 故意发一条极短的请求，只为拿到一个确定的结论：
         * 到底是 key 不对、模型不对、还是要走代理。
         */
        async test() {
            var c = this.cfg();
            var steps = [];

            if (!c.key) return { ok: false, code: 'nokey', text: '先填 API Key' };

            var base = this.baseOf(c);
            if (!base) return { ok: false, code: 'nobase', text: '先填接口地址' };

            steps.push('厂商: ' + (this.PROVIDERS[c.provider] || {}).name);
            steps.push('地址: ' + base);
            steps.push('模型: ' + c.model);
            steps.push('代理: ' + (c.proxy || '（直连）'));

            var t0 = Date.now();
            try {
                var out = await this.chat({
                    messages: [{ role: 'user', content: '说"ok"' }]
                });
                steps.push('耗时: ' + (Date.now() - t0) + 'ms');
                steps.push('回复: ' + String(out).slice(0, 60));
                steps.push('');
                // ★ 直连成功是个重要结论：那就根本不用折腾代理。
                //   之前一直说"必须代理"是推测，这里给出实测判据。
                if (!c.proxy) {
                    steps.push('★ 直连成功 —— 不用配代理，直接用就行。');
                } else {
                    steps.push('✓ 经代理成功。');
                }
                return { ok: true, text: steps.join('\n') };
            } catch (e) {
                steps.push('失败: ' + e.message);
                if (!c.proxy) {
                    steps.push('');
                    steps.push('如果这条报的是跨域/发不出去，才需要代理。');
                }
                return {
                    ok: false,
                    code: e.code || 'unknown',
                    text: steps.join('\n') + '\n\n' + this.advice(e.code)
                };
            }
        },

        /** 按错误码给出下一步该干什么 */
        advice(code) {
            if (code === 'cors') {
                // ★ 这个建议之前是错的：智谱实测能直连，
                //   所以 fetch 失败更可能是本地网络问题，不该一上来就让人部署代理。
                return '→ 先别急着配代理。浏览器里 CORS 失败和断网长得一模一样，' +
                    '换手机热点、关掉科学上网软件再试一次。\n' +
                    '  确认真的跨域了，再部署 worker.js 并把地址填进"代理地址"。';
            }
            if (code === 'auth') {
                return '→ Key 有问题。去厂商后台重新生成一个，注意别复制到空格。';
            }
            if (code === 'rate') return '→ 免费模型有并发限制，稍等再试。';
            if (code === '404') return '→ 地址错了。智谱是 /api/paas/v4，不是 /v1。';
            if (code === 'http') return '→ 看上面的具体信息，多半是模型名不对。';
            return '';
        }
    };

    global.AI = AI;
})(typeof window !== 'undefined' ? window : this);
