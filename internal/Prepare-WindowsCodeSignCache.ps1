[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,

    [string]$SevenZipPath,

    [string]$CacheRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$archiveSha256 = 'cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4'
$requiredFiles = [ordered]@{
    'rcedit-x64.exe' = 'ab53500d556fd824636621bca7dbecd8583ba181891c3e9efdcf16b72a28b0cd'
    'rcedit-ia32.exe' = '8d7f9e4cdbffadf53806ea0646a6cf5a67244f16dda3cabb7b3f00dc0cddb552'
    'windows-10/x64/signtool.exe' = 'e472ab54601f9da46915a68da4d93b6d6cc61502e6bf18d5a53c0a70176119a4'
    'windows-10/ia32/signtool.exe' = 'a13bfd50668b2acb91b0334d36dce7e04d6fc2e3a122f9c9c145d3659fd0cd84'
}

function Get-LocalAbsolutePath {
    param([string]$Path, [string]$Description)
    if (-not [System.IO.Path]::IsPathFullyQualified($Path)) {
        throw "$Description 必须是完整的本地绝对路径：$Path"
    }
    $full = [System.IO.Path]::GetFullPath($Path)
    if ($full.StartsWith('\\')) {
        throw "$Description 不接受 UNC 网络路径：$full"
    }
    return $full
}

function Assert-NoReparseAncestors {
    param([string]$Path)
    $current = [System.IO.Path]::GetFullPath($Path)
    while ($true) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item -and (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "拒绝符号链接或重解析点：$current"
        }
        $parent = [System.IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) {
            break
        }
        $current = $parent
    }
}

function Assert-NoReparseTree {
    param([string]$Root)
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "缓存包含符号链接或重解析点：$current"
        }
        if ($item.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $current -Force) {
                $pending.Push($child.FullName)
            }
        }
    }
}

function Assert-DirectChild {
    param([string]$Path, [string]$Parent)
    $actualParent = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Path))
    if (-not [string]::Equals($actualParent, [System.IO.Path]::GetFullPath($Parent), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "缓存操作路径不在指定目录内：$Path"
    }
}

function Assert-CachePayload {
    param([string]$Directory)
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        throw "缺少缓存目录：$Directory"
    }
    Assert-NoReparseAncestors $Directory
    Assert-NoReparseTree $Directory
    foreach ($entry in $requiredFiles.GetEnumerator()) {
        $file = Join-Path $Directory $entry.Key
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "缓存缺少文件：$file"
        }
        $actualHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $entry.Value) {
            throw "缓存文件 SHA-256 不匹配：$file"
        }
    }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw '此脚本只支持 Windows。'
}

$archive = Get-LocalAbsolutePath $ArchivePath '归档'
Assert-NoReparseAncestors $archive
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    throw "找不到本地归档：$archive"
}
$actualArchiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualArchiveHash -ne $archiveSha256) {
    throw "winCodeSign 归档 SHA-256 不匹配：$archive"
}

if ([string]::IsNullOrWhiteSpace($CacheRoot)) {
    $CacheRoot = [Environment]::GetEnvironmentVariable('ELECTRON_BUILDER_CACHE', 'Process')
    if ([string]::IsNullOrWhiteSpace($CacheRoot)) {
        throw '请设置当前进程的 ELECTRON_BUILDER_CACHE，或显式指定 -CacheRoot。'
    }
}
$cache = Get-LocalAbsolutePath $CacheRoot 'CacheRoot'
Assert-NoReparseAncestors $cache
$winCodeSignCache = Join-Path $cache 'winCodeSign'
$target = Join-Path $winCodeSignCache 'winCodeSign-2.6.0'
Assert-DirectChild $target $winCodeSignCache
Assert-NoReparseAncestors $winCodeSignCache

if (Test-Path -LiteralPath $target) {
    Assert-CachePayload $target
    Write-Output "已存在经验证的 winCodeSign 缓存：$target"
    return
}

if ([string]::IsNullOrWhiteSpace($SevenZipPath)) {
    $sevenZipPackage = Get-Item -LiteralPath (Join-Path $PSScriptRoot '../apps/desktop/node_modules/7zip-bin') -Force
    if (($sevenZipPackage.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        if ($sevenZipPackage.LinkType -ne 'Junction' -or @($sevenZipPackage.Target).Count -ne 1) {
            throw '本地 7zip-bin 路径不是可解析的单一 pnpm junction；请指定 -SevenZipPath。'
        }
        $sevenZipPackageRoot = Get-LocalAbsolutePath ([string]$sevenZipPackage.Target) '7zip-bin 目标'
    } else {
        $sevenZipPackageRoot = $sevenZipPackage.FullName
    }
    $SevenZipPath = Join-Path $sevenZipPackageRoot 'win/x64/7za.exe'
}
$sevenZip = Get-LocalAbsolutePath $SevenZipPath '7za.exe'
Assert-NoReparseAncestors $sevenZip
if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf) -or [System.IO.Path]::GetFileName($sevenZip) -ne '7za.exe') {
    throw "找不到本地 7za.exe：$sevenZip"
}

[System.IO.Directory]::CreateDirectory($winCodeSignCache) | Out-Null
Assert-NoReparseAncestors $winCodeSignCache
$stage = Join-Path $winCodeSignCache ('.openpets-verified-stage-' + [Guid]::NewGuid().ToString('N'))
Assert-DirectChild $stage $winCodeSignCache
if (Test-Path -LiteralPath $stage) {
    throw "暂存目录已存在：$stage"
}
[System.IO.Directory]::CreateDirectory($stage) | Out-Null

try {
    $output = & $sevenZip x $archive "-o$stage" '-y' '-xr!darwin' 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "7za 提取失败（退出码 $LASTEXITCODE）：$output"
    }
    Assert-CachePayload $stage
    if (Test-Path -LiteralPath $target) {
        throw "目标缓存已由其他进程创建，拒绝覆盖：$target"
    }
    Assert-DirectChild $stage $winCodeSignCache
    Assert-DirectChild $target $winCodeSignCache
    Assert-NoReparseAncestors $winCodeSignCache
    [System.IO.Directory]::Move($stage, $target)
    Write-Output "已准备经验证的 winCodeSign 缓存：$target"
} catch {
    throw "缓存准备失败；暂存目录保留供人工检查：$stage。原因：$($_.Exception.Message)"
}
