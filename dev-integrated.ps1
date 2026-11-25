# MyAgent + TickFlow 联合本机启动器（只读研究/提醒/模拟盘）
#
# 用法：
#   .\dev-integrated.ps1
#   .\dev-integrated.ps1 -MyAgentRoot 'D:\路径\MyAgent'
#   .\dev-integrated.ps1 -SkipMyAgent
#
# 该脚本不会读取或输出任何令牌，不连接券商，不执行真实交易。
# MyAgent 通过现有 MYAGENT_BRIDGE_URL / MYAGENT_ADMIN_TOKEN 代理配置接入 TickFlow。

[CmdletBinding()]
param(
    [string]$MyAgentRoot = '',
    [int]$MyAgentPort = 8000,
    [int]$TickFlowBackendPort = 3018,
    [int]$TickFlowFrontendPort = 3011,
    [switch]$SkipMyAgent
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($MyAgentRoot)) {
    # 交接包常见的目录布局是桌面\MyAgent\MyAgent；同时保留旧的
    # 桌面\MyAgent 布局，避免联合启动时找错主服务目录而丢失桥接。
    $candidates = @(
        [IO.Path]::GetFullPath((Join-Path $Root '..\..\MyAgent\MyAgent')),
        [IO.Path]::GetFullPath((Join-Path $Root '..\..\MyAgent'))
    )
    $MyAgentRoot = $candidates | Where-Object { Test-Path (Join-Path $_ 'app\main.py') } | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($MyAgentRoot)) { $MyAgentRoot = $candidates[0] }
}

function Require-Path([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$Description 不存在：$Path"
    }
}

function Read-DotEnvValue([string]$Path, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $escaped = [Regex]::Escape($Name)
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match "^\s*$escaped\s*=\s*(.*?)\s*$") {
            $value = $Matches[1].Trim() -replace '\s+#.*$', ''
            $value = $value.Trim()
            if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                return $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    return $null
}

function Port-InUse([int]$Port) {
    return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

Require-Path (Join-Path $Root 'dev.ps1') 'TickFlow 启动脚本'
if (-not $SkipMyAgent) {
    Require-Path (Join-Path $MyAgentRoot 'app\main.py') 'MyAgent 服务源码'
    Require-Path (Join-Path $MyAgentRoot '.env') 'MyAgent .env 配置'
}

# 本机只读桥接配置：由启动器在两个子进程之间注入，不落盘、不输出。
# 这样桌面系统的 HTTP_PROXY 不会把 127.0.0.1 服务间请求转走，也不会再因
# 忘记手工设置 MYAGENT_ADMIN_TOKEN / TICKFLOW_BRIDGE_TOKEN 而出现 502。
if (-not $SkipMyAgent) {
    $myAgentAdminToken = Read-DotEnvValue (Join-Path $MyAgentRoot '.env') 'ADMIN_TOKEN'
    if ([string]::IsNullOrWhiteSpace($myAgentAdminToken)) { throw 'MyAgent .env 未配置 ADMIN_TOKEN，无法建立本机只读桥接。' }
    # Windows PowerShell 5 对双引号字符串内的嵌套方法参数解析不稳定；
    # 拆成两步保持令牌生成方式不变。
    $bridgeId = [Guid]::NewGuid().ToString()
    $bridgeToken = "local-readonly-$bridgeId"
    $env:MYAGENT_BRIDGE_URL = "http://127.0.0.1:$MyAgentPort"
    $env:MYAGENT_ADMIN_TOKEN = $myAgentAdminToken
    $env:TICKFLOW_BRIDGE_URL = "http://127.0.0.1:$TickFlowBackendPort"
    $env:TICKFLOW_BRIDGE_TOKEN = $bridgeToken
    $env:NO_PROXY = "127.0.0.1,localhost;$($env:NO_PROXY)"
    $env:no_proxy = $env:NO_PROXY
}

$children = @()
try {
    if (-not $SkipMyAgent) {
        if (Port-InUse $MyAgentPort) {
            Write-Host "MyAgent 端口 $MyAgentPort 已被占用，复用现有服务。" -ForegroundColor Yellow
        } else {
            $python = Get-Command py -ErrorAction SilentlyContinue
            if (-not $python) { $python = Get-Command python -ErrorAction SilentlyContinue }
            if (-not $python) { throw '未找到 Python，请安装 Python 3.11/3.12 后再启动。' }
            $logDir = Join-Path $MyAgentRoot 'data\logs'
            New-Item -ItemType Directory -Force -Path $logDir | Out-Null
            $out = Join-Path $logDir 'myagent-integrated.out.log'
            $err = Join-Path $logDir 'myagent-integrated.err.log'
            $children += Start-Process -FilePath $python.Source -ArgumentList @('-3.12','-m','uvicorn','app.main:app','--host','127.0.0.1','--port', $MyAgentPort) -WorkingDirectory $MyAgentRoot -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
            Write-Host "MyAgent 已在后台启动：127.0.0.1:$MyAgentPort" -ForegroundColor Green
            Start-Sleep -Seconds 2
        }
    }

    # dev.ps1 自己负责 TickFlow 后端、前端和退出清理；这里用独立窗口保持其 Ctrl-C 语义。
    $tickflow = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $Root 'dev.ps1'),'-BackendPort',$TickFlowBackendPort,'-FrontendPort',$TickFlowFrontendPort,'-NoReload') -WorkingDirectory $Root -PassThru
    $children += $tickflow
    # Do not announce a usable service until both child listeners are ready.
    # The frontend can remain reachable from an older process while the backend
    # child has already exited, which otherwise looks like a healthy but broken UI.
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($tickflow.HasExited) { throw "TickFlow 启动脚本提前退出（ExitCode=$($tickflow.ExitCode)），请查看 data\logs\backend.err.log 和 frontend.err.log。" }
        if ((Port-InUse $TickFlowBackendPort) -and (Port-InUse $TickFlowFrontendPort)) { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw "TickFlow 服务未在 30 秒内同时监听 $TickFlowBackendPort/$TickFlowFrontendPort。请查看 data\logs\backend.err.log 和 frontend.err.log。" }
    Write-Host "TickFlow 服务已就绪，前端地址：http://localhost:$TickFlowFrontendPort/quant/" -ForegroundColor Green
    Write-Host '关闭本窗口不会自动结束服务；请在 TickFlow 启动窗口按 Ctrl-C 停止。' -ForegroundColor DarkGray
} catch {
    foreach ($child in $children) {
        try { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    throw
}
