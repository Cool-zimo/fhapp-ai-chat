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
    // ══════════════════════════════════════════════════════
    //  LaTeX 数学公式
    //
    //  不引 KaTeX/MathJax：那俩要加载 CSS + 好几套字体，
    //  网络一卡公式就变成一堆乱码或空白，比不渲染还难看。
    //  自研一个够用的子集（分数/上下标/根号/希腊字母/常用运算符），
    //  零外部依赖，永远不会"加载失败"。
    //
    //  ★ 处理不了的命令原样保留（\) → 至少不破坏阅读，
    //    也不会把 rac 之类显示成一坨看不懂的源码。
    // ══════════════════════════════════════════════════════

    var TEX_SYM = {
        // 希腊字母
        'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'delta': 'δ',
        'epsilon': 'ε', 'varepsilon': 'ε', 'zeta': 'ζ', 'eta': 'η',
        'theta': 'θ', 'vartheta': 'θ', 'iota': 'ι', 'kappa': 'κ',
        'lambda': 'λ', 'mu': 'μ', 'nu': 'ν', 'xi': 'ξ', 'pi': 'π',
        'rho': 'ρ', 'sigma': 'σ', 'tau': 'τ', 'upsilon': 'υ',
        'phi': 'φ', 'varphi': 'φ', 'chi': 'χ', 'psi': 'ψ', 'omega': 'ω',
        'Gamma': 'Γ', 'Delta': 'Δ', 'Theta': 'Θ', 'Lambda': 'Λ',
        'Xi': 'Ξ', 'Pi': 'Π', 'Sigma': 'Σ', 'Phi': 'Φ', 'Psi': 'Ψ',
        'Omega': 'Ω',
        // 运算符 / 关系
        'times': '×', 'div': '÷', 'pm': '±', 'mp': '∓',
        'cdot': '·', 'ast': '∗', 'circ': '∘', 'bullet': '•',
        'le': '≤', 'leq': '≤', 'ge': '≥', 'geq': '≥',
        'neq': '≠', 'ne': '≠', 'approx': '≈', 'equiv': '≡',
        'sim': '∼', 'simeq': '≃', 'propto': '∝',
        'll': '≪', 'gg': '≫', 'subset': '⊂', 'supset': '⊃',
        'subseteq': '⊆', 'supseteq': '⊇', 'in': '∈',
        'notin': '∉', 'cup': '∪', 'cap': '∩',
        'infty': '∞', 'partial': '∂', 'nabla': '∇',
        'forall': '∀', 'exists': '∃', 'neg': '¬',
        'wedge': '∧', 'vee': '∨', 'oplus': '⊕', 'otimes': '⊗',
        'to': '→', 'rightarrow': '→', 'Rightarrow': '⇒',
        'leftarrow': '←', 'Leftarrow': '⇐',
        'leftrightarrow': '↔', 'Leftrightarrow': '⇔',
        'mapsto': '↦', 'uparrow': '↑', 'downarrow': '↓',
        'sum': '∑', 'prod': '∏', 'int': '∫', 'iint': '∬',
        'oint': '∮', 'lim': 'lim', 'log': 'log', 'ln': 'ln',
        'sin': 'sin', 'cos': 'cos', 'tan': 'tan',
        'cot': 'cot', 'sec': 'sec', 'csc': 'csc',
        'arcsin': 'arcsin', 'arccos': 'arccos', 'arctan': 'arctan',
        'max': 'max', 'min': 'min', 'sup': 'sup', 'inf': 'inf',
        'deg': '°', 'prime': '′', 'angle': '∠',
        'perp': '⊥', 'parallel': '∥', 'therefore': '∴',
        'because': '∵', 'dots': '…', 'cdots': '⋯',
        'ldots': '…', 'vdots': '⋮', 'ddots': '⋱',
        'quad': ' ', 'qquad': ' ', 'hspace': '',
        'left': '', 'right': '', 'big': '', 'Big': '',
        'bigg': '', 'Bigg': '', 'displaystyle': '',
        'limits': '', 'nolimits': '', 'bmod': 'mod'
    };

    /** 从 i 处的 '{' 找配对的 '}' */
    function _matchBrace(s, i) {
        if (s[i] !== '{') return -1;
        var d = 0;
        for (var j = i; j < s.length; j++) {
            if (s[j] === '{') d++;
            else if (s[j] === '}') {
                d--;
                if (d === 0) return j;
            }
        }
        return -1;                       // 不闭合 → 放弃，原样显示
    }

    /** 取出 {...} 的内容（不含外层花括号） */
    function _grp(s) {
        if (s[0] !== '{') return null;
        var e = _matchBrace(s, 0);
        return e < 0 ? null : s.slice(1, e);
    }

    /**
     * 把 LaTeX 转成 HTML
     * 输入是**未转义**的原始 LaTeX；输出里所有文本都已 esc 过。
     */
    function tex(src) {
        src = String(src == null ? '' : src);
        if (!src.trim()) return '';

        // 多行：\\ 或 \cr → 换行
        var lines = src.split(/\\\\|\\cr/);

        var out = lines.map(function (ln) {
            return _texLine(ln);
        }).join('<br>');

        return out;
    }

    function _texLine(s) {
        var out = '';
        var i = 0;

        while (i < s.length) {
            var c = s[i];

            // ── \命令 ────────────────────────────────────
            if (c === '\\') {
                // 取命令名（字母，或单个非字母字符）
                var m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
                if (!m) { out += esc('\\'); i++; continue; }
                var cmd = m[1];
                var rest = s.slice(i + 1 + cmd.length);

                // \text{...} / \mathrm{...} → 普通文字
                if (cmd === 'text' || cmd === 'mathrm' || cmd === 'mathbf' ||
                    cmd === 'textit' || cmd === 'textrm') {
                    var g0 = _grp(rest);
                    if (g0 !== null) {
                        out += esc(g0);
                        i += 1 + cmd.length + g0.length + 2;
                        continue;
                    }
                }

                // \frac{a}{b}
                if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
                    var ga = _grp(rest);
                    if (ga !== null) {
                        var after = rest.slice(ga.length + 2);
                        var gb = _grp(after);
                        if (gb !== null) {
                            out += '<span class="mfrac">' +
                                '<span class="mnum">' + _texLine(ga) + '</span>' +
                                '<span class="mden">' + _texLine(gb) + '</span>' +
                                '</span>';
                            i += 1 + cmd.length + (ga.length + 2) + (gb.length + 2);
                            continue;
                        }
                    }
                }

                // \sqrt[n]{x} → 只渲染成普通根号（n 次根号样式太复杂）
                if (cmd === 'sqrt') {
                    var g1 = _grp(rest);
                    if (g1 !== null) {
                        out += '<span class="msqrt">' +
                            '<span class="mrad">√</span>' +
                            '<span class="mbody">' + _texLine(g1) + '</span>' +
                            '</span>';
                        i += 1 + cmd.length + g1.length + 2;
                        continue;
                    }
                    // \sqrt2 这种无花括号的
                    var sm = /^([0-9a-zA-Z])/.exec(rest);
                    if (sm) {
                        out += '<span class="msqrt"><span class="mrad">√</span>' +
                            '<span class="mbody">' + esc(sm[1]) + '</span></span>';
                        i += 1 + cmd.length + 1;
                        continue;
                    }
                }

                // \overline{x} / \hat{x} / \vec{x}
                if (cmd === 'overline' || cmd === 'bar') {
                    var g2 = _grp(rest);
                    if (g2 !== null) {
                        out += '<span class="mover">' + _texLine(g2) + '</span>';
                        i += 1 + cmd.length + g2.length + 2;
                        continue;
                    }
                }
                if (cmd === 'hat' || cmd === 'widehat' || cmd === 'vec' ||
                    cmd === 'tilde' || cmd === 'dot') {
                    var g3 = _grp(rest);
                    if (g3 !== null) {
                        out += '<span class="mhat">' + _texLine(g3) + '</span>';
                        i += 1 + cmd.length + g3.length + 2;
                        continue;
                    }
                }

                // 符号表
                if (TEX_SYM[cmd] !== undefined) {
                    out += esc(TEX_SYM[cmd]);
                    i += 1 + cmd.length;
                    continue;
                }

                // 未知命令：原样保留（比显示乱码强）
                out += esc('\\' + cmd);
                i += 1 + cmd.length;
                continue;
            }

            // ── ^ 上标 ────────────────────────────────────
            if (c === '^') {
                var supG = _grp(s.slice(i + 1));
                if (supG !== null) {
                    out += '<sup>' + _texLine(supG) + '</sup>';
                    i += 2 + supG.length + 1;
                    continue;
                }
                var sup1 = /^([0-9a-zA-Z])/.exec(s.slice(i + 1));
                if (sup1) {
                    out += '<sup>' + esc(sup1[1]) + '</sup>';
                    i += 2;
                    continue;
                }
                out += esc('^'); i++; continue;
            }

            // ── _ 下标 ────────────────────────────────────
            if (c === '_') {
                var subG = _grp(s.slice(i + 1));
                if (subG !== null) {
                    out += '<sub>' + _texLine(subG) + '</sub>';
                    i += 2 + subG.length + 1;
                    continue;
                }
                var sub1 = /^([0-9a-zA-Z])/.exec(s.slice(i + 1));
                if (sub1) {
                    out += '<sub>' + esc(sub1[1]) + '</sub>';
                    i += 2;
                    continue;
                }
                out += esc('_'); i++; continue;
            }

            // ── 普通字符 ──────────────────────────────────
            // 花括号只是分组，不显示
            if (c === '{' || c === '}') { i++; continue; }
            out += esc(c);
            i++;
        }
        return out;
    }

    /**
     * 抽出 $...$ / $$...$$ → 占位符
     *
     * ★ 必须在 esc **之前**抽：
     *   LaTeX 里满是 \ { } ^ _ ，一旦先 esc，
     *   & < > 变成实体后再匹配就全乱了。
     *   这里拿到的必须是原始源码。
     */
    function extractMath(text, holds) {
        var out = '';
        var i = 0;

        while (i < text.length) {
            // $$ ... $$  块级
            if (text[i] === '$' && text[i + 1] === '$') {
                var e2 = text.indexOf('$$', i + 2);
                if (e2 > i + 1) {
                    var body = text.slice(i + 2, e2);
                    if (body.trim()) {
                        holds.push('<span class="math math-block">' +
                            tex(body) + '</span>');
                        out += '\u0001H' + (holds.length - 1) + '\u0001';
                        i = e2 + 2;
                        continue;
                    }
                }
                // 没闭合：原样吐出，别吞掉后面的正文
                out += text[i]; i++; continue;
            }

            // $ ... $  行内
            if (text[i] === '$') {
                var e1 = text.indexOf('$', i + 1);
                // 行内公式不能跨行，且不能是空的
                if (e1 > i + 1 && text.slice(i + 1, e1).indexOf('\n') < 0) {
                    var b1 = text.slice(i + 1, e1);
                    if (b1.trim()) {
                        holds.push('<span class="math math-inline">' +
                            tex(b1) + '</span>');
                        out += '\u0001H' + (holds.length - 1) + '\u0001';
                        i = e1 + 1;
                        continue;
                    }
                }
                out += text[i]; i++; continue;
            }

            out += text[i]; i++;
        }
        return out;
    }

    /**
     * Markdown 渲染
     *
     * 块级：代码块 / 标题 / 列表 / 任务列表 / 引用 / 表格 / 分隔线 / 图片
     * 行内：粗体 斜体 删除线 高亮 code 链接 裸URL
     *
     * ★ 顺序极重要：先 esc，再做语法替换。
     *   esc 之后字符串里已经没有真实标签了，此时生成的 <b>/<pre>
     *   全是我们自己造的 —— 用户输入里的 <script> 早已变成
     *   &lt;script&gt;，不可能被当标签执行。反过来先替换后转义就完蛋了。
     *
     * ★ 占位符机制：code / 图片 / 链接 都先抽成 \u0001Hn\u0001 存进 holds。
     *   两个原因 ——
     *     a) 代码块里的 * _ # 不该被当 markdown（否则 a*b*c 变成斜体）
     *     b) 链接里的 URL 不该被"裸URL自动链接"再包一层 <a>，
     *        否则 <a href="http.."> 里面又套一个 <a>，结构直接烂掉
     *   所以顺序必须是：code → 图片 → 链接 → 裸URL → 强调。
     */
    function md(s) {
        if (s === null || s === undefined) return '';
        var holds = [];   // 存抽出来的 HTML 片段（代码块 / 行内 code）

        function inline(x) {
            // ⓪ 数学公式（最先 —— \ { } ^ _ 不能被后面的规则碰）
            x = extractMath(x, holds);

            // ① 行内 code（最优先，内容原样，不接受任何后续规则）
            x = x.replace(/`([^`\n]+)`/g, function (m, c) {
                holds.push('<code>' + c + '</code>');
                return '\u0001H' + (holds.length - 1) + '\u0001';
            });

            // ② 图片 ![alt](url)
            x = x.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, function (m, alt, u) {
                if (!/^https?:\/\//i.test(u)) return m;
                holds.push('<img class="msg-img" src="' + esc(u) + '"' +
                    ' alt="' + esc(alt) + '" loading="lazy">');
                return '\u0001H' + (holds.length - 1) + '\u0001';
            });

            // ③ [文字](url) —— 也必须占位，否则第④步会把 href 里的
            //    URL 又识别成裸链接，套出 <a><a> 这种烂结构
            x = x.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (m, t, u) {
                if (!/^https?:\/\//i.test(u)) return m;
                holds.push('<a href="' + esc(u) + '"' +
                    ' target="_blank" rel="noopener">' + t + '</a>');
                return '\u0001H' + (holds.length - 1) + '\u0001';
            });

            // ④ 裸 URL 自动成链接
            x = x.replace(/(^|[\s(])(https?:\/\/[^\s<)"'\]]+)/g,
                function (m, pre, u) {
                    holds.push('<a href="' + u + '"' +
                        ' target="_blank" rel="noopener">' + u + '</a>');
                    return pre + '\u0001H' + (holds.length - 1) + '\u0001';
                });

            // ⑤ 强调类
            x = x.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
            x = x.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
            x = x.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
            x = x.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
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
                if (list) { out += '</' + (list === 'ulTask' ? 'ul' : list) + '>'; list = null; }
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

                // ★ 整行就一张图 → 块级吐出，别裹进 <p>
                //   占位符是在 inline() 里才生成的，而整行判定在这之前，
                //   所以这里得直接认 markdown 原文，不能靠占位符判断。
                if (/^!\[[^\]\n]*\]\(https?:\/\/[^)\s]+\)$/i.test(rt)) {
                    flushP(); closeL();
                    out += inline(esc(rt));
                    continue;
                }
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
                // ★ 任务列表必须排在普通 ul 之前：
                //   '- [ ] x' 同样满足 /^[-*+]\s+/，放后面就永远轮不到
                var tk = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(rt);
                if (tk) {
                    flushP();
                    if (list !== 'ulTask') {
                        closeL();
                        out += '<ul class="task">';
                        list = 'ulTask';
                    }
                    var done = tk[1].toLowerCase() === 'x';
                    // disabled：只是展示 AI 给的结果，不是让你真去勾选
                    out += '<li class="task-item' + (done ? ' done' : '') + '">' +
                        '<input type="checkbox" disabled' + (done ? ' checked' : '') + '>' +
                        inline(esc(tk[2])) + '</li>';
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
                // 语言标记（```python）。字符集要含 + # - . 否则 c++ / c# 认不出
                var lm = /^([a-zA-Z0-9+#._-]*)\n/.exec(parts[i]);
                var lang = lm ? lm[1] : '';
                var code = parts[i].replace(/^[a-zA-Z0-9+#._-]*\n/, '');
                // 含换行 = 块级 <pre>；不含 = 行内 <code>
                var isBlock = code.indexOf('\n') >= 0;
                if (isBlock) {
                    holds.push(
                        '<div class="codeblk">' +
                          '<div class="code-top">' +
                            '<span class="lang">' + esc(lang || 'code') + '</span>' +
                            '<button class="copy-btn" type="button">复制</button>' +
                          '</div>' +
                          '<pre><code>' + esc(code) + '</code></pre>' +
                        '</div>');
                } else {
                    holds.push('<code>' + esc(code) + '</code>');
                }
                body += '\u0001H' + (holds.length - 1) + '\u0001';
            } else {
                // ★ 公式必须在代码块之外、esc 之前抽
                //   代码里的 $ 是 shell 变量，不能被当公式
                body += extractMath(parts[i], holds);
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
    /**
     * 复制文本
     * navigator.clipboard 只在 HTTPS / localhost 下有 —— Pages 是 HTTPS，
     * 但万一被人用 file:// 打开就退化到 execCommand，别直接失败。
     */
    function copyText(t) {
        if (global.navigator && global.navigator.clipboard && global.isSecureContext) {
            return global.navigator.clipboard.writeText(t);
        }
        return new Promise(function (res, rej) {
            try {
                var ta = doc.createElement('textarea');
                ta.value = t;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                doc.body.appendChild(ta);
                ta.select();
                var ok = doc.execCommand('copy');
                doc.body.removeChild(ta);
                ok ? res() : rej(new Error('copy failed'));
            } catch (e) { rej(e); }
        });
    }

    /**
     * 事件委托：复制按钮 + 图片失败
     * 用委托而不是逐个绑定，是因为流式输出会不断重建 innerHTML，
     * 逐个绑的话每次重绘都要重绑一遍，还容易漏。
     */
    function bindBub() {
        var box = $('msgs');

        box.addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('.copy-btn') : null;
            if (!btn) return;
            var blk = btn.closest('.codeblk');
            var pre = blk && blk.querySelector('pre');
            if (!pre) return;
            copyText(pre.textContent).then(function () {
                btn.textContent = '已复制';
                btn.classList.add('done');
                global.setTimeout(function () {
                    btn.textContent = '复制';
                    btn.classList.remove('done');
                }, 1400);
            }).catch(function () {
                btn.textContent = '失败';
                global.setTimeout(function () { btn.textContent = '复制'; }, 1400);
            });
        });

        // ★ 图片加载失败：error 不冒泡，必须用捕获阶段监听
        box.addEventListener('error', function (e) {
            var t = e.target;
            if (t && t.tagName === 'IMG' && t.classList.contains('msg-img')) {
                t.classList.add('img-err');
                t.alt = t.alt || '图片加载失败';
            }
        }, true);
    }

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
                    // ★ 节流：AI 一次能吐几百个 delta，每个都全量重渲染
                    //   + 重排 DOM，长回复会明显掉帧。60ms 一档，
                    //   肉眼看不出延迟，但渲染次数能降一个数量级。
                    schedRender(holder, full);
                }
            });
            holder.innerHTML = flushRender(holder, full);
            msgs.push({ role: 'assistant', text: full });
            save();
        } catch (e) {
            if (e && e.name === 'AbortError') {
                holder.innerHTML = flushRender(holder, full) +
                    '<div class="meta">已停止</div>';
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

    // ── 流式渲染节流 ──────────────────────────────────────
    var rTimer = null, rLast = 0;
    var R_MS = 60;                 // 一档 60ms

    function paint(holder, txt) {
        holder.innerHTML = md(txt) + '<span class="cursor"></span>';
        bottom();
    }
    function schedRender(holder, txt) {
        var now = Date.now();
        // 距上次够久 → 立刻画（避免小回复也要等一整档）
        if (now - rLast >= R_MS) {
            rLast = now;
            paint(holder, txt);
            return;
        }
        if (rTimer) return;        // 已有待画的了，别重复排队
        rTimer = global.setTimeout(function () {
            rTimer = null;
            rLast = Date.now();
            paint(holder, txt);
        }, R_MS - (now - rLast));
    }
    /** 流结束时立刻收尾，不能让最后一截卡在节流里 */
    function flushRender(holder, txt) {
        if (rTimer) { global.clearTimeout(rTimer); rTimer = null; }
        rLast = Date.now();
        return md(txt);
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
        bindBub();
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
