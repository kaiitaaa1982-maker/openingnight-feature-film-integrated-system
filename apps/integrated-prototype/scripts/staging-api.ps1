# ps1-rules: strict
# Windows PowerShell 5.1。登録したサービストークン（staging-access-credential.ps1）で、staging の統合システムの受け口を呼ぶ。
# トークンの値は、この子のプロセス（node scripts\staging-api.mjs）の環境変数にだけ渡し、画面・ファイル・引数には出さない。
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps\integrated-prototype\scripts\staging-api.ps1 -Method GET -ApiPath /api/session
#   … -Method POST -ApiPath /api/source-documents/import-r2-manifest -ManifestFile <manifest-latest.tsv> [-Apply]
#   … -Method POST -ApiPath <受け口> -BodyFile <JSON> [-OutFile <保存先>] [-Org <組織の id>]（-Org は操作する組織を選ぶ。選べなければ送らずに止まる）
# 終了コード: 0 2xx・1 止まった・2 受け口がエラーを返した
[CmdletBinding()]
param(
    [ValidateSet('GET', 'POST', 'PUT', 'PATCH')][string]$Method = 'GET',
    [Parameter(Mandatory = $true)][string]$ApiPath,
    [string]$BodyFile,
    [string]$ManifestFile,
    [switch]$Apply,
    [string]$OutFile,
    [int]$Org,
    [string]$CredentialFile = (Join-Path $env:USERPROFILE '.openingnight\staging-access.clixml')
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $CredentialFile)) { Write-Host ('止まった: 登録が無い。先に staging-access-credential.ps1 を流す（' + $CredentialFile + '）'); exit 1 }
$saved = Import-Clixml -LiteralPath $CredentialFile
if ($saved.Kind -ne 'openingnight-staging-access') { Write-Host '止まった: 登録の種類が違う'; exit 1 }
$nodeArgs = @((Join-Path $PSScriptRoot 'staging-api.mjs'), $Method, $ApiPath)
if ($BodyFile) { $nodeArgs += @('--body', $BodyFile) }
if ($ManifestFile) { $nodeArgs += @('--manifest', $ManifestFile) }
if ($Apply) { $nodeArgs += '--apply' }
if ($OutFile) { $nodeArgs += @('--out', $OutFile) }
if ($Org) { $nodeArgs += @('--org', [string]$Org) }
$secret = $saved.Credential.GetNetworkCredential().Password
try {
    $env:ON_STAGING_ACCESS_ID = $saved.Credential.UserName
    $env:ON_STAGING_ACCESS_SECRET = $secret
    & node @nodeArgs
    $code = $LASTEXITCODE
} finally {
    Remove-Item Env:\ON_STAGING_ACCESS_ID -ErrorAction SilentlyContinue
    Remove-Item Env:\ON_STAGING_ACCESS_SECRET -ErrorAction SilentlyContinue
    $secret = $null
}
exit $code
