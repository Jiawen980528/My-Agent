"""扩展点：单独部署在家中 Windows 电脑的桌面执行器。
Linux 云服务器无法直接操作家中 Windows 桌面；应由 Windows worker 主动建立认证出站连接。
不要将 RDP 直接暴露到公网。
"""
def execute_desktop_job(job: dict) -> dict:
    raise NotImplementedError("MVP 未包含 Windows worker。")
