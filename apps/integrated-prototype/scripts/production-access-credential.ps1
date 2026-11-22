# ps1-rules: strict
# Windows PowerShell 5.1。本番の Cloudflare Access のサービストークンを、代表が1回だけ登録する（会社ルートの plans/2026-11-10-production-ai-token.md）。
# 登録した値は Export-Clixml（DPAPI）で、登録した Windows の利用者だけが読める。Claude は production-api.ps1 でこのファイルを読ませ、中身は見ない。
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps\integrated-prototype\scripts\production-access-credential.ps1
# 入れるもの: User name に Client ID（〜.access）、Password に Client Secret。手順は core の docs/platform/operations/runbooks/20-production-service-token.md
# ・-Path <パス>: 置き場（既定 %USERPROFILE%\.openingnight\production-access.clixml。リポジトリの外。staging の登録とは別のファイル）
# ・-Remove: 登録を消す（トークンを作り直したとき・止めるとき）
# 終了コード: 0 登録した（消した）・1 止まった
[CmdletBinding()]
param(
    [string]$Path = (Join-Path $env:USERPROFILE '.openingnight\production-access.clixml'),
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
if ($Remove) {
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
    Write-Host '登録を消した'
    exit 0
}
$credential = Get-Credential -Message '本番の Cloudflare Access のサービストークン。User name に Client ID（〜.access で終わる）、Password に Client Secret'
if ($null -eq $credential -or [string]::IsNullOrWhiteSpace($credential.UserName) -or $credential.Password.Length -eq 0) { Write-Host '止まった: Client ID と Client Secret を入れる'; exit 1 }
if ($credential.UserName -notmatch '^[0-9a-f]{32}\.access$') { Write-Host '止まった: Client ID は 32 桁の英数字のあとに .access が付く形'; exit 1 }
$folder = Split-Path -Parent $Path
if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder | Out-Null }
[pscustomobject]@{ Kind = 'openingnight-production-access'; Credential = $credential } | Export-Clixml -LiteralPath $Path
Write-Host ('登録した: ' + $Path + '（この Windows の利用者だけが読める。中身は出さない）')
exit 0
