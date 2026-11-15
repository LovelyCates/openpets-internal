[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2)]
    [int]$MajorVersion,

    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [string]$CliPath,

    [string]$BundlePath,
    [string]$NodePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-RegularPath {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "拒绝跟随符号链接或重解析点：$Path"
        }
    }
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-Utf8File {
    param([string]$Path, [string]$Text)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw '此安装器只支持 Windows。'
}
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    throw "项目目录不存在：$ProjectRoot"
}
$project = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $ProjectRoot).ProviderPath)
Assert-RegularPath $project

if (-not [System.IO.Path]::IsPathRooted($CliPath) -or -not (Test-Path -LiteralPath $CliPath -PathType Leaf)) {
    throw 'CliPath 必须指向已部署的本地 CLI JavaScript 入口绝对路径。'
}
$cli = [System.IO.Path]::GetFullPath($CliPath)
Assert-RegularPath $cli
if ([System.IO.Path]::GetExtension($cli) -ne '.js') {
    throw 'CliPath 必须是 .js 文件；不接受 npx 或公网包名。'
}

if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        throw '未找到本地 Node.js。可使用 -NodePath 指定已审批的 node.exe。'
    }
    $NodePath = $nodeCommand.Source
}
if (-not [System.IO.Path]::IsPathRooted($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw 'NodePath 必须指向本地 node.exe 的绝对路径。'
}
$node = [System.IO.Path]::GetFullPath($NodePath)
Assert-RegularPath $node
if ([System.IO.Path]::GetFileName($node) -ne 'node.exe') {
    throw 'NodePath 必须指向 node.exe。'
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($BundlePath)) {
    $BundlePath = Join-Path $repoRoot "packages/opencode/v$MajorVersion-package/index.js"
}
if (-not [System.IO.Path]::IsPathRooted($BundlePath) -or -not (Test-Path -LiteralPath $BundlePath -PathType Leaf)) {
    throw "找不到 V$MajorVersion 单文件 bundle：$BundlePath。先在受控构建环境运行 build:v$MajorVersion。"
}
$bundle = [System.IO.Path]::GetFullPath($BundlePath)
$license = Join-Path (Split-Path -Path $bundle -Parent) 'LICENSE'
if (-not (Test-Path -LiteralPath $license -PathType Leaf)) {
    throw "bundle 旁缺少 MIT LICENSE：$license"
}
Assert-RegularPath $bundle
Assert-RegularPath $license

$opencodeDir = Join-Path $project '.opencode'
$pluginsDir = Join-Path $opencodeDir 'plugins'
$configTarget = Join-Path $opencodeDir 'opencode.jsonc'
$pluginRelative = ".opencode/plugins/openpets-v$MajorVersion.js"
$pluginTarget = Join-Path $pluginsDir "openpets-v$MajorVersion.js"
$otherMajor = if ($MajorVersion -eq 1) { 2 } else { 1 }
$otherPlugin = Join-Path $pluginsDir "openpets-v$otherMajor.js"
$licenseRelative = '.opencode/plugins/openpets-LICENSE.txt'
$licenseTarget = Join-Path $pluginsDir 'openpets-LICENSE.txt'
$configRelative = '.opencode/opencode.jsonc'
$manifestTarget = Join-Path $opencodeDir 'openpets-internal-install.json'

foreach ($path in @($opencodeDir, $pluginsDir, $configTarget, $pluginTarget, $otherPlugin, $licenseTarget, $manifestTarget)) {
    Assert-RegularPath $path
}
if (Test-Path -LiteralPath $otherPlugin) {
    throw "发现另一主版本的 OpenPets 插件：$otherPlugin。请先人工核对并移除，避免两个适配器同时运行。"
}

$mcpEntry = [ordered]@{
    type = 'local'
    command = @($node, $cli, 'mcp')
}
if ($MajorVersion -eq 1) {
    $mcpEntry.enabled = $true
    $configObject = [ordered]@{ mcp = [ordered]@{ openpets = $mcpEntry } }
} else {
    $configObject = [ordered]@{ mcp = [ordered]@{ servers = [ordered]@{ openpets = $mcpEntry } } }
}
$configText = ($configObject | ConvertTo-Json -Depth 10) + [Environment]::NewLine

$otherConfigs = @(
    (Join-Path $project 'opencode.json'),
    (Join-Path $project 'opencode.jsonc'),
    (Join-Path $opencodeDir 'opencode.json'),
    (Join-Path $opencodeDir 'config.json'),
    (Join-Path $opencodeDir 'config.jsonc')
)
$existingOtherConfigs = @($otherConfigs | Where-Object { Test-Path -LiteralPath $_ })
if ($existingOtherConfigs.Count -gt 0) {
    $paths = $existingOtherConfigs -join ', '
    throw "发现其他 OpenCode 配置：$paths。安装器不会猜测配置优先级。请人工合并下面的本地 MCP 片段，并复制插件 bundle 与 LICENSE：`n$configText"
}

$managed = Test-Path -LiteralPath $manifestTarget -PathType Leaf
if ($managed) {
    try {
        $record = Get-Content -LiteralPath $manifestTarget -Raw | ConvertFrom-Json
        if ($record.schemaVersion -ne 1 -or $record.majorVersion -ne $MajorVersion) {
            throw '安装记录的主版本或格式不匹配。'
        }
        $expected = @(
            @('bundle', $pluginRelative, $pluginTarget),
            @('config', $configRelative, $configTarget),
            @('license', $licenseRelative, $licenseTarget)
        )
        foreach ($entry in $expected) {
            $field = $entry[0]
            $item = $record.$field
            if ($item.path -ne $entry[1] -or -not (Test-Path -LiteralPath $entry[2] -PathType Leaf)) {
                throw "$field 文件位置与安装记录不符。"
            }
            if ((Get-Sha256 $entry[2]) -ne $item.sha256) {
                throw "$field 文件已被修改，拒绝覆盖。"
            }
        }
    } catch {
        throw "已有安装记录无法安全更新：$($_.Exception.Message) 请人工合并下面的本地 MCP 片段：`n$configText"
    }
} else {
    $unknownTargets = @(@($configTarget, $pluginTarget, $licenseTarget) | Where-Object { Test-Path -LiteralPath $_ })
    if ($unknownTargets.Count -gt 0) {
        $paths = $unknownTargets -join ', '
        throw "发现已有文件但没有本安装器记录：$paths。拒绝覆盖。请人工合并下面的本地 MCP 片段并复制插件及 LICENSE：`n$configText"
    }
}

foreach ($directory in @($opencodeDir, $pluginsDir)) {
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    Assert-RegularPath $directory
}

$id = [Guid]::NewGuid().ToString('N')
$stagedBundle = Join-Path $pluginsDir ".openpets-bundle-$id.tmp"
$stagedLicense = Join-Path $pluginsDir ".openpets-license-$id.tmp"
$stagedConfig = Join-Path $opencodeDir ".openpets-config-$id.tmp"
$stagedManifest = Join-Path $opencodeDir ".openpets-manifest-$id.tmp"
$staged = @($stagedBundle, $stagedLicense, $stagedConfig, $stagedManifest)
$completed = New-Object 'System.Collections.Generic.List[object]'

try {
    [System.IO.File]::Copy($bundle, $stagedBundle)
    [System.IO.File]::Copy($license, $stagedLicense)
    Write-Utf8File $stagedConfig $configText
    $manifestObject = [ordered]@{
        schemaVersion = 1
        majorVersion = $MajorVersion
        sourceBundle = $bundle
        cliPath = $cli
        bundle = [ordered]@{ path = $pluginRelative; sha256 = (Get-Sha256 $stagedBundle) }
        config = [ordered]@{ path = $configRelative; sha256 = (Get-Sha256 $stagedConfig) }
        license = [ordered]@{ path = $licenseRelative; sha256 = (Get-Sha256 $stagedLicense) }
    }
    Write-Utf8File $stagedManifest (($manifestObject | ConvertTo-Json -Depth 10) + [Environment]::NewLine)

    $operations = @(
        @($stagedBundle, $pluginTarget),
        @($stagedLicense, $licenseTarget),
        @($stagedConfig, $configTarget),
        @($stagedManifest, $manifestTarget)
    )
    foreach ($operation in $operations) {
        $source = $operation[0]
        $target = $operation[1]
        if (Test-Path -LiteralPath $target -PathType Leaf) {
            $backup = "$target.bak-$id"
            [System.IO.File]::Replace($source, $target, $backup)
            $completed.Add([pscustomobject]@{ target = $target; backup = $backup; wasExisting = $true })
        } else {
            [System.IO.File]::Move($source, $target)
            $completed.Add([pscustomobject]@{ target = $target; backup = $null; wasExisting = $false })
        }
    }
} catch {
    $installError = $_
    for ($index = $completed.Count - 1; $index -ge 0; $index--) {
        $operation = $completed[$index]
        try {
            if ($operation.wasExisting) {
                [System.IO.File]::Copy($operation.backup, $operation.target, $true)
            } elseif (Test-Path -LiteralPath $operation.target -PathType Leaf) {
                [System.IO.File]::Delete($operation.target)
            }
        } catch {
            [Console]::Error.WriteLine("回滚失败，请从备份恢复：$($operation.target)；$($_.Exception.Message)")
        }
    }
    throw "OpenCode 集成安装失败并已尝试回滚：$($installError.Exception.Message)"
} finally {
    foreach ($path in $staged) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            [System.IO.File]::Delete($path)
        }
    }
}

Write-Output "OpenCode $MajorVersion.x 集成已安装到：$project"
Write-Output "插件：$pluginTarget"
Write-Output "MCP 配置：$configTarget"
Write-Output "本地 CLI：$cli"
if ($managed) {
    Write-Output "旧文件备份后缀：.bak-$id"
}
Write-Output '请重启 OpenCode，并在无公网出口的测试机验证插件事件与 MCP 工具。'
