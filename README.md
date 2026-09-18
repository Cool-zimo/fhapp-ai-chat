# AI 聊天 · FaceHub 小程序

一个能塞进 FaceHub 的聊天小程序：填自己的 AI Key、选模型、直接聊。
默认支持**智谱 GLM 的免费模型**。

🔗 https://cool-zimo.github.io/fhapp-ai-chat/

---

## 三步跑起来

### 1. 拿 Key

去 https://open.bigmodel.cn/ 注册 → API 密钥 → 创建。
复制那个 `sk-` 开头的字符串（只显示一次）。

### 2. 部署代理（智谱必需，别跳过）

**为什么必须**：智谱的接口不允许浏览器直连。带 `Authorization` 的
POST 会先发 OPTIONS 预检，而智谱的预检响应没放行这个头 → 浏览器直接拦掉。
这是服务端策略，代码层面绕不过去。

**怎么做**：把本仓库的 `worker.js` 贴进 Cloudflare Worker，约一分钟：

1. https://cloudflare.com 注册（免费，不要信用卡）
2. Workers 和 Pages → 创建 → 创建 Worker → 起名 → 部署
3. 编辑代码，整个粘贴 `worker.js`，保存并部署
4. 拿到 `https://ai-proxy.你的名字.workers.dev`
5. 填进小程序的「代理地址」

免费额度每天 10 万次请求，个人用不完。

> ⚠️ 别用网上那些公开的 CORS 代理（corsproxy.io 之类）。
> 你的 Key 会从别人的服务器过一遍，等于把钥匙交出去。
> 自己的 Worker 才是自己的。

### 3. 用

打开小程序 → ⚙ 设置 → 填 Key → 填代理地址 → **测试连接**。
测试通过就能聊了。

---

## 免费模型

来自智谱官方文档的模型概览：

| 模型 | 上下文 | 说明 |
|---|---|---|
| `glm-4-flash-250414` | 128K | 永久免费，通用 |
| `glm-4.7-flash` | 200K | 免费，编程更强 |
| `glm-4.5-flash` | 128K | 免费，即将下线 |
| `glm-4.6v-flash` | 128K | 免费，视觉，可看图 |
| `glm-4v-flash` | 16K | 免费，视觉 |

付费的（GLM-4.6 / GLM-4.5-Air 等）也能选，会标出来。

---

## 常见问题

**「请求发不出去」**
就是跨域。填代理地址。

**「Key 无效」**
重新生成一个，注意别复制到首尾空格。

**「HTTP 404」**
地址错了。智谱是 `/api/paas/v4`，不是 `/v1`。

**「被限流」**
免费模型有并发上限（30），等一下再试。

---

## 安全

- Key 存在浏览器 localStorage，只在这台机器，不上传任何地方
- 但能打开 devtools 的人就能看见 —— 这是 BYOK 的固有代价
- 代理是你自己的 Worker，钥匙不过第三方

## 其它厂商

设置里可切 DeepSeek、或自定义 OpenAI 兼容端点
（填 Base URL + 模型名）。它们同样不允许浏览器直连，
所以代理该填还得填。

Anthropic 是个例外：加 `anthropic-dangerous-direct-browser-access: true`
头就能直连，不用代理 —— 但它没有免费模型。
