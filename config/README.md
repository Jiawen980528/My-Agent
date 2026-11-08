# MyAgent 交接配置说明

本目录是配置入口。源码、页面、数据库结构和启动文件已经包含在本交接包中。

## 使用方法

1. 复制项目根目录的 `.env.example` 为 `.env`。
2. 在 `.env` 中填写实际令牌；不要把真实令牌写入源码、Git 或公开压缩包。
3. 运行前端和后端前，确认 `DATA_DIR` 指向本项目的数据目录。
4. 需要外部 TickFlow 桥接时，填写 `TICKFLOW_BRIDGE_URL` 和 `TICKFLOW_BRIDGE_TOKEN`。
5. 需要 MyAgent 主服务联动时，填写 `MYAGENT_BRIDGE_URL` 和 `MYAGENT_ADMIN_TOKEN`。

## 令牌对应关系

| 配置项 | 用途 | 读取位置 |
| --- | --- | --- |
| `TICKFLOW_API_KEY` | TickFlow 行情、分钟K、财务等授权能力 | `backend/app/secrets_store.py` |
| `AI_API_KEY` | AI 服务 | AI provider 配置 |
| `AUTH_PASSWORD` | 本地/服务器登录初始化密码 | 服务启动配置 |
| `TICKFLOW_BRIDGE_TOKEN` | 量化页面调用 TickFlow 桥接服务 | MyAgent bridge 配置 |
| `MYAGENT_ADMIN_TOKEN` | 看板调用 MyAgent 主服务 | `backend/app/api/myagent_bridge.py` |

本包不包含真实令牌。其他软件可以直接依据 `.env.example` 和本文件找到全部配置入口。

## 数据源规则

- 个股、ETF、指数实时/分钟行情：优先 TickFlow。
- 行业/概念名称及成分映射：可使用 `https://files.688798.xyz/ths/` 的 `industries.json` 与 `concepts.json`。
- 行业/概念实时曲线：当前 TickFlow 没有独立板块行情接口，必须使用成分股 TickFlow 行情本地聚合，或明确标注其他板块行情源。
- 资金流向：必须标明供应商、统计口径、更新时间，不能由普通K线推算。
- PTrade/QMT：只保留接入目录和说明，不执行自动交易。
