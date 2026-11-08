# MyAgent Personal Agent（MVP 0.2）

可自托管、模块化的个人智能体基础系统。它不是任意命令执行器，也不包含真实交易、转账、发帖或 Windows 桌面控制。

新增只读 A 股量化页面：`http://127.0.0.1:8000/quant`。它可按三个月平均换手率、近期成交量异动和异动前总市值扫描全市场，并查看 5–45 日日 K 线；不包含下单或自动交易能力。

## 已完成

- FastAPI 中文控制台、令牌认证、健康检查与审计日志。
- 多模型统一调用入口：OpenAI、DeepSeek、通义千问（DashScope）、SiliconFlow、OpenRouter、Kimi（Moonshot）；支持主模型与故障自动回退，超时/限流/网络错误均脱敏处理。
- 有界 Agent 循环、相关记忆检索、对话保留上限、模型工具调用。
- 独立工具注册表：JSON 参数校验、权限/风险/超时元数据、工具调用记录；未提供 shell、任意 URL 或任意文件访问工具。
- SQLite 持久化：对话、记忆、任务、审批、工具调用、审计、财务/行情预留表。所有时间以 UTC 保存；提醒记录来源时区。
- 高风险操作只能入审批队列；审批记录审批人、时间和幂等键，重复审批或重复请求不会执行外部动作。
- APScheduler 定期处理一次性任务；服务启动时将中断中的任务恢复为 pending。
- Docker、数据库卷、健康检查、备份/恢复脚本和自动化测试。

## 本地 Windows 开发

需要 Python 3.12（3.11 也通常可用）。在本目录执行：

```powershell
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
# 用安全随机字符串替换 ADMIN_TOKEN；按需填写 OPENAI_API_KEY
pytest -q
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

打开 http://127.0.0.1:8000 并输入 `ADMIN_TOKEN`。无 API Key 时聊天会明确失败，不会伪造成功；记忆、审批和任务 API 仍可使用。不要提交 `.env`。

### 配置模型 API

登录控制台后，在“模型平台与 API Key”区域直接填写。密钥仅提交到服务端，页面和读取接口都不会回显；保存后立即生效，无须重启服务。可把顺序设置为例如 `openai,deepseek,dashscope`，前一个不可用时才会尝试后一个。不要把任何 API Key 发送到聊天、截图或提交到 Git。

当前接入的六个平台均采用 OpenAI 兼容接口。Anthropic、Google Gemini 等非兼容接口需要增加独立适配器，尚未实现。

## Docker / 腾讯云 Ubuntu

1. 安装 Docker Engine 和 Compose plugin；复制 `.env.example` 到 `.env`，设置长随机 `ADMIN_TOKEN`。模型 API Key 既可先写入环境变量，也可在首次登录后从控制台填写。
2. `docker compose up -d --build`，用 `docker compose ps`、`docker compose logs -f` 检查状态。
3. 当前 Compose 仅绑定 `127.0.0.1:8000`。不要开放 8000、SQLite 或 RDP 到公网。腾讯云安全组仅保留 SSH（最好限定来源）和 Tailscale 所需出站访问。
4. 安装并登录 Tailscale：`curl -fsSL https://tailscale.com/install.sh | sh`，随后 `sudo tailscale up`。从已加入同一 tailnet 的手机/电脑访问服务器 Tailnet IP 的 8000 端口；可用 Tailscale Serve 或反向代理启用 HTTPS。请按 Tailscale 当前官方文档配置 ACL，只允许自己的设备。
5. 每月更新系统和镜像：`sudo apt update && sudo apt upgrade`，`docker compose pull && docker compose up -d`；先在备份/测试环境验证更新。

## 数据、备份与恢复

数据卷为 `./data`，默认数据库 `data/myagent.db`。备份（服务可保持运行）：

```powershell
python scripts/backup.py
```

恢复前停止服务，随后运行 `python scripts/restore.py backups/文件名.db`，再启动服务。备份包含个人数据，应加密后异地保存；不包含 `.env` 密钥。生产迁移到 PostgreSQL 时请以本仓储表结构为基线并采用 Alembic/受控迁移。

## API 与安全边界

`/api/health` 无认证；其余 API 使用登录会话或 `X-Admin-Token`。`/docs` 仅限私人网络访问。当前审批的“批准”仅记录决定，**不会**执行外部副作用。浏览器、市场、金融、Windows worker 均在 `app/modules/` 作为预留接口；Windows worker 必须是家庭电脑主动出站、经双向认证连接的独立进程，且限制应用/窗口/目录，绝不暴露 RDP。

## 下一阶段

先加入数据库迁移工具、用户身份/会话与限流，再分别实现网站白名单浏览器草稿流程、模拟行情/模拟交易、通知通道和经过独立威胁建模的 Windows worker。连接真实券商、银行或发布平台前，需要专门的执行器、额度、二次确认、回滚/幂等与端到端审计测试。
