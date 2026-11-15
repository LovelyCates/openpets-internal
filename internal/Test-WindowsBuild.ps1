[CmdletBinding()]
param(
    [switch]$ShowRequirements
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$requiredVariables = @(
    'OPENPETS_INTERNAL_ALLOWED_HOSTS',
    'OPENPETS_INTERNAL_NPM_REGISTRY',
    'OPENPETS_INTERNAL_ELECTRON_MIRROR',
    'OPENPETS_INTERNAL_ELECTRON_BUILDER_BINARIES_MIRROR',
    'OPENPETS_INTERNAL_PNPM_STORE',
    'OPENPETS_INTERNAL_ELECTRON_CACHE',
    'OPENPETS_INTERNAL_ELECTRON_BUILDER_CACHE',
    'OPENPETS_INTERNAL_GET_WINDOWS_BINARY',
    'OPENPETS_INTERNAL_GET_WINDOWS_SHA256',
    'npm_config_registry',
    'npm_config_store_dir',
    'npm_config_offline',
    'npm_config_ignore_scripts',
    'ELECTRON_MIRROR',
    'ELECTRON_BUILDER_BINARIES_MIRROR',
    'ELECTRON_CACHE',
    'ELECTRON_BUILDER_CACHE'
)

if ($ShowRequirements) {
    Write-Output 'Windows 内网构建预检所需的进程环境变量：'
    $requiredVariables | ForEach-Object { Write-Output "  $_" }
    Write-Output '此脚本只读；不会安装依赖、构建、发起 HTTP 下载或修改 pnpm 全局配置。'
    exit 0
}

$script:issues = New-Object 'System.Collections.Generic.List[string]'

function Add-Issue {
    param([string]$Message)
    $script:issues.Add($Message)
}

function Get-RequiredVariable {
    param([string]$Name)
    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ([string]::IsNullOrWhiteSpace($value)) {
        Add-Issue "$Name 未设置。"
        return $null
    }
    return $value.Trim()
}

function Test-InternalUrl {
    param(
        [string]$Name,
        [string]$Value,
        [string[]]$AllowedHosts,
        [bool]$RequireTrailingSlash
    )
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return
    }
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) {
        Add-Issue "$Name 不是有效的绝对 URL。"
        return
    }
    if ($uri.Scheme -ne 'https') {
        Add-Issue "$Name 必须使用 HTTPS。"
    }
    if ($uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        Add-Issue "$Name 不得包含账号、密码、查询参数或片段。"
    }
    if ($AllowedHosts -notcontains $uri.DnsSafeHost.ToLowerInvariant()) {
        Add-Issue "$Name 的主机 $($uri.DnsSafeHost) 不在 OPENPETS_INTERNAL_ALLOWED_HOSTS 中。"
    }
    if ($RequireTrailingSlash -and -not $Value.EndsWith('/')) {
        Add-Issue "$Name 必须以 / 结尾。"
    }
}

function Test-ExistingAbsolutePath {
    param(
        [string]$Name,
        [string]$Value,
        [string]$PathType
    )
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return
    }
    if (-not [System.IO.Path]::IsPathRooted($Value)) {
        Add-Issue "$Name 必须是绝对路径。"
        return
    }
    if (-not (Test-Path -LiteralPath $Value -PathType $PathType)) {
        Add-Issue "$Name 对应的$PathType 不存在：$Value"
        return
    }
    if ($PathType -eq 'Container' -and -not (Get-ChildItem -LiteralPath $Value -Force | Select-Object -First 1)) {
        Add-Issue "$Name 对应的目录为空：$Value"
    }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Add-Issue '必须在 Windows 构建机上运行。'
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
foreach ($file in @('LICENSE', 'pnpm-lock.yaml', 'package.json', '.gitmodules')) {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $file) -PathType Leaf)) {
        Add-Issue "缺少仓库文件：$file"
    }
}

$allowedHostsRaw = Get-RequiredVariable 'OPENPETS_INTERNAL_ALLOWED_HOSTS'
$allowedHosts = @()
if ($allowedHostsRaw) {
    $allowedHosts = @($allowedHostsRaw -split ',' | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
    if ($allowedHosts.Count -eq 0) {
        Add-Issue 'OPENPETS_INTERNAL_ALLOWED_HOSTS 至少需要一个主机名。'
    }
    foreach ($hostName in $allowedHosts) {
        if ($hostName.Contains('*') -or $hostName.Contains('/') -or $hostName.Contains(':')) {
            Add-Issue "允许列表只接受精确主机名：$hostName"
        }
        foreach ($publicDomain in @('github.com', 'githubusercontent.com', 'npmjs.org', 'npmjs.com', 'electronjs.org', 'openpets.dev')) {
            if ($hostName -eq $publicDomain -or $hostName.EndsWith(".$publicDomain")) {
                Add-Issue "允许列表包含已知公网域名：$hostName"
            }
        }
    }
}

$npmRegistry = Get-RequiredVariable 'OPENPETS_INTERNAL_NPM_REGISTRY'
$electronMirror = Get-RequiredVariable 'OPENPETS_INTERNAL_ELECTRON_MIRROR'
$builderMirror = Get-RequiredVariable 'OPENPETS_INTERNAL_ELECTRON_BUILDER_BINARIES_MIRROR'
Test-InternalUrl 'OPENPETS_INTERNAL_NPM_REGISTRY' $npmRegistry $allowedHosts $false
Test-InternalUrl 'OPENPETS_INTERNAL_ELECTRON_MIRROR' $electronMirror $allowedHosts $true
Test-InternalUrl 'OPENPETS_INTERNAL_ELECTRON_BUILDER_BINARIES_MIRROR' $builderMirror $allowedHosts $true

$activeMirrors = @(
    @('npm_config_registry', $npmRegistry),
    @('ELECTRON_MIRROR', $electronMirror),
    @('ELECTRON_BUILDER_BINARIES_MIRROR', $builderMirror)
)
foreach ($mirror in $activeMirrors) {
    $activeValue = Get-RequiredVariable $mirror[0]
    if ($activeValue -and $mirror[1] -and $activeValue -ne $mirror[1]) {
        Add-Issue "$($mirror[0]) 与对应内部镜像变量不一致；可能回退到其他源。"
    }
}

$cachePairs = @(
    @('OPENPETS_INTERNAL_PNPM_STORE', 'npm_config_store_dir'),
    @('OPENPETS_INTERNAL_ELECTRON_CACHE', 'ELECTRON_CACHE'),
    @('OPENPETS_INTERNAL_ELECTRON_BUILDER_CACHE', 'ELECTRON_BUILDER_CACHE')
)
foreach ($pair in $cachePairs) {
    $name = $pair[0]
    $path = Get-RequiredVariable $name
    Test-ExistingAbsolutePath $name $path 'Container'
    $activePath = Get-RequiredVariable $pair[1]
    if ($path -and $activePath -and [System.IO.Path]::GetFullPath($path) -ne [System.IO.Path]::GetFullPath($activePath)) {
        Add-Issue "$($pair[1]) 与 $name 不一致；可能使用未审批的缓存。"
    }
}

foreach ($name in @('npm_config_offline', 'npm_config_ignore_scripts')) {
    $value = Get-RequiredVariable $name
    if ($value -and $value.ToLowerInvariant() -ne 'true') {
        Add-Issue "$name 必须设置为 true。"
    }
}

$nativeBinary = Get-RequiredVariable 'OPENPETS_INTERNAL_GET_WINDOWS_BINARY'
Test-ExistingAbsolutePath 'OPENPETS_INTERNAL_GET_WINDOWS_BINARY' $nativeBinary 'Leaf'
$expectedNativeHash = Get-RequiredVariable 'OPENPETS_INTERNAL_GET_WINDOWS_SHA256'
if ($expectedNativeHash -and $expectedNativeHash -notmatch '^[0-9a-fA-F]{64}$') {
    Add-Issue 'OPENPETS_INTERNAL_GET_WINDOWS_SHA256 必须是 64 位十六进制 SHA-256。'
}
if ($nativeBinary -and (Test-Path -LiteralPath $nativeBinary -PathType Leaf)) {
    if ([System.IO.Path]::GetFileName($nativeBinary) -ne 'node-get-windows.node') {
        Add-Issue '原生二进制文件名应为 node-get-windows.node。'
    }
    if ($expectedNativeHash -match '^[0-9a-fA-F]{64}$') {
        $actualNativeHash = (Get-FileHash -LiteralPath $nativeBinary -Algorithm SHA256).Hash
        if ($actualNativeHash -ne $expectedNativeHash) {
            Add-Issue 'get-windows 原生二进制的 SHA-256 与审批值不一致。'
        }
    }
}

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Add-Issue '未找到 git。'
} else {
    & git -C $repoRoot merge-base --is-ancestor '163c80281c5c2739776773e4993516471bfd71cf' HEAD 2>$null
    if ($LASTEXITCODE -ne 0) {
        Add-Issue '当前 HEAD 不包含固定上游基线 163c80281c5c2739776773e4993516471bfd71cf。'
    }
    $submoduleStatus = & git -C $repoRoot submodule status 2>$null
    if ($LASTEXITCODE -ne 0 -or @($submoduleStatus | Where-Object { $_ -match '^[-+U]' }).Count -gt 0) {
        Add-Issue 'Git 子模块缺失、与固定提交不符或存在冲突。'
    }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Add-Issue '未找到 Node.js。'
} else {
    $nodeVersion = (& node --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) {
        Add-Issue "Node.js 版本不满足上游要求 >=20：$nodeVersion"
    }
}

$actualPnpmVersion = $null
$pnpmSource = $null
$corepack = Get-Command corepack -ErrorAction SilentlyContinue
if ($corepack) {
    $corepackGuardNames = @(
        'COREPACK_ENABLE_NETWORK',
        'COREPACK_ENV_FILE',
        'COREPACK_DEFAULT_TO_LATEST',
        'COREPACK_ENABLE_AUTO_PIN'
    )
    $previousCorepackValues = @{}
    foreach ($name in $corepackGuardNames) {
        $previousCorepackValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    try {
        [Environment]::SetEnvironmentVariable('COREPACK_ENABLE_NETWORK', '0', 'Process')
        [Environment]::SetEnvironmentVariable('COREPACK_ENV_FILE', '0', 'Process')
        [Environment]::SetEnvironmentVariable('COREPACK_DEFAULT_TO_LATEST', '0', 'Process')
        [Environment]::SetEnvironmentVariable('COREPACK_ENABLE_AUTO_PIN', '0', 'Process')
        $candidate = & $corepack.Source pnpm --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $candidate -match '^\d+\.\d+\.\d+$') {
            $actualPnpmVersion = [string]$candidate
            $pnpmSource = 'Corepack 离线缓存'
        }
    } catch {
        # 缓存不存在时保持失败关闭，再检查显式安装的 pnpm。
    } finally {
        foreach ($name in $corepackGuardNames) {
            [Environment]::SetEnvironmentVariable($name, $previousCorepackValues[$name], 'Process')
        }
    }
}
if (-not $actualPnpmVersion) {
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($pnpm) {
        $candidate = & $pnpm.Source --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $candidate -match '^\d+\.\d+\.\d+$') {
            $actualPnpmVersion = [string]$candidate
            $pnpmSource = '已安装的 pnpm'
        }
    }
}
if (-not $actualPnpmVersion) {
    Add-Issue '未找到可离线运行的 pnpm。请预置 Corepack 缓存或从内部工具链安装固定版本。'
} elseif (Test-Path -LiteralPath (Join-Path $repoRoot 'package.json') -PathType Leaf) {
    $manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
    $expectedPnpm = [string]$manifest.packageManager
    $actualPnpm = "pnpm@$actualPnpmVersion"
    if ($actualPnpm -ne $expectedPnpm) {
        Add-Issue "pnpm 版本需与 packageManager 精确一致：需要 $expectedPnpm，当前 $actualPnpm（$pnpmSource）。"
    }
}

if ($script:issues.Count -gt 0) {
    [Console]::Error.WriteLine("Windows 内网构建预检失败（$($script:issues.Count) 项）：")
    foreach ($issue in $script:issues) {
        [Console]::Error.WriteLine("- $issue")
    }
    exit 1
}

Write-Output 'Windows 内网构建预检通过。此结果不代表已完成离线构建或运行时出站验证。'
