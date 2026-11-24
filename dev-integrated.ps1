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
    $MyAgentRoot = [IO.Path]::GetFullPath((Join-Path $Root '..\..\MyAgent'))
}

function Require-Path([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$Description 不存在：$Path"
    }
}

function Port-InUse([int]$Port) {
    return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

Require-Path (Join-Path $Root 'dev.ps1') 'TickFlow 启动脚本'
if (-not $SkipMyAgent) {
    Require-Path (Join-Path $MyAgentRoot 'app\main.py') 'MyAgent 服务源码'
    Require-Path (Join-Path $MyAgentRoot '.env') 'MyAgent .env 配置'
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
    Write-Host "TickFlow 启动器已运行，前端地址：http://localhost:$TickFlowFrontendPort/quant/" -ForegroundColor Green
    Write-Host '关闭本窗口不会自动结束服务；请在 TickFlow 启动窗口按 Ctrl-C 停止。' -ForegroundColor DarkGray
} catch {
    foreach ($child in $children) {
        try { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    throw
}
