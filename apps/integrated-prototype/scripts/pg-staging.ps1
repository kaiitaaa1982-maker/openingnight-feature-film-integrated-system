# ps1-rules: strict
# Windows PowerShell 5.1。staging の PostgreSQL（PlanetScale）へ代表が流す（手順は core の docs/platform/operations/runbooks/13-planetscale-schema.md）。
# AI のセッションからは、-CredentialFile（代表が登録した接続値。D-005 の 2026-10-25 継続許可）の catalog・migrate-dryrun・migrate だけを staging に向けて流す。
# ほかの Action を staging へ流すのは代表。Claude は -LocalContainer（手元の Docker の使い捨てのコンテナ）にも向けて通す。
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\apps\integrated-prototype\scripts\pg-staging.ps1 -Action <schema|catalog|permissions|seed|reconcile|member|migrate-dryrun|migrate|rls|rls-off>
# ・rls・rls-off（RLS 計画 #5。手順書16）: Default で pg/rls.sql を当てて pg/staging-rls-check.sql の真偽6行を出す／pg/rls-off.sql で外す。どちらも1つのトランザクション
# 接続値（Host・Username・Password・メール）は Read-Host -AsSecureString で受け、Docker の psql（postgres:18.6-alpine）へは環境変数の名前だけを渡す。
# 画面・ファイルに出さない。psql の失敗の文も出さない（接続値や行の値を含みうる）。
# ・catalog: pg/verify-catalog.sql の数と版の印を出し、(1) DB の版の印の12の列が、この作業場の移行から変換した全体の版の印（pg/schema.sql の最後の行）と
#   同じか（scripts/pg-migrate.mjs status）、(2) 数の6項目が版の印の expected_* と同じか、(3) 全表の持ち主がいまのロールかを判定する。数は直書きしない
#   （移行を足してもこの ps1 を変えなくてよい）
# ・migrate-dryrun・migrate（PG 計画 段2の実測 S14。差分の移行）: 先に版の印を読んで起点を決め（scripts/pg-migrate.mjs plan）、起点より新しい移行だけの
#   差分（delta.sql）と照合（check-before.sql・check-after.sql）を、psql で1つのトランザクションで当てる。migrate-dryrun は全部を流してから ROLLBACK、
#   migrate は -1 で COMMIT。照合は起点の reconcile.sql の前と後を scripts/ops/pg-reconcile.mjs で比べ、新しい表の行の数を移行の入れる数と比べる。
#   止まったら RAISE の固定の語と SQLSTATE だけを拾って次の一手を出す。版の印が最後の移行と同じなら「当てるものが無い」で終了コード 0。
#   差分の SQL・照合の JSON・数値だけの結果は %USERPROFILE%\ondrill\pg-migrate-<時刻>\（リポジトリの外。秘密値は書かない）に残す。
#   書き出しの定時（$exportSchedule。日次の日本時間03:00、最長12分）とロックがぶつかるので、staging では定時の2分前から15分後のあいだは、
#   始めるときと当てる直前に止まる
# ・-LocalContainer <名前>: 手元の Docker のコンテナ（127.0.0.1 だけに公開し、trust で立てた使い捨ての postgres。名前は on- で始まるものだけ）へ、
#   そのコンテナのネットワークで向ける（Claude の通し用）。STAGING の確認と接続値の入力をしない。staging・PlanetScale には向かない
# ・-CredentialFile <パス>: 代表が scripts/pg-staging-credential.ps1 で登録した接続値（Export-Clixml。DPAPI で、登録した Windows の利用者だけが読める）を
#   読んで、尋ねずに staging へ向ける。catalog・migrate-dryrun・migrate だけ。-ConfirmTarget STAGING を一緒に渡す（STAGING と打つ確認の代わり）。
#   ファイルはリポジトリの外（既定 %USERPROFILE%\.openingnight\pg-staging.clixml）に置き、中身を画面に出さない
# ・-WorkRoot <フォルダ>: 差分の移行の作業フォルダの根（試験用。既定は %USERPROFILE%\ondrill）
# 終了コード: 0 通った（当てるものが無いを含む）・1 止まった
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('schema','catalog','permissions','seed','reconcile','member','migrate-dryrun','migrate','rls','rls-off')][string]$Action,
    [ValidatePattern('^on-[a-z0-9][a-z0-9_.-]{0,59}$')][string]$LocalContainer,
    [string]$CredentialFile,
    [string]$ConfirmTarget,
    [string]$WorkRoot
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'pg-drill-common.ps1')
$appPath = Split-Path -Parent $PSScriptRoot
$coreRoot = Split-Path -Parent (Split-Path -Parent $appPath)
$migrateScript = Join-Path $PSScriptRoot 'pg-migrate.mjs'
$reconcileScript = Join-Path $coreRoot 'scripts\ops\pg-reconcile.mjs'
$localMode = -not [string]::IsNullOrEmpty($LocalContainer)
$migrating = ($Action -eq 'migrate-dryrun' -or $Action -eq 'migrate')
$secretNames = @('PGHOST','PGUSER','PGPASSWORD','STAGING_MEMBER_EMAIL')
$saved = @{}
foreach ($name in $secretNames) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
# 差分の SQL と照合の RAISE の固定の語（scripts/pg-ddl.mjs の DELTA_RAISE_WORDS と scripts/pg-migrate.mjs の CHECK_RAISE_WORDS）
$migrateWords = @('no_fingerprint','base_mismatch','catalog_mismatch','not_owner','fingerprint_not_updated','catalog_mismatch_after','reconcile_mismatch','new_table_rows')
$dockerPath = $null
$exitWith = 0
$resultPath = $null
# 書き出しの定時（日本時間）と、避ける幅（分）。Hour が $null なら毎時。
# S8完了後の日次（0 18 * * * UTC ＝ 日本時間03:00）。このps1は日本時間の端末で実行する（手順書13の手順10）
$exportSchedule = @{ Hour = 3; Minute = 0; Before = 2; After = 15 }

# いまが書き出しの定時の前後（避ける幅）か
function Test-ExportBusy([DateTime]$At) {
    $starts = @()
    if ($null -eq $exportSchedule.Hour) { foreach ($shift in @(-1, 0, 1)) { $starts += $At.Date.AddHours($At.Hour + $shift).AddMinutes($exportSchedule.Minute) } }
    else { foreach ($shift in @(-1, 0, 1)) { $starts += $At.Date.AddDays($shift).AddHours($exportSchedule.Hour).AddMinutes($exportSchedule.Minute) } }
    foreach ($start in $starts) {
        if ($At -ge $start.AddMinutes(-$exportSchedule.Before) -and $At -le $start.AddMinutes($exportSchedule.After)) { return $true }
    }
    return $false
}
function Get-ExportScheduleText {
    $at = '{0:00}' -f $exportSchedule.Minute
    if ($null -eq $exportSchedule.Hour) { $when = '毎時 :' + $at } else { $when = '毎日 ' + $exportSchedule.Hour + ':' + $at }
    return ('書き出しの定時（' + $when + '）の ' + $exportSchedule.Before + ' 分前から ' + $exportSchedule.After + ' 分後')
}
# staging だけ見る（手元のコンテナには書き出しが無い）
function Assert-ExportQuiet([string]$When) {
    if ($localMode) { return }
    if (Test-ExportBusy (Get-Date)) {
        Stop-Drill ('いまは ' + (Get-ExportScheduleText) + ' のあいだ（' + $When + '）') ('その時間を外して、同じ1行を流し直す（' + $(if ($When -eq '始める前') { '何も変えていない' } else { '当てる前に止めたので、何も変えていない' }) + '）')
    }
}

function Read-TemporarySecret([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
}

# docker run の psql の引数。staging は接続値を環境変数の名前だけで渡し、TLS は verify-full とシステムの証明書。
# -LocalContainer は、そのコンテナのネットワークの 127.0.0.1 へ（TLS なし・trust）
function Get-PsqlDockerArgs([string[]]$ExtraMounts, [string[]]$ExtraEnv) {
    $dockerArgs = @('run','--rm','-i','--mount',"type=bind,source=$appPath,target=/work,readonly")
    foreach ($mount in @($ExtraMounts)) { if ($mount) { $dockerArgs += @('--mount', $mount) } }
    if ($localMode) {
        $dockerArgs += @('--network',('container:' + $LocalContainer),'-e','PGHOST=127.0.0.1','-e','PGPORT=5432','-e','PGUSER=postgres','-e','PGDATABASE=postgres','-e','PGSSLMODE=disable','-e','PGCLIENTENCODING=UTF8')
    }
    else {
        $dockerArgs += @('-e','PGHOST','-e','PGUSER','-e','PGPASSWORD','-e','PGDATABASE=postgres','-e','PGPORT=5432','-e','PGSSLMODE=verify-full','-e','PGSSLROOTCERT=system','-e','PGCLIENTENCODING=UTF8')
    }
    foreach ($envName in @($ExtraEnv)) { if ($envName) { $dockerArgs += @('-e', $envName) } }
    return ,($dockerArgs + @($drillImage,'psql'))
}

# psql を呼ぶ。stdout と stderr の行を分けて返す（画面に出すかは呼んだ側が決める。stderr は出さない）
function Invoke-StagingPsql([string[]]$PsqlArgs, [string[]]$ExtraMounts, [string[]]$ExtraEnv) {
    $callArgs = (Get-PsqlDockerArgs $ExtraMounts $ExtraEnv) + $PsqlArgs
    return Invoke-DrillNative $dockerPath $callArgs
}

# 確認と接続値（staging）。-LocalContainer では尋ねない
function Initialize-StagingTarget {
    if ($localMode) {
        Write-Host ('手元の Docker のコンテナ ' + $LocalContainer + ' に向ける（試験用。staging ではない）')
        if (-not (Get-DrillContainerStatus $dockerPath $LocalContainer)) { Stop-Drill ('コンテナ ' + $LocalContainer + ' が無い') '手元の Docker に trust で postgres:18.6-alpine を立ててから流し直す' }
        return
    }
    if (-not [string]::IsNullOrEmpty($CredentialFile)) {
        if ($ConfirmTarget -cne 'STAGING') { Stop-Drill '-CredentialFile には -ConfirmTarget STAGING を一緒に渡す' '対象が staging であることを確かめてから、-ConfirmTarget STAGING を足して流し直す' }
        if ($Action -notin @('catalog','migrate-dryrun','migrate')) { Stop-Drill ('-CredentialFile で流せるのは catalog・migrate-dryrun・migrate だけ（' + $Action + ' は代表が流す）') '-CredentialFile を外して、代表が同じ1行を流す' }
        if (-not (Test-Path -LiteralPath $CredentialFile -PathType Leaf)) { Stop-Drill '登録した接続値のファイルが無い' '代表が scripts/pg-staging-credential.ps1 で登録し直す' }
        try { $stored = Import-Clixml -LiteralPath $CredentialFile } catch { Stop-Drill '登録した接続値を読めない（登録した Windows の利用者でないか、壊れている）' '代表が scripts/pg-staging-credential.ps1 で登録し直す' }
        if ($null -eq $stored -or $stored.Kind -ne 'openingnight-pg-staging' -or $null -eq $stored.Credential) { Stop-Drill '登録した接続値の形が違う' '代表が scripts/pg-staging-credential.ps1 で登録し直す' }
        $env:PGHOST = [string]$stored.Host
        $env:PGUSER = $stored.Credential.UserName
        $env:PGPASSWORD = $stored.Credential.GetNetworkCredential().Password
    }
    else {
    if ((Read-Host 'Confirm target is STAGING (type STAGING)') -cne 'STAGING') { Stop-Drill 'STAGING と打たれなかったので止めた' '対象が staging であることを確かめてから、同じ1行を流し直す' }
    $env:PGHOST = Read-TemporarySecret 'PlanetScale staging host (not a URL)'
    $env:PGUSER = Read-TemporarySecret 'Username (integrated_app for permissions; Default otherwise)'
    $env:PGPASSWORD = Read-TemporarySecret 'Password'
    }
    if ([string]::IsNullOrWhiteSpace($env:PGHOST) -or $env:PGHOST -match '[/\s@]' -or [string]::IsNullOrWhiteSpace($env:PGUSER) -or [string]::IsNullOrEmpty($env:PGPASSWORD)) { Stop-Drill '接続値の形が違う（Host は URL でなく、空でない）' 'パスワード管理の staging の値を確かめて、同じ1行を流し直す' }
}

# node を呼ぶ（scripts/pg-migrate.mjs・scripts/ops/pg-reconcile.mjs）。失敗の原因の種類（{"event":…,"cause":…}）だけを拾う
function Invoke-StagingNode([string[]]$NodeArgs) {
    $node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $node) { Stop-Drill 'node が見つからない' 'Node.js 24 を入れてから、同じ1行を流し直す' }
    return Invoke-DrillNative $node (@('--disable-warning=ExperimentalWarning') + $NodeArgs)
}
function Get-NodeCause($Called) {
    foreach ($line in @($Called.Err)) {
        $hit = [regex]::Match([string]$line, '"cause":"([A-Za-z0-9_]+)"')
        if ($hit.Success) { return $hit.Groups[1].Value }
    }
    return 'unexpected'
}

# psql の stderr から、RAISE の固定の語か SQLSTATE だけを拾う（VERBOSITY=verbose の「ERROR:  P0001: base_mismatch」の形）。文は出さない
function Get-PsqlCause($Called) {
    foreach ($line in @($Called.Err)) {
        $hit = [regex]::Match([string]$line, 'ERROR:\s+([0-9A-Z]{5}):\s*(\S+)')
        if ($hit.Success) {
            if ($migrateWords -ccontains $hit.Groups[2].Value) { return $hit.Groups[2].Value }
            return $hit.Groups[1].Value
        }
    }
    return 'unexpected'
}

# psql の -tA の出力の「名前|値」の行
function ConvertTo-OutputMap([string[]]$Lines) {
    $map = @{}
    foreach ($line in @($Lines)) {
        $at = ([string]$line).IndexOf('|')
        if ($at -gt 0) {
            $key = $line.Substring(0, $at)
            if ($key -cmatch '^[a-z_]+$') { $map[$key] = $line.Substring($at + 1) }
        }
    }
    return $map
}

# 版の印とカタログを読む（verify-catalog.sql の行・版の印の行の JSON・全表の持ち主）。読めなければ止める
function Read-StagingCatalog {
    $fingerprintSql = "SELECT 'fingerprint|' || row_to_json(f)::text FROM schema_source_fingerprint f;"
    $ownerSql = "SELECT 'ddl_owner_ok|' || bool_and(c.relowner = current_user::regrole)::text FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p');"
    $read = Invoke-StagingPsql @('-X','-w','-q','-tA','-F','|','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-v','SHOW_CONTEXT=never','-1',
        '-c','SET LOCAL search_path TO public;','-f','/work/pg/verify-catalog.sql','-c',$fingerprintSql,'-c',$ownerSql) @() @()
    if ($read.Code -ne 0) {
        $cause = Get-PsqlCause $read
        if ($cause -eq '42P01') { Stop-Drill '版の印の表（schema_source_fingerprint）が無い' 'schema を当てた DB か（手順書13の4）を確かめる。この出力を Claude に渡す' }
        Stop-Drill ('版の印とカタログを読めなかった（' + $cause + '）') '接続値（Host・Username・Password）を確かめて同じ1行を流し直す。続けて止まるならこの出力を Claude に渡す（接続値は出していない）'
    }
    $rows = @($read.Out | Where-Object { ([string]$_) -cmatch '^\d+\|' })
    $map = ConvertTo-OutputMap $read.Out
    if (-not $map.ContainsKey('fingerprint')) { Stop-Drill '版の印の行が無い' '版の印の表が空。この出力を Claude に渡す' }
    return [pscustomobject]@{ Rows = $rows; Fingerprint = $map['fingerprint']; OwnerOk = ($map['ddl_owner_ok'] -eq 'true') }
}

# DB の版の印の行を、この作業場の移行と比べる（scripts/pg-migrate.mjs status）。state（current・delta）か、止まった原因の種類
function Get-FingerprintStatus([string]$FingerprintJson, [string]$Folder) {
    $file = Join-Path $Folder 'db-fingerprint.json'
    [IO.File]::WriteAllText($file, $FingerprintJson, $drillUtf8)
    $status = Invoke-StagingNode @($migrateScript, 'status', '--fingerprint', $file)
    if ($status.Code -ne 0) { return [pscustomobject]@{ State = $null; Cause = (Get-NodeCause $status); From = $null; To = $null } }
    $summary = (@($status.Out) -join '') | ConvertFrom-Json
    return [pscustomobject]@{ State = [string]$summary.state; Cause = $null; From = [string]$summary.from; To = [string]$summary.to }
}

# 差分の移行が止まったときの次の一手（原因の種類ごと）
function Get-MigrateNext([string]$Cause) {
    switch -CaseSensitive ($Cause) {
        'base_mismatch' { return '版の印が起点と違う（別の版が当たっているか、途中で誰かが当てた）。何も変わっていない。-Action catalog の出力を Claude に渡す' }
        'catalog_mismatch' { return 'DB の表・トリガーなどの数が版の印と合わない（手で変えた所がある）。何も変わっていない。-Action catalog の出力を Claude に渡す' }
        'not_owner' { return 'いま接続したロールが表の持ち主でない。Default ロールの値で同じ1行を流し直す（integrated_app では当てない）' }
        'no_fingerprint' { return '版の印の表が無いか1行でない。schema を当てた DB か（手順書13の4）を確かめ、この出力を Claude に渡す' }
        'fingerprint_not_updated' { return '版の印を書き換えられなかった（同時に別の当てが走ったかもしれない）。全部戻った。5分ほど置いて -Action catalog で版の印を見てから Claude に渡す' }
        'catalog_mismatch_after' { return '当てたあとの数が新しい全体と合わない（変換の誤り）。全部戻った。この出力を Claude に渡す' }
        'reconcile_mismatch' { return '元の表の件数か金額が変わった。全部戻った。この出力を Claude に渡す' }
        'new_table_rows' { return '新しい表の行の数が移行の正解と違う。全部戻った。この出力を Claude に渡す' }
        '55P03' { return ('ロック待ちで止まった（書き出しか、画面の操作と重なった）。全部戻った。' + (Get-ExportScheduleText) + ' を外して、予行（-Action migrate-dryrun）から流し直す') }
        '57014' { return '時間の上限で止まった。全部戻った。この出力を Claude に渡す' }
        '40001' { return '同時の書き込みとぶつかった。全部戻った。5分ほど置いて予行から流し直す' }
        '40P01' { return '同時の操作（別の当てや画面の書き込み）とロックが行き違った。全部戻った。5分ほど置いて -Action catalog で版の印を見てから、予行から流し直す' }
        '42501' { return '権限が無い。Default ロールの値で同じ1行を流し直す（integrated_app では当てない）' }
        '23503' { return '既存の行が新しい外部キーに反する。全部戻った。この出力を Claude に渡す（データを直すか移行を直すかを決める）' }
        '23514' { return '既存の行か移行の行が CHECK に反する。全部戻った。この出力を Claude に渡す' }
        '23505' { return '移行の行が既存の行と重なる。全部戻った。この出力を Claude に渡す' }
        default { return 'この出力を Claude に渡す（psql は1つのトランザクションなので、途中で止まったら全部戻っている。接続値は出していない）' }
    }
}

# 差分の移行（migrate-dryrun・migrate）
function Invoke-StagingMigrate {
    $dryRun = ($Action -eq 'migrate-dryrun')
    $startedAt = Get-DrillNow
    $result = [ordered]@{
        action = $Action; target = $(if ($localMode) { 'local' } else { 'staging' }); outcome = 'ng'; state = $null; from = $null; to = $null; sections = $null
        committed = $false; new_tables = $null; expected_new_tables = $null; reconcile_equal = $null; reconcile_differences = $null; reconcile_tables = $null
        times_utc = [ordered]@{ started = (Format-DrillUtc $startedAt); apply_started = $null; apply_checked = $null; finished = $null }
        durations_ms = [ordered]@{ read = $null; plan = $null; apply = $null; reconcile = $null; total = $null }
    }
    $workDir = $null
    try {
        Assert-ExportQuiet '始める前'
        if (-not (Test-Path -LiteralPath $migrateScript) -or -not (Test-Path -LiteralPath $reconcileScript)) { Stop-Drill 'scripts\pg-migrate.mjs か core の scripts\ops\pg-reconcile.mjs が無い' 'main の最新に同期した core の作業場の ps1 を流す' }
        if ($WorkRoot) { $rootDir = [IO.Path]::GetFullPath($WorkRoot) } else { $rootDir = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'ondrill')) }
        $workDir = Join-Path $rootDir ('pg-migrate-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        [void][IO.Directory]::CreateDirectory($workDir)
        $script:resultPath = Join-Path $workDir 'pg-migrate-result.json'
        $planDir = Join-Path $workDir 'plan'
        Write-Host ('作業フォルダ: ' + $workDir)
        Initialize-StagingTarget

        # 1. 版の印を読む
        Write-Host '1/4 版の印とカタログを読む'
        $catalog = Read-StagingCatalog
        $readAt = Get-DrillNow
        $result.durations_ms.read = Get-DrillElapsedMs $startedAt $readAt

        # 2. 起点を決めて、差分と照合の SQL を作る（外へは届かない）
        Write-Host '2/4 起点を決めて、差分と照合の SQL を作る（scripts\pg-migrate.mjs plan）'
        $fingerprintFile = Join-Path $workDir 'db-fingerprint.json'
        [IO.File]::WriteAllText($fingerprintFile, $catalog.Fingerprint, $drillUtf8)
        $plan = Invoke-StagingNode @($migrateScript, 'plan', '--fingerprint', $fingerprintFile, '--out', $planDir)
        $planAt = Get-DrillNow
        $result.durations_ms.plan = Get-DrillElapsedMs $readAt $planAt
        if ($plan.Code -ne 0) {
            $cause = Get-NodeCause $plan
            if ($cause -eq 'database_ahead') { Stop-Drill 'DB の版の印の最後の移行が、この作業場に無い（DB の方が新しいか、別の版）' 'main の最新の作業場で同じ1行を流す（何も変えていない）' }
            if ($cause -eq 'base_mismatch') { Stop-Drill 'DB の版の印の12の列が、この作業場の起点の変換と合わない' '何も変えていない。-Action catalog の出力を Claude に渡す（変換の決まりが変わったなら、手順書13の「差分で上げられないとき」）' }
            if ($cause -eq 'sections_changed' -or $cause -eq 'convert_failed' -or $cause -eq 'app_ddl_sources') { Stop-Drill ('差分の SQL を作れない（' + $cause + '）') '何も変えていない。この出力を Claude に渡す（手順書13の「差分で上げられないとき」）' }
            Stop-Drill ('差分の SQL を作れなかった（' + $cause + '）') '何も変えていない。この出力を Claude に渡す'
        }
        $summary = (@($plan.Out) -join '') | ConvertFrom-Json
        $result.state = [string]$summary.state
        $result.from = [string]$summary.from
        $result.to = [string]$summary.to
        if ($result.state -eq 'current') {
            $result.outcome = 'ok'
            Write-DrillOk ('当てるものが無い（DB の版の印は、この作業場の最後の移行 ' + $result.to + ' と同じ）')
            Save-MigrateResult $result
            Write-Host '判定: OK（当てるものが無い。何も変えていない）'
            Write-Host '次の一手: なし（-Action catalog で版の印と数を確かめてもよい）'
            return 0
        }
        $result.sections = @($summary.sections).Count
        $expected = [ordered]@{}
        foreach ($property in $summary.new_tables.PSObject.Properties) { $expected[$property.Name] = $property.Value }
        $result.expected_new_tables = $expected
        Write-DrillOk ('起点 ' + $result.from + ' → ' + $result.to + '（新しい節 ' + $result.sections + '・新しい表 ' + $expected.Count + '）')

        # 3. 当てる（予行は全部を流してから ROLLBACK、本番は -1 で COMMIT）
        $psqlArgs = @('-X','-w','-q','-tA','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-v','SHOW_CONTEXT=never')
        $files = @('-c','SET LOCAL search_path TO public;','-f','/plan/check-before.sql','-f','/plan/delta.sql','-f','/plan/check-after.sql')
        if ($dryRun) {
            Write-Host '3/4 予行: BEGIN → 照合の前 → 差分 → 照合の後 → ROLLBACK（何も残さない）'
            $psqlArgs += @('-c','BEGIN') + $files + @('-c','ROLLBACK')
        }
        else {
            Write-Host '3/4 本番: psql の -1 で、照合の前 → 差分 → 照合の後 → COMMIT'
            $psqlArgs += @('-1') + $files
        }
        # 読むのと作るのに時間がかかるので、当てる直前にもう一度見る
        Assert-ExportQuiet '当てる直前'
        $applyStarted = Get-DrillNow
        $apply = Invoke-StagingPsql $psqlArgs @("type=bind,source=$planDir,target=/plan,readonly") @()
        $applyFinished = Get-DrillNow
        $result.durations_ms.apply = Get-DrillElapsedMs $applyStarted $applyFinished
        if ($apply.Code -ne 0) {
            $cause = Get-PsqlCause $apply
            $result.state = 'stopped'
            Stop-Drill ('差分の移行が ' + $cause + ' で止まった（' + $(if ($dryRun) { '予行' } else { '本番' }) + '）') (Get-MigrateNext $cause)
        }
        # 本番は psql が 0 で終わった時点で COMMIT 済み（照合の SQL の確かめは COMMIT の前に通っている）。このあとで止まったら、やり直さない
        $committed = -not $dryRun
        $result.committed = $committed
        $afterNext = 'この出力を Claude に渡す'
        if ($committed) { $afterNext = '当て済み（COMMIT 済み）。やり直さず -Action catalog で版の印を見て、この出力を Claude に渡す' }
        $outputs = ConvertTo-OutputMap $apply.Out
        foreach ($key in @('reconcile_before','reconcile_after','new_tables')) { if (-not $outputs.ContainsKey($key)) { Stop-Drill ('照合の出力（' + $key + '）が無い') $afterNext } }
        $result.times_utc.apply_started = $outputs['apply_started']
        $result.times_utc.apply_checked = $outputs['apply_checked']

        # 4. 照合（起点の reconcile.sql の前と後を pg-reconcile.mjs で比べる。新しい表の行の数を移行の正解と比べる）
        Write-Host '4/4 照合: 起点の reconcile.sql の前と後（scripts\ops\pg-reconcile.mjs）と、新しい表の行の数'
        $beforeFile = Join-Path $workDir 'reconcile-before.json'
        $afterFile = Join-Path $workDir 'reconcile-after.json'
        [IO.File]::WriteAllText($beforeFile, $outputs['reconcile_before'], $drillUtf8)
        [IO.File]::WriteAllText($afterFile, $outputs['reconcile_after'], $drillUtf8)
        $compare = Invoke-StagingNode @($reconcileScript, '--left', $beforeFile, '--right', $afterFile)
        $verdict = [regex]::Match((@($compare.Out) -join ''), '"equal":(true|false)')
        if ($compare.Code -eq 2 -or -not $verdict.Success) { Stop-Drill '照合の入力を読めなかった' $afterNext }
        $result.reconcile_equal = ($compare.Code -eq 0 -and $verdict.Groups[1].Value -eq 'true')
        $result.reconcile_differences = ([regex]::Matches((@($compare.Out) -join ''), '"reason":')).Count
        $result.reconcile_tables = @(($outputs['reconcile_before'] | ConvertFrom-Json)).Count
        $actual = [ordered]@{}
        foreach ($property in ($outputs['new_tables'] | ConvertFrom-Json).PSObject.Properties) { $actual[$property.Name] = [int64]$property.Value }
        $result.new_tables = $actual
        $reconcileAt = Get-DrillNow
        $result.durations_ms.reconcile = Get-DrillElapsedMs $applyFinished $reconcileAt
        $result.durations_ms.total = Get-DrillElapsedMs $startedAt $reconcileAt
        $result.times_utc.finished = Format-DrillUtc $reconcileAt
        $rowsDiffer = @($expected.Keys | Where-Object { $null -ne $expected[$_] -and [int64]$expected[$_] -ne $actual[$_] })
        if (-not $result.reconcile_equal) { Stop-Drill ('照合が不一致（違い ' + $result.reconcile_differences + ' 件）') $afterNext }
        if ($rowsDiffer.Count -gt 0) { Stop-Drill ('新しい表の行の数が移行の正解と違う: ' + ($rowsDiffer -join '・')) $afterNext }
        Write-DrillOk ('照合: 元の表 ' + $result.reconcile_tables + ' の件数と金額が同じ・新しい表の行の数が移行の正解と同じ（' + (($actual.Keys | ForEach-Object { $_ + ' ' + $actual[$_] }) -join '・') + '）')
        $result.outcome = 'ok'
        Write-Host ''
        Write-Host ('== 差分の移行の' + $(if ($dryRun) { '予行' } else { '本番' }) + 'の結果 ==')
        Write-Host ('起点 ' + $result.from + ' → ' + $result.to + '・新しい節 ' + $result.sections)
        Write-Host ('当てる（照合の前から後まで）: ' + (Format-DrillSeconds $result.durations_ms.apply) + '・全体: ' + (Format-DrillSeconds $result.durations_ms.total))
        Save-MigrateResult $result
        if ($dryRun) {
            Write-Host '判定: OK（予行。全部を流してから ROLLBACK したので、何も変えていない）'
            Write-Host ('次の一手: 同じ作業場で -Action migrate を流す（' + (Get-ExportScheduleText) + ' を外す）')
        }
        else {
            Write-Host '判定: OK'
            Write-Host '次の一手: -Action catalog を流し、その出力と pg-migrate-result.json を Claude に渡す（#113 のマージと配備は、そのあと代表が決める）'
        }
        return 0
    }
    finally {
        # 止まったときも数値だけの結果を残す（行は、止まった案内のあとに出す）
        if ($workDir -and (Test-Path -LiteralPath $workDir)) {
            try { Write-DrillJson $script:resultPath $result } catch { $script:resultPath = $null }
        }
    }
}

# 数値だけの結果の JSON を書き、その場所を出す（通ったときに判定の前で呼ぶ）
function Save-MigrateResult($Result) {
    try {
        Write-DrillJson $script:resultPath $Result
        Write-Host ('結果の JSON（数値だけ）: ' + $script:resultPath)
    }
    catch { Write-Host '結果の JSON を書けなかった（画面の数を使う）' }
}

# カタログの確かめ（catalog）
function Invoke-StagingCatalog {
    Initialize-StagingTarget
    $catalog = Read-StagingCatalog
    Write-Host 'ord|item|actual|expected|ok'
    foreach ($row in $catalog.Rows) { Write-Host $row }
    $counts = @($catalog.Rows | Where-Object { ([string]$_).Split('|')[1] -in @('tables','triggers','functions','identities','foreign_keys','indexes') })
    $catalogOk = ($counts.Count -eq 6 -and @($counts | Where-Object { ([string]$_).Split('|')[4] -ne 't' }).Count -eq 0)
    $schemaOk = (@($catalog.Rows | Where-Object { ([string]$_) -ceq '1|current_schema|public||' }).Count -eq 1) -and (@($catalog.Rows | Where-Object { ([string]$_) -ceq '2|fingerprint_rows|1|1|t' }).Count -eq 1)
    $work = Join-Path ([IO.Path]::GetTempPath()) ('pg-staging-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($work)
    try { $status = Get-FingerprintStatus $catalog.Fingerprint $work }
    finally { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    $fingerprintOk = ($status.State -eq 'current')
    if ($fingerprintOk) { Write-Host ('fingerprint_ok: true（DB の版の印の12の列が、この作業場の pg/schema.sql の版の印〈最後の移行 ' + $status.To + '〉と同じ）') }
    elseif ($status.State -eq 'delta') { Write-Host ('fingerprint_ok: false（DB は ' + $status.From + ' の版。この作業場は ' + $status.To + '。差分の移行が当たっていない: -Action migrate-dryrun から）') }
    elseif ($status.Cause -eq 'database_ahead') { Write-Host 'fingerprint_ok: false（DB の版の印の最後の移行が、この作業場に無い。main の最新の作業場で流す）' }
    else { Write-Host ('fingerprint_ok: false（' + $status.Cause + '。DB の版の印の12の列が、この作業場のどの版の変換とも合わない）') }
    Write-Host ('catalog_ok: ' + $(if ($catalogOk) { 'true' } else { 'false' }) + '（数の6項目が DB の版の印の expected_* と同じ）')
    Write-Host ('schema_ok: ' + $(if ($schemaOk) { 'true' } else { 'false' }) + '（current_schema が public・版の印がちょうど1行）')
    Write-Host ('ddl_owner_ok: ' + $(if ($catalog.OwnerOk) { 'true' } else { 'false' }) + '（版の印を含む全表の持ち主が、いま接続したロール）')
    if ($fingerprintOk -and $catalogOk -and $schemaOk -and $catalog.OwnerOk) { Write-Host '判定: OK'; return 0 }
    Write-Host '判定: NG'
    if ($status.State -eq 'delta' -and $catalogOk -and $schemaOk -and $catalog.OwnerOk) {
        Write-Host ('次の一手: 差分の移行が当たっていない（DB は ' + $status.From + ' の版）。手順書13の手順10の予行（-Action migrate-dryrun）から流す（切り替え・配備へ進まない）')
    }
    else { Write-Host '次の一手: この出力を Claude に渡す（切り替え・配備へ進まない）' }
    return 1
}

try {
    $dockerPath = Get-DrillDocker
    if ($migrating) { $exitWith = Invoke-StagingMigrate }
    elseif ($Action -eq 'catalog') { $exitWith = Invoke-StagingCatalog }
    else {
        Initialize-StagingTarget
        $psqlArgs = @('-X','-w','-q','-v','ON_ERROR_STOP=1','-v','VERBOSITY=terse','-1')
        $extraEnv = @()
        $commands = @()
        switch ($Action) {
            'schema' {
                $commands = @('-c','SET LOCAL search_path TO public;', '-c', 'DO $check$ BEGIN IF current_database() <> ''postgres'' OR current_schema() <> ''public'' OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=''public''::regnamespace AND relkind IN (''r'',''p'')) THEN RAISE EXCEPTION ''Target must be empty postgres.public''; END IF; END $check$;', '-f','/work/pg/schema.sql')
            }
            'reconcile' { $commands = @('-c','SET LOCAL search_path TO public;', '-f','/work/pg/reconcile.sql') }
            'permissions' {
                $commands = @('-f','/work/pg/staging-permissions.sql')
            }
            'seed' {
                if (-not (Test-Path -LiteralPath (Join-Path $appPath 'data/staging-seed/pg.sql'))) { throw 'Generate staging seed first' }
                $commands = @('-c','SET LOCAL search_path TO public;', '-f','/work/data/staging-seed/pg.sql')
            }
            'rls' {
                # 行単位の権限を当て、真偽だけの確かめを同じトランザクションで流す（手順書16）。書き出しの定時とロックがぶつかるので避ける
                Assert-ExportQuiet '当てる直前'
                $commands = @('-c','SET LOCAL search_path TO public;', '-f','/work/pg/rls.sql', '-tA', '-F', '|', '-f','/work/pg/staging-rls-check.sql')
            }
            'rls-off' {
                Assert-ExportQuiet '外す直前'
                $commands = @('-c','SET LOCAL search_path TO public;', '-f','/work/pg/rls-off.sql')
            }
            'member' {
                $env:STAGING_MEMBER_EMAIL = (Read-TemporarySecret 'Representative email (same as Access)').Trim().ToLowerInvariant()
                if ($env:STAGING_MEMBER_EMAIL -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { throw 'Invalid email' }
                $extraEnv = @('STAGING_MEMBER_EMAIL')
                $commands = @('-c','SET LOCAL search_path TO public;', '-f','/work/pg/staging-member-entry.sql')
            }
        }
        # 接続値や在籍の値を含む失敗の文は出さない。終了コードだけで判定する（PS 5.1 は外部コマンドの stderr を ErrorRecord にするので Invoke-DrillNative で包む）
        $ran = Invoke-StagingPsql ($psqlArgs + $commands) @() $extraEnv
        # rls は確かめの真偽（名前|t・f。値を含まない）を出してから止める。f があれば pg/staging-rls-check.sql が巻き戻している
        $rlsRolledBack = ($ran.Code -ne 0 -and $Action -eq 'rls' -and @($ran.Out | Where-Object { $_ -match '^[a-z_]+\|f$' }).Count -gt 0)
        if ($rlsRolledBack) {
            $ran.Out | Where-Object { $_ -match '^[a-z_]+\|[tf]$' } | Write-Output
            Write-Host '止まった: f の行があるので pg/rls.sql ごと巻き戻した（RLS は当たっていない）。次の一手: f の行の名前だけを Claude に渡す'
            $exitWith = 1
        }
        elseif ($ran.Code -ne 0) { throw 'psql failed; stop here. Inspect locally without sharing connection values.' }
        elseif ($Action -in @('permissions','reconcile','member')) { $ran.Out | Write-Output }
        elseif ($Action -eq 'rls') {
            $ran.Out | Write-Output
            # 名前|真偽 の6行がどれも t なら通った（手順書16の手順4）
            if (@($ran.Out | Where-Object { $_ -match '^[a-z_]+\|t$' }).Count -ne 6) { Write-Host '次の一手: この出力を Claude に渡す（配備・計測へ進まない。戻すときは -Action rls-off）'; $exitWith = 1 }
            else { Write-Output 'rls: completed' }
        }
        else { Write-Output ($Action + ': completed') }
    }
}
catch {
    if ($migrating -or $Action -eq 'catalog') {
        Write-DrillStop $_
        if ($migrating -and $resultPath -and (Test-Path -LiteralPath $resultPath)) { Write-Host ('結果の JSON（数値だけ）: ' + $resultPath) }
        $exitWith = 1
    }
    else { throw 'Staging PostgreSQL operation failed. Stop here; investigate locally without sharing connection values.' }
}
finally {
    foreach ($name in $secretNames) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
}

exit $exitWith
