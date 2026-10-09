# Windows PowerShell 5.1. Representative only. No email is saved in a SQL file.
$ErrorActionPreference = 'Stop'
$appPath = Split-Path -Parent $PSScriptRoot
$config = Join-Path $appPath 'wrangler.cloud.jsonc'
$wrangler = Join-Path $appPath 'node_modules/wrangler/bin/wrangler.js'
if (-not (Test-Path -LiteralPath $wrangler)) { throw 'Local Wrangler dependency is missing' }
function Invoke-D1([string]$Statement) {
    $ErrorActionPreference = 'Continue'
    try {
        # Call Node directly: cmd.exe expansion must not reinterpret characters in the email.
        $output = & node $wrangler d1 execute $database --remote -c $config --env staging --command $Statement --json 2>&1
        $nativeExit = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = 'Stop' }
    if ($nativeExit -ne 0) { throw 'D1 command failed' }
    @($output | Where-Object { $_ -is [string] })
}
$database = Read-Host 'Staging D1 database name (must contain staging)'
if ($database -notmatch '^[a-zA-Z0-9_-]*staging[a-zA-Z0-9_-]*$') { throw 'Use the staging database name' }
if ((Read-Host 'Confirm its database_id differs from production (type STAGING)') -cne 'STAGING') { throw 'Cancelled' }
$secure = Read-Host 'Representative email (same as Access)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$logNames = @('WRANGLER_WRITE_LOGS','WRANGLER_LOG_SANITIZE','CLOUDFLARE_SEND_METRICS')
$savedLogs = @{}
foreach ($name in $logNames) { $savedLogs[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
try {
    # Wrangler can persist request bodies independently of its displayed output.
    $env:WRANGLER_WRITE_LOGS = 'false'
    $env:WRANGLER_LOG_SANITIZE = 'true'
    $env:CLOUDFLARE_SEND_METRICS = 'false'
    $memberEmail = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim().ToLowerInvariant()
    if ($memberEmail -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$' -or $memberEmail.Contains('"')) { throw 'Invalid or unsupported email' }
    $literal = "'" + $memberEmail.Replace("'", "''") + "'"
    # Both writes require the fictional staging organization. SQL is a process variable, never a file.
    $sql = "INSERT INTO users(email,display_name) SELECT $literal,'staging admin' WHERE EXISTS(SELECT 1 FROM organizations WHERE id=1 AND code='DEMO-SALES') ON CONFLICT(email) DO NOTHING;"
    $result = Invoke-D1 $sql
    $sql = "INSERT INTO memberships(org_id,user_id,role,active) SELECT 1,id,'admin',1 FROM users WHERE email=$literal AND EXISTS(SELECT 1 FROM organizations WHERE id=1 AND code='DEMO-SALES') ON CONFLICT(org_id,user_id) DO UPDATE SET role='admin',active=1,expires_at=NULL;"
    $result = Invoke-D1 $sql
    $sql = "SELECT EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=m.org_id WHERE o.id=1 AND o.code='DEMO-SALES' AND u.email=$literal AND m.role='admin' AND m.active=1 AND m.expires_at IS NULL) AS membership_ok;"
    $result = Invoke-D1 $sql
    $parsed = ($result -join "`n") | ConvertFrom-Json
    if (@($parsed)[0].results[0].membership_ok -ne 1) { throw 'D1 membership missing' }
    Write-Output 'membership_ok: true'
}
catch { throw 'Staging D1 membership operation failed. Stop here; investigate locally without sharing the email.' }
finally {
    foreach ($name in $logNames) { [Environment]::SetEnvironmentVariable($name,$savedLogs[$name],'Process') }
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $secure.Dispose()
    $memberEmail = $literal = $sql = $result = $parsed = $null
}
