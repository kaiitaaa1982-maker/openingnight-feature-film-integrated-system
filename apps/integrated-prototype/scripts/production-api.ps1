# ps1-rules: strict
# Windows PowerShell 5.1。登録したサービストークン（production-access-credential.ps1）で、本番の映画の基幹システムの受け口を呼ぶ。
# トークンの値は、この子のプロセス（node scripts\production-api.mjs）の環境変数にだけ渡し、画面・ファイル・引数には出さない。
# 書き込みは -Apply が無ければ送らず、送る内容を見せるだけ（本番なので先に見せる）。
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps\integrated-prototype\scripts\production-api.ps1 -Method GET -ApiPath /api/session
#   … -Method POST -ApiPath <受け口> -BodyFile <JSON> [-Org <組織の id>] [-Apply]
# 終了コード: 0 2xx（予行を含む）・1 止まった・2 受け口がエラーを返した
[CmdletBinding()]
param(
    [ValidateSet('GET', 'POST', 'PUT', 'PATCH')][string]$Method = 'GET',
    [Parameter(Mandatory = $true)][string]$ApiPath,
    [string]$BodyFile,
    [switch]$Apply,
    [string]$OutFile,
    [int]$Org,
    [string]$CredentialFile = (Join-Path $env:USERPROFILE '.openingnight\production-access.clixml')
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $CredentialFile)) { Write-Host ('止まった: 登録が無い。先に production-access-credential.ps1 を流す（' + $CredentialFile + '）'); exit 1 }
$saved = Import-Clixml -LiteralPath $CredentialFile
if ($saved.Kind -ne 'openingnight-production-access') { Write-Host '止まった: 登録の種類が違う'; exit 1 }
$nodeArgs = @((Join-Path $PSScriptRoot 'production-api.mjs'), $Method, $ApiPath)
if ($BodyFile) { $nodeArgs += @('--body', $BodyFile) }
if ($Apply) { $nodeArgs += '--apply' }
if ($OutFile) { $nodeArgs += @('--out', $OutFile) }
if ($Org) { $nodeArgs += @('--org', [string]$Org) }
$secret = $saved.Credential.GetNetworkCredential().Password
try {
    $env:ON_PRODUCTION_ACCESS_ID = $saved.Credential.UserName
    $env:ON_PRODUCTION_ACCESS_SECRET = $secret
    & node @nodeArgs
    $code = $LASTEXITCODE
} finally {
    Remove-Item Env:\ON_PRODUCTION_ACCESS_ID -ErrorAction SilentlyContinue
    Remove-Item Env:\ON_PRODUCTION_ACCESS_SECRET -ErrorAction SilentlyContinue
    $secret = $null
}
exit $code
