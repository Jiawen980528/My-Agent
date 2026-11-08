# MyAgent 交接说明

更新时间：2026-11-03（中国标准时间）

这份文件用于在新电脑上继续维护 MyAgent。它**不包含**管理令牌、模型 API Key、QQ 邮箱授权码或 SSH 私钥；这些敏感信息请单独、安全地迁移。

## 当前成果

项目是一个运行在本机和腾讯云轻量应用服务器上的个人 AI 工作台。

- 本地地址：`http://127.0.0.1:8000`
- 服务端：腾讯云 Lighthouse，Ubuntu 24.04，南京区域，4 核 CPU / 8 GB 内存 / 120 GB SSD / 10 Mbps
- 服务端项目目录：`/opt/myagent`
- 本地项目目录：`D:\我的文档\桌面\MyAgent\MyAgent`
- 域名：`xdailab.com`
- 已配置的子域名：`agent.xdailab.com`

> `https://agent.xdailab.com` 已完成备案并在线运行。Caddy 将该域名反向代理到 `127.0.0.1:8000`；不要用新项目覆盖 `/opt/myagent`、`myagent` 容器或 8000 端口。

## 2026-11-03 当前部署与下一步

- MyAgent：`/opt/myagent`，Docker 容器名 `myagent`，仅监听 `127.0.0.1:8000`，当前健康。
- Caddy：`agent.xdailab.com -> 127.0.0.1:8000`。
- 下一项目：Tick Stock Panel，目标域名 `quant.xdailab.com`。
- Tick Stock Panel 必须使用独立目录（建议 `/opt/tick-stock-panel`）、独立容器名和独立回环端口（建议 `127.0.0.1:8001`）。
- 当前 DNS 尚未发现 `quant.xdailab.com` 记录，部署前需添加指向服务器公网 IP 的 A 记录。
- Tick Stock Panel 源码仓库由用户确认为 `VFNNGEY/tickflow-stock-panel`，源码 ZIP 已解压到 `D:\我的文档\桌面\MyAgent\TickStockPanel\tick-stock-panel-main`，仅作为交互与看盘效果参考。
- 用户已明确：不直接加载或原样部署 Tick Stock Panel；后续应在 MyAgent 的量化页面中借鉴其仪表盘、云图、分栏和交互思路，做原生实现。
- Tick Stock Panel 的源码构建曾在服务器上尝试，但已停止；没有创建 `tick-stock-panel` 容器，也没有修改现有 `myagent` 容器。

## 已实现功能

### 工作台界面

- 左侧导航：概览、AI 助理、邮箱、内容与资讯、账户与账单、自动化、设置。
- AI 助理采用聊天形式：Enter 发送，Shift + Enter 换行。
- 支持附加最多 5 个文件，每个不超过 3 MB。
- 文本附件支持 `.txt`、`.md`、`.csv`、`.json`、`.log`，内容会作为对话上下文传给模型。
- 图片支持上传 `.png`、`.jpg`、`.jpeg`、`.webp`、`.gif`；当前 DeepSeek 文本模型不能识别图片像素，需要以后配置视觉模型。
- Markdown 回复会渲染标题、列表、加粗、表格和新闻链接，不再原样显示超长 Markdown/URL。
- 本地浏览器可记住登录状态 180 天；“退出此设备”会正确清除本地 HTTP Cookie。

### 模型平台

已支持并可在“设置”中配置：

- OpenAI
- DeepSeek（当前已在本机配置并测试成功）
- 通义千问 DashScope
- 硅基流动
- OpenRouter
- Moonshot / Kimi

模型支持主备顺序与故障切换。API Key 写入本地受限配置，不会在页面回显。

### QQ 邮箱

- 使用 QQ 邮箱 IMAP/SMTP **授权码**连接，绝不能填写 QQ 登录密码。
- 收件箱浏览、未读摘要、正文预览、勾选或单封“标为已读”。
- 邮件正文会过滤脚本/网页源码，避免出现大段 JavaScript。
- AI 可读取未读邮件摘要。
- AI 可准备发信申请；在“待确认操作”中核对收件人、主题、正文后，点击“批准并执行”才会通过 QQ SMTP 发送。
- 不会静默发送邮件。

### 联网新闻

- 已注册 `search_latest_news` 工具。
- 用户询问“今天新闻”“国际新闻”“某主题最新消息”等时，Agent 可通过公开 RSS 新闻源联网检索并总结。
- 当前是受控新闻检索，不是任意网页浏览器；X 官方 API、指定 RSS 和更完整的搜索将作为后续功能。

### A 股量化选股

- 独立页面：`http://127.0.0.1:8000/quant`，主页左侧也有入口。
- 默认规则：异动前 60 个交易日中每个交易日的换手率均不高于 1.5%，最近 3 日日均成交量不低于此前 20 日日均量的 2 倍，异动前总市值低于 100 亿元。全市场股票都进入 AKShare 历史扫描，不再用当天量比预筛。
- 支持调整参数、展示符合数量与股票列表，并查看 5、10、15……45 日日 K 线。
- 行情为公开只读数据并设有备用源与 10 分钟缓存；首次全市场扫描可能需要 1–4 分钟。
- 仅用于研究，不具备下单、自动交易或券商连接能力。

### 安全机制

- 高风险操作使用审批队列。
- QQ 发信已实现“批准并执行”。
- 发布内容、删除、支付、转账、证券交易等目前**不会自动执行**。
- 不应向任何人或任何聊天窗口发送：`ADMIN_TOKEN`、模型 API Key、QQ 授权码、`Agent.pem` 私钥。

## 暂未实现 / 后续计划

1. 小红书：先实现选题、文案、素材和草稿；只接官方允许的能力，不用非官方爬虫或绕过登录。
2. X / 国际新闻：接入官方 X API 或用户指定 RSS 源。
3. 市场数据：接入合规行情、新闻和提醒；不做自动交易。
4. 微信、支付宝、淘宝账单：优先使用官方授权、只读接口或用户导出的账单文件；不收集账户密码。
5. 视觉模型：配置支持图像输入的模型后，让 AI 分析截图和图片附件。
6. 自动化：邮件摘要、新闻晨报、市场提醒等；涉及外部操作时仍要求确认。
7. 服务端部署：将本地最新变更同步到 `/opt/myagent`，并在 ICP 备案完成后恢复 `https://agent.xdailab.com`。

## 关键文件

```text
app/main.py                 FastAPI 路由、登录、聊天、邮箱、上传
app/agent.py                模型调用、工具循环、系统提示词
app/tools.py                允许 Agent 调用的工具注册表
app/static.html             单页工作台界面
app/modules/qq_mail.py      QQ IMAP/SMTP 收发与正文提取
app/modules/web_news.py     公开 RSS 新闻搜索
app/attachment_store.py     聊天附件本地存储与文本上下文
app/email_store.py          QQ 授权信息本地存储
app/provider_store.py       模型 Key/模型名称/主备顺序本地存储
app/config.py               环境与本地配置
tests/                      自动化测试
.env                        本地敏感运行配置（不要提交/公开）
data/                       本地数据库、模型配置、邮箱授权、附件（敏感）
```

## 新电脑迁移步骤

### 1. 复制项目

复制整个 `MyAgent` 项目目录到新电脑，例如：

```text
C:\Users\<你的用户名>\Desktop\MyAgent\MyAgent
```

不建议通过公开网盘、邮件或聊天软件传输整个 `data/` 目录，因为里面可能含模型 Key、QQ 授权码和本地数据。

### 2. 安装运行环境

- 安装 Python 3.11 或更高版本。
- 在项目目录中创建虚拟环境并安装依赖：

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 3. 创建新电脑的 `.env`

在项目根目录创建 `.env`，最少包含：

```dotenv
ADMIN_TOKEN=请自行设置一个长随机密码
DATABASE_PATH=./data/myagent-local.db
TIMEZONE=Asia/Shanghai
MODEL_PROVIDER=deepseek
MODEL_FALLBACK_PROVIDERS=openai,dashscope
```

`ADMIN_TOKEN` 是工作台登录密码，不是模型 Key，也不是 QQ 授权码。

### 4. 配置模型和邮箱

启动后，在网页“设置”中重新填写模型 API Key。

QQ 邮箱需要重新填写：

- QQ 邮箱地址
- QQ 邮箱 IMAP/SMTP 授权码

如果确实需要迁移旧数据，请只在加密 U 盘或受信任的离线方式下迁移 `.env` 和 `data/`；迁移后确认文件权限与设备安全。

### 5. 启动本地服务

在项目根目录执行：

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

浏览器打开：`http://127.0.0.1:8000`

第一次在“设置”中输入 `.env` 的 `ADMIN_TOKEN`，勾选“在此私人设备记住 180 天”，点击“连接”。

### 6. 测试

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

当前代码最近一次验证为：**32 项测试通过**。

## 服务器连接（新电脑）

服务器使用 SSH 密钥登录，用户名通常为 `ubuntu`。

1. 在旧电脑运行 `scripts\create-key-bundle.ps1`，生成项目内被 Git/Docker 排除的加密迁移包。
2. 把迁移密码单独保存在密码管理器中；不要写进项目或聊天记录。
3. 新电脑运行 `scripts\restore-key-bundle.ps1`，恢复到 `%USERPROFILE%\.ssh`。
4. 当前部署使用 `MyAgent-Deploy-2026`；空的 `Agent.pem` 无效且不会进入迁移包。
5. PowerShell 示例：

```powershell
ssh -i $env:USERPROFILE\.ssh\MyAgent-Deploy-2026 ubuntu@<腾讯云实例公网IP>
```

如果私钥丢失，不要尝试猜测或泄露；在腾讯云控制台重新绑定新密钥，或通过控制台登录后修复。

## 当前端口/防火墙建议

- `22/TCP`：SSH，建议限制为自己的公网 IP。
- `80/TCP` 与 `443/TCP`：仅在域名备案完成、需要对外提供网站时开放。
- Ping 不是必需功能，可按需要关闭。
- 本地开发只使用 `127.0.0.1:8000`，不会对局域网或公网监听。

## 常见问题

### “Unauthorized”

在“设置”中重新输入 `.env` 里的 `ADMIN_TOKEN`，点击“连接”。本机页面刷新后通常会由 Cookie 保持会话。

### 域名打不开

先检查 ICP 备案进度。中国大陆服务器对未备案域名可能显示拦截页，即使 DNS、Caddy、证书均正确。

### AI 回复“没有权限”

检查“设置”里的工具列表和对应平台是否已连接。模型本身不会天然拥有邮箱、社交平台、资金账户或浏览器权限，必须给 MyAgent 增加并授权相应的工具。

### 图片无法分析

MyAgent 已支持图片附件并可转发给已配置的视觉模型；若当前模型不支持图片，检查千问 DashScope 视觉模型配置及 `app/agent.py` 的模型选择。量化页的统一文字对话目前仍需补齐图片上传入口。

## 交接时应提供给下一位开发者的信息

可以提供：本文件、项目源代码、功能目标、非敏感架构说明。

不要提供：任何真实 API Key、管理令牌、QQ 邮箱授权码、SSH 私钥、个人账单/邮件数据。

## 2026-11-06 量化联动更新

- `https://agent.xdailab.com/quant/` 继续由 TickFlow 容器提供；MyAgent 工作台保持原服务。量化 AI 助手默认走 TickFlow 的 `/api/myagent/chat` 反向桥接，再调用 MyAgent `/api/chat`，使用 MyAgent 已配置的模型及会话记忆；助手内可切换回 TickFlow 专业工具模式。工作台新增只读工具读取 TickFlow 市场概要、日 K、MyAgent 已记录持仓/筛选结果。
- 指数自选与均线开关通过 TickFlow UI preferences 保存；指数页可增删、手动调整或按代码/涨跌排序。看板与侧栏读取同一指数自选列表。
- 指数、股票、ETF 缺少授权分钟数据时，用东方财富公开行情的最近交易日分时作为后备，界面显示实际数据日期和来源；此源可能延迟，不保证历史分钟 K 或逐笔实时数据。`/api/index/public-minute` 与 `/api/kline/public-minute` 共用后备实现。
- `/quant/market-news` 是独立市场新闻页；看板仍可添加新闻窗口。新闻从东方财富滚动新闻页面定时读取，按持仓与板块名称文字关联，按标题关键词初判“可能利好/可能利空/待判断”及板块；用户可按方向、板块筛选并点选 AI 研判。标题初判不等于股价预测。金十数据等专有快讯尚未获得授权数据接入，不应标为已接入。
- 用户持仓仍为 MyAgent 手工记录，非国金/PTrade/QMT 自动同步；实时交易和自动推送尚未接入。看板新闻组件可在“自定义布局 → 添加组件”添加；既有自定义布局不会被覆盖。
- 本次部署修改的源码已同步至 `/opt/myagent` 与 `/opt/tick-stock-panel`。重建服务镜像时请以这些源码为准，并核对两容器桥接环境变量；切勿把令牌写进前端或交接文档。
