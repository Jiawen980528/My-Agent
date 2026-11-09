# PTrade 只读桥接

这组文件只同步已登录 PTrade 会话中的持仓、行情、关联板块和成交记录，禁止下单、撤单或修改券商账户。

1. 在 PTrade 研究/策略 Python 环境运行 `readonly_snapshot_probe.py`，确认生成 `ptrade_readonly_snapshot.json`。
2. 在 Windows PowerShell 中设置桥接地址和服务端令牌：

```powershell
$env:MYAGENT_BRIDGE_URL = "https://你的域名/quant/api/bridge"
$env:TICKFLOW_BRIDGE_TOKEN = "服务端配置的桥接令牌"
py .\upload_readonly_snapshot.py .\ptrade_readonly_snapshot.json
```

3. 上传成功后，服务端只在内存中保存最新只读快照；它不会覆盖 MyAgent 的持仓、账户或交易流水数据库。

不同 PTrade 版本公开的只读函数名可能不同。探针会把缺失函数写入 `errors`，不会用行情涨跌推算账户或板块数据。若 PTrade 环境不允许写文件，请在研究环境中把输出文件下载到 Windows 后再运行上传脚本。
