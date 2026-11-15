[CmdletBinding()]
param(
    [string]$Installer,
    [switch]$ShowRequirements
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($ShowRequirements) {
    Write-Output '用法：Test-WindowsInstaller.ps1 -Installer <已签名安装包的绝对路径>'
    Write-Output '进程环境变量：OPENPETS_INTERNAL_SIGNER_THUMBPRINT、OPENPETS_INTERNAL_RELEASE_SHA256'
    Write-Output '此脚本只读；不会签名、上传或发布。'
    exit 0
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw '必须在 Windows 上验证 Authenticode 签名。'
}
if ([string]::IsNullOrWhiteSpace($Installer) -or -not [System.IO.Path]::IsPathRooted($Installer)) {
    throw 'Installer 必须是安装包的绝对路径。'
}
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf) -or [System.IO.Path]::GetExtension($Installer) -ne '.exe') {
    throw 'Installer 必须指向现有的 .exe 安装包。'
}

$expectedThumbprint = [Environment]::GetEnvironmentVariable('OPENPETS_INTERNAL_SIGNER_THUMBPRINT', 'Process')
$expectedHash = [Environment]::GetEnvironmentVariable('OPENPETS_INTERNAL_RELEASE_SHA256', 'Process')
if ($expectedThumbprint -notmatch '^[0-9a-fA-F]{40}$') {
    throw 'OPENPETS_INTERNAL_SIGNER_THUMBPRINT 必须是审批的 40 位十六进制证书 thumbprint。'
}
if ($expectedHash -notmatch '^[0-9a-fA-F]{64}$') {
    throw 'OPENPETS_INTERNAL_RELEASE_SHA256 必须是审批的 64 位十六进制 SHA-256。'
}

$signature = Get-AuthenticodeSignature -LiteralPath $Installer
if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
    throw "安装包签名无效：$($signature.Status)。"
}
if ($signature.SignerCertificate.Thumbprint -ne $expectedThumbprint) {
    throw '安装包签名证书与审批 thumbprint 不一致。'
}

$actualHash = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) {
    throw '安装包 SHA-256 与审批值不一致。'
}

Write-Output "安装包验签通过：$Installer"
Write-Output "SHA-256：$actualHash"
Write-Output "签名证书：$($signature.SignerCertificate.Subject)"
