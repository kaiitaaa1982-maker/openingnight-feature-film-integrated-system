# ps1-rules: strict
# Windows PowerShell 5.1。日々スケの JSON を、登録したサービストークン（staging-access-credential.ps1）で staging の受け口へ取り込む（会社ルートの plans/2026-11-06-r2-ingest.md の C）。
# 取り込む前に JSON の形と中の食い違いを確かめ、問題があれば受け口を呼ばずに止まる。
# トークンの値は、この子のプロセス（node scripts\import-call-sheets.mjs --staging）の環境変数にだけ渡し、画面・ファイル・引数には出さない。
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps\integrated-prototype\scripts\import-call-sheets-staging.ps1 -WorkId <作品ID> -SourceFile <JSON> -PdfFolder <PDF のフォルダ> [-Org <組織の id>]
#   … -SourceFile <JSON> [-PdfFolder <PDF のフォルダ>] -CheckOnly   （検査だけ。トークンも受け口も使わない）
# 終了コード: 0 済んだ・1 JSON の問題か受け口のエラー・2 使い方の誤り
[CmdletBinding()]
param(
    [int]$WorkId = 0,
    [int]$Org = 0,
    [Parameter(Mandatory = $true)][string]$SourceFile,
    [string]$PdfFolder,
    [switch]$CheckOnly,
    [string]$CredentialFile = (Join-Path $env:USERPROFILE '.openingnight\staging-access.clixml')
)
$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot 'import-call-sheets.mjs'
if ($CheckOnly) {
    $nodeArgs = @($entry, '--check-only', '--source', $SourceFile)
    if ($PdfFolder) { $nodeArgs += @('--files', $PdfFolder) }
    & node @nodeArgs
    exit $LASTEXITCODE
}
if ($WorkId -le 0) { Write-Host '止まった: -WorkId（staging の作品 ID）を入れる'; exit 2 }
if (-not $PdfFolder) { Write-Host '止まった: -PdfFolder（原本の PDF のフォルダ）を入れる'; exit 2 }
if (-not (Test-Path -LiteralPath $CredentialFile)) { Write-Host ('止まった: 登録が無い。先に staging-access-credential.ps1 を流す（' + $CredentialFile + '）'); exit 1 }
$saved = Import-Clixml -LiteralPath $CredentialFile
if ($saved.Kind -ne 'example-staging-access') { Write-Host '止まった: 登録の種類が違う'; exit 1 }
$nodeArgs = @($entry, '--staging', '--work-id', [string]$WorkId, '--source', $SourceFile, '--files', $PdfFolder)
if ($Org -gt 0) { $nodeArgs += @('--org', [string]$Org) }
$secret = $saved.Credential.GetNetworkCredential().Password
$code = 1
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
