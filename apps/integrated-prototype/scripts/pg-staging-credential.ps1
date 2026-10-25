# ps1-rules: strict
# Windows PowerShell 5.1。staging の PostgreSQL（PlanetScale）の接続値を、代表が1回だけ登録する（D-005 の 2026-10-25 継続許可）。
# 登録した値は Export-Clixml（DPAPI）で、登録した Windows の利用者だけが読める。Claude は pg-staging.ps1 -CredentialFile でこのファイルを読ませ、中身は見ない。
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .pps\integrated-prototype\scripts\pg-staging-credential.ps1
# ・-Path <パス>: 置き場（既定 %USERPROFILE%\.openingnight\pg-staging.clixml。リポジトリの外）
# ・-Remove: 登録を消す（使い終わったら、または値を変えたら）
# 終了コード: 0 登録した（消した）・1 止まった
[CmdletBinding()]
param(
    [string]$Path = (Join-Path $env:USERPROFILE '.openingnight\pg-staging.clixml'),
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
if ($Remove) {
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
    Write-Host '登録を消した'
    exit 0
}
$hostSecure = Read-Host 'PlanetScale staging host (not a URL)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($hostSecure)
try { $hostName = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $hostSecure.Dispose() }
if ([string]::IsNullOrWhiteSpace($hostName) -or $hostName -match '[/\s@]') { Write-Host '止まった: Host は URL でなく、空でない値にする'; exit 1 }
$credential = Get-Credential -Message 'staging の Default のロールの Username と Password（stg-golive.ps1 で入れたのと同じ値。Username は「Default」という語ではなく、PlanetScale に出ている名前）'
if ($null -eq $credential -or [string]::IsNullOrWhiteSpace($credential.UserName) -or $credential.Password.Length -eq 0) { Write-Host '止まった: Username と Password を入れる'; exit 1 }
$folder = Split-Path -Parent $Path
if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder | Out-Null }
[pscustomobject]@{ Kind = 'openingnight-pg-staging'; Host = $hostName; Credential = $credential } | Export-Clixml -LiteralPath $Path
Write-Host ('登録した: ' + $Path + '（この Windows の利用者だけが読める。中身は出さない）')
exit 0
