# Windows PowerShell 5.1. Representative only; never run from an AI session.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('schema','catalog','permissions','seed','reconcile','member')][string]$Action)
$ErrorActionPreference = 'Stop'
$appPath = Split-Path -Parent $PSScriptRoot
$secretNames = @('PGHOST','PGUSER','PGPASSWORD','STAGING_MEMBER_EMAIL')
$saved = @{}
foreach ($name in $secretNames) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
function Read-TemporarySecret([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
}
try {
    if ((Read-Host 'Confirm target is STAGING (type STAGING)') -cne 'STAGING') { throw 'Cancelled' }
    $env:PGHOST = Read-TemporarySecret 'PlanetScale staging host (not a URL)'
    $env:PGUSER = Read-TemporarySecret 'Username (integrated_app for permissions; Default otherwise)'
    $env:PGPASSWORD = Read-TemporarySecret 'Password'
    if ([string]::IsNullOrWhiteSpace($env:PGHOST) -or $env:PGHOST -match '[/\s@]' -or [string]::IsNullOrWhiteSpace($env:PGUSER) -or [string]::IsNullOrEmpty($env:PGPASSWORD)) { throw 'Invalid connection input' }
    $dockerArgs = @('run','--rm','-i','--mount',"type=bind,source=$appPath,target=/work,readonly",'-e','PGHOST','-e','PGUSER','-e','PGPASSWORD','-e','PGDATABASE=postgres','-e','PGPORT=5432','-e','PGSSLMODE=verify-full','-e','PGSSLROOTCERT=system','-e','PGCLIENTENCODING=UTF8')
    $psqlArgs = @('-X','-w','-q','-v','ON_ERROR_STOP=1','-v','VERBOSITY=terse','-1')
    $commands = @()
    switch ($Action) {
        'schema' {
            $commands = @('-c','SET LOCAL search_path TO public;', '-c', 'DO $check$ BEGIN IF current_database() <> ''postgres'' OR current_schema() <> ''public'' OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=''public''::regnamespace AND relkind IN (''r'',''p'')) THEN RAISE EXCEPTION ''Target must be empty postgres.public''; END IF; END $check$;', '-f','/work/pg/schema.sql')
        }
        'catalog' { $commands = @('-c','SET LOCAL search_path TO public;', '-f','/work/pg/verify-catalog.sql','-c',"SELECT count(*)=259 AND bool_and(relowner=current_user::regrole) AS ddl_owner_ok FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p');") }
        'reconcile' { $commands = @('-c','SET LOCAL search_path TO public;', '-f','/work/pg/reconcile.sql') }
        'permissions' {
            $commands = @('-f','/work/pg/staging-permissions.sql')
        }
        'seed' {
            if (-not (Test-Path -LiteralPath (Join-Path $appPath 'data/staging-seed/pg.sql'))) { throw 'Generate staging seed first' }
            $commands = @('-c','SET LOCAL search_path TO public;', '-f','/work/data/staging-seed/pg.sql')
        }
        'member' {
            $env:STAGING_MEMBER_EMAIL = (Read-TemporarySecret 'Representative email (same as Access)').Trim().ToLowerInvariant()
            if ($env:STAGING_MEMBER_EMAIL -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { throw 'Invalid email' }
            $dockerArgs += @('-e','STAGING_MEMBER_EMAIL')
            $commands = @('-c','SET LOCAL search_path TO public;', '-f','/work/pg/staging-member-entry.sql')
        }
    }
    # Hide errors containing connection identifiers or membership values. Return only a generic failure.
    # PS 5.1 turns native stderr into ErrorRecord objects, even on exit 0 (Docker pull / NOTICE).
    $ErrorActionPreference = 'Continue'
    try {
        $result = & docker @dockerArgs 'postgres:18.6-alpine' 'psql' @psqlArgs @commands 2>&1
        $nativeExit = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = 'Stop' }
    if ($nativeExit -ne 0) { throw 'psql failed; stop here. Inspect locally without sharing connection values.' }
    $result = @($result | Where-Object { $_ -is [string] })
    if ($Action -in @('catalog','permissions','reconcile','member')) { $result | Write-Output }
    else { Write-Output ($Action + ': completed') }
}
catch { throw 'Staging PostgreSQL operation failed. Stop here; investigate locally without sharing connection values.' }
finally {
    $result = $null
    foreach ($name in $secretNames) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
}
