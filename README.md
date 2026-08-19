# 苏格拉底提问词 · Socratic Questioner

不给你答案，只问到你真正懂为止。

把任何长篇专业文档交给它：AI **不直接总结**，而是像苏格拉底一样一次只问一个问题，按
**事实 → 解释 → 应用 → 评价** 四个理解层级递进引导；答错时给线索、不直接给答案；
最后由 AI 终审判断你是否"真正弄懂"。支持 **粘贴文本 / 上传文件（PDF·Word·TXT）/ 网页链接** 三种输入。

## 架构

```
单文件前端 index.html（GitHub Pages 静态托管）
        │  POST /ask（文档 + 对话历史 + 层级）
        │  POST /fetch（抓取网页正文，绕过 CORS）
        ▼
Cloudflare Worker（轻代理，持有 API Key secret）
        │  OpenAI 兼容接口（chat/completions）
        ▼
OpenAI / DeepSeek / Kimi … 任意兼容模型
```

- **API Key 只存在于 Worker 的 secret 里**，浏览器端不接触，DevTools 里看不到。
- 文档解析（PDF/Word/TXT）全部在浏览器本地完成，文件不会上传。
- 会话历史保存在浏览器 `localStorage`，刷新页面可继续；可一键导出 Markdown。

## 目录

```
index.html        单文件应用（内联 CSS/JS + 主视觉 SVG）
assets/hero.svg   主视觉源文件（撕纸拼贴 · 苏格拉底胸像）
worker/index.js   Cloudflare Worker（/ask /fetch /health）
worker/wrangler.toml
```

## 部署

### 1. 前端 → GitHub Pages

```bash
git init -b main
git add . && git commit -m "feat: socratic questioner v1"
git remote add origin https://github.com/<你的用户名>/socratic-questioner.git
git push -u origin main
```

然后在 GitHub 仓库 **Settings → Pages**：
- Source 选 **Deploy from a branch**，分支 `main`，目录 `/ (root)`，保存。
- 无需构建步骤，`index.html` 即站点首页。

### 2. Worker → Cloudflare

```bash
cd worker
npx wrangler login
npx wrangler deploy          # 首次部署，会创建 socratic-questioner worker
```

配置 secrets 与变量：

```bash
npx wrangler secret put API_KEY        # 必填：上游模型的 API Key
npx wrangler secret put ACCESS_CODE    # 可选：访问码（分享站点时建议设置）
```

可选变量（在 `wrangler.toml` 的 `[vars]` 或 Dashboard 里改）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BASE_URL` | `https://api.openai.com/v1` | 换 DeepSeek/Kimi 等时改为对应 OpenAI 兼容地址 |
| `ALLOWED_ORIGINS` | 空（允许所有） | 限制允许的前端来源，逗号分隔，如 `https://xxx.github.io` |

> 改完 `wrangler.toml` 里的 vars 后需要 `npx wrangler deploy` 重新发布。

### 3. 在网站里配置

打开站点 → 右上角 **⚙ 设置**，填入：

- **Worker 地址**：`https://socratic-questioner.<你的子域>.workers.dev`
- **模型名**：`gpt-4o-mini`（或你上游支持的任意模型）
- **访问码**：与 Worker 的 `ACCESS_CODE` 一致；没设置则留空

点"测试连接"，显示"✓ 连接正常（已配置 API Key）"即可使用。

## 替换主视觉（可选）

默认主视觉是手写 SVG（撕纸拼贴风格，内联在 `index.html` 的 `<svg class="hero-art">`）。
想换成 AI 生成的撕纸拼贴图：

1. 用 imagegen 按 scenes-gathered-zine 风格生成一张苏格拉底主题图（竖版 3:5 或横版均可）；
2. 压缩后转 base64：`base64 -i hero.png | pbcopy`；
3. 把 `index.html` 里的 `<svg class="hero-art">…</svg>` 整块替换为
   `<img class="hero-art" src="data:image/png;base64,……">`（class 不变即可）。
   若不想内联，也可改为 `<img class="hero-art" src="assets/hero.png">` 并保留该文件。

## 数据与隐私

- 浏览器 `localStorage`：`socratic:settings:v1`（设置，不含 Key）、`socratic:sessions:v1`（最近 12 个会话）。
- 文档文本与对话历史仅在调用 AI 时经 Worker 转发给上游模型；Worker 不落盘日志。
- 建议定期「导出对话」备份。

## 常见问题

- **"Worker 尚未配置 API Key"**：在 worker 目录执行 `npx wrangler secret put API_KEY` 后重新部署。
- **"访问码错误"**：站点设置里的访问码与 Worker 的 `ACCESS_CODE` 不一致。
- **PDF/Word 解析失败**：解析库按需从 CDN 加载，需联网；若网络受限请用"粘贴文本"。
- **网页链接抓取失败**：目标站点可能有反爬或返回非 HTML；可下载后上传。
