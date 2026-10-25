# ps1-rules: strict
# Windows PowerShell 5.1。PG 計画 段2の実測 S14（練習 G。差分の移行）: 練習 F で取得した世代を、手元の Docker の PostgreSQL 18.6 に起点の版で戻し、
# 同じコンテナに差分の移行を psql の -1 で当てて、新しい全体を当てた2つ目のコンテナと定義を比べる。手元だけで、外へは届かない（wrangler を呼ばない）。
# Claude が流す（手順は core の docs/platform/operations/runbooks/03-restore-drill.md の「練習 G」）:
#   powershell -ExecutionPolicy Bypass -File "<core の作業場>\apps\integrated-prototype\scripts\pg-drill-migrate.ps1"
# 流れ: 0 世代を選ぶ（%USERPROFILE%\ondrill\pg-F-<時刻>\ の pg-daily\<世代>\manifest.json。-WorkDir で練習 F の作業フォルダ、
#   -ManifestKey で世代を選べる）→ 1 起点を決める（manifest の版の印から scripts/pg-migrate.mjs plan。起点の schema.sql・差分・照合の SQL を作る）
#   → 2 戻す（名前つきのコンテナ A に空の postgres:18.6-alpine を作り、core の scripts/ops/pg-restore.mjs で、道具が出した起点の schema.sql で戻す）
#   → 3 当てる（同じコンテナ A に check-before.sql・delta.sql・check-after.sql を psql の -1 で当てる。ALTER から COMMIT までの時間を測る）
#   → 4 新しい全体（2つ目のコンテナ B に、この作業場の pg/schema.sql を psql の -1 で当てる）
#   → 5 比べる（A の pg/verify-catalog.sql の数と版の印、A と B の定義〈scripts/pg-migrate.mjs snapshot・compare〉、照合〈起点の reconcile.sql の前と後を
#   scripts/ops/pg-reconcile.mjs で比べ、manifest とも比べる〉と、新しい表の行の数〈移行の正解〉）→ finally で A と B を名前で消す
# 作業フォルダは %USERPROFILE%\ondrill\pg-G-<時刻>\（リポジトリの外）。区切りの時刻・所要時間・数を、数値だけの pg-G-result.json と画面に出す。
# 行の値・接続値は出さない。パスワードはその場で作る使い捨ての値（画面・記録に出さない）
# ・-WorkRoot・-ContainerName: 試験用（既定は %USERPROFILE%\ondrill と on-drill-pg-g。コンテナは <名前>-a と <名前>-b）
# 終了コード: 0 一致まで通った・1 止まった（画面の「次の一手」を見る）
[CmdletBinding()]
param(
    [string]$WorkDir,
    [string]$ManifestKey,
    [string]$WorkRoot,
    [ValidatePattern('^[a-z0-9][a-z0-9_.-]{0,60}$')][string]$ContainerName
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'pg-drill-common.ps1')
# param の既定値は本文で決める（param の名前へは代入しない。ps1-rules の検査）
$dockerBase = 'on-drill-pg-g'
if ($ContainerName) { $dockerBase = $ContainerName }
$nameA = $dockerBase + '-a'
$nameB = $dockerBase + '-b'

$appPath = Split-Path -Parent $PSScriptRoot
$coreRoot = Split-Path -Parent (Split-Path -Parent $appPath)
$restoreScript = Join-Path $coreRoot 'scripts\ops\pg-restore.mjs'
$reconcileScript = Join-Path $coreRoot 'scripts\ops\pg-reconcile.mjs'
$migrateScript = Join-Path $PSScriptRoot 'pg-migrate.mjs'
$savedEnv = Save-DrillEnv @('PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE', 'POSTGRES_PASSWORD')
$migrateWords = @('no_fingerprint','base_mismatch','catalog_mismatch','not_owner','fingerprint_not_updated','catalog_mismatch_after','reconcile_mismatch','new_table_rows')

$result = [ordered]@{
    drill = 'G'; outcome = 'ng'; manifest_key = $null; manifest_sha256 = $null; snapshot_at_utc = $null; from = $null; to = $null; sections = $null
    tables_before = $null; rows_before = $null; tables_after = $null
    committed = $false; new_tables = $null; expected_new_tables = $null
    reconcile_equal = $null; reconcile_tables = $null; manifest_equal = $null; catalog_ok = $null; definitions_equal = $null; definition_differences = $null
    times_utc = [ordered]@{ started = $null; restore_finished = $null; apply_started = $null; apply_sql_started = $null; apply_sql_checked = $null; apply_finished = $null; full_finished = $null; compared = $null }
    durations_ms = [ordered]@{ plan = $null; restore = $null; apply = $null; apply_in_transaction = $null; full_schema = $null; compare = $null; total = $null }
}
$rootDir = $null
$gDir = $null
$dockerPath = $null
$owned = New-Object System.Collections.Generic.List[string]
$succeeded = $false
$exitWith = 1

# 名前つきのコンテナで空の PostgreSQL 18.6 を作り、127.0.0.1 の空いているポートにだけ公開する（同じ名前の残りは先に消す）。
# 起動を pg_isready で90秒まで待ち、公開したポートの先まで応えるかを確かめる。ポートとパスワードを返す
function Start-DrillTarget([string]$NameOfContainer, [string[]]$Mounts, [string]$Label) {
    if (Get-DrillContainerStatus $dockerPath $NameOfContainer) {
        if (-not (Remove-DrillContainer $dockerPath $NameOfContainer)) { Stop-Drill ('前の回のコンテナ ' + $NameOfContainer + ' を消せない') ('docker rm -f -v ' + $NameOfContainer + ' を流してから、同じ1行を流し直す') }
    }
    $port = Get-DrillFreePort
    $secret = New-DrillPassword
    $env:POSTGRES_PASSWORD = $secret
    $owned.Add($NameOfContainer)
    $runArgs = @('run', '-d', '--name', $NameOfContainer, '--label', ('openingnight.drill=' + $Label), '-e', 'POSTGRES_PASSWORD', '-p', ('127.0.0.1:' + $port + ':5432'))
    foreach ($mount in @($Mounts)) { $runArgs += @('--mount', $mount) }
    $started = Invoke-DrillNative $dockerPath ($runArgs + @($drillImage))
    $env:POSTGRES_PASSWORD = $null
    if ($started.Code -ne 0) { Stop-Drill ('コンテナ ' + $NameOfContainer + ' を始められない') 'Docker Desktop を起動し直してから、同じ1行を流し直す' }
    $deadline = (Get-Date).AddSeconds(90)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        $probe = Invoke-DrillNative $dockerPath @('exec', $NameOfContainer, 'pg_isready', '-q', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres')
        if ($probe.Code -eq 0) { $ready = $true; break }
        if ((Get-DrillContainerStatus $dockerPath $NameOfContainer) -notlike 'Up*') { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { Stop-Drill ('コンテナ ' + $NameOfContainer + ' の PostgreSQL が90秒のうちに起動しない') 'Docker Desktop を起動し直してから、同じ1行を流し直す' }
    $deadline = (Get-Date).AddSeconds(20)
    $reachable = $false
    while ((Get-Date) -lt $deadline) {
        if (Test-DrillPostgresPort $port 2000) { $reachable = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $reachable) { Stop-Drill ('127.0.0.1:' + $port + ' の PostgreSQL に届かない（Docker の公開ポートの不調かもしれない）') 'Docker Desktop を終了して起動し直してから、同じ1行を流し直す' }
    return [pscustomobject]@{ Port = $port; Secret = $secret }
}

# node と psql の接続の環境変数（値は出さない）
function Set-DrillPgEnv($Target) {
    $env:PGHOST = '127.0.0.1'
    $env:PGPORT = [string]$Target.Port
    $env:PGUSER = 'postgres'
    $env:PGPASSWORD = $Target.Secret
    $env:PGDATABASE = 'postgres'
    $env:PGSSLMODE = 'disable'
}

# node の失敗の原因の種類（{"event":…,"cause":…}）・psql の RAISE の固定の語か SQLSTATE だけを拾う
function Get-NodeCause($Called) {
    foreach ($line in @($Called.Err)) {
        $hit = [regex]::Match([string]$line, '"cause":"([A-Za-z0-9_]+)"')
        if ($hit.Success) { return $hit.Groups[1].Value }
    }
    return 'unexpected'
}
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

# 練習 F の作業フォルダ（-WorkDir か、根の下の新しい pg-F-<時刻> のうち世代のあるもの）と、その中の世代の manifest のキー
function Find-DrillGeneration {
    if ($WorkDir) { $folders = @(Get-Item -LiteralPath ([IO.Path]::GetFullPath($WorkDir)) -ErrorAction SilentlyContinue | Where-Object { $_.PSIsContainer }) }
    else { $folders = @(Get-ChildItem -LiteralPath $rootDir -Directory -Filter 'pg-F-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending) }
    foreach ($folder in $folders) {
        $manifests = @(Get-ChildItem -LiteralPath (Join-Path $folder.FullName 'pg-daily') -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json') -PathType Leaf } | Sort-Object Name -Descending)
        $keys = @($manifests | ForEach-Object { 'pg-daily/' + $_.Name + '/manifest.json' })
        if ($ManifestKey) { $keys = @($keys | Where-Object { $_ -ceq (ConvertTo-DrillManifestKey $ManifestKey) }) }
        if ($keys.Count -eq 1) { return [pscustomobject]@{ Folder = $folder.FullName; Key = $keys[0] } }
        if ($keys.Count -gt 1) { Stop-Drill ('練習 F の作業フォルダ ' + $folder.FullName + ' に世代が ' + $keys.Count + ' つある') '-ManifestKey "pg-daily/…/manifest.json" で使う世代を選んで流し直す' }
        if ($WorkDir) { break }
    }
    if ($WorkDir) { Stop-Drill '-WorkDir のフォルダに、世代（pg-daily\<世代>\manifest.json）が無い' '練習 F の作業フォルダ（%USERPROFILE%\ondrill\pg-F-<時刻>）を渡す。取得を済ませた練習 F の1行を先に流す' }
    Stop-Drill ('練習 F の作業フォルダ（' + $rootDir + '\pg-F-<時刻>）に、世代が無い') '練習 F の1行（取得まで）を先に流して作業フォルダを残してから、同じ1行を流し直す'
}

Write-Host '練習 G（練習 F の世代を起点の版で戻し、差分の移行を psql の -1 で当てて、新しい全体と比べる。手元だけ）'

try {
    $startedAt = Get-DrillNow
    $result.times_utc.started = Format-DrillUtc $startedAt
    $rootDir = Resolve-DrillRoot $WorkRoot
    if (-not (Test-Path -LiteralPath $rootDir)) { [void][IO.Directory]::CreateDirectory($rootDir) }

    # 0. 先に確かめる
    $nodePath = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $nodePath) { Stop-Drill 'node が見つからない' 'Node.js 24 を入れてから、同じ1行を流し直す' }
    foreach ($tool in @($restoreScript, $reconcileScript, $migrateScript)) {
        if (-not (Test-Path -LiteralPath $tool)) { Stop-Drill ('道具が無い: ' + (Split-Path -Leaf $tool)) 'main の最新に同期した core の作業場の ps1 を流す' }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $appPath 'node_modules\pg\package.json'))) { Stop-Drill 'apps\integrated-prototype に依存（pg）が入っていない' 'pg の入っている core の作業場の ps1 を流す' }
    $dockerPath = Get-DrillDocker
    $generation = Find-DrillGeneration
    $archiveRoot = $generation.Folder
    $generationKey = $generation.Key
    $manifestPath = Get-DrillLocalPath $archiveRoot $generationKey
    $manifest = Read-DrillManifest $manifestPath
    if (-not $manifest) { Stop-Drill '世代の manifest.json の形が違う' 'manifest を手で直さない。この出力を Claude に渡す' }
    $result.manifest_key = $generationKey
    $result.manifest_sha256 = Get-DrillSha256 $manifestPath
    $snapshot = ConvertFrom-DrillPgTime ([string]$manifest['snapshot_at'])
    if ($snapshot) { $result.snapshot_at_utc = Format-DrillUtc $snapshot }
    $tableRows = @($manifest['tables'])
    $rowTotal = [int64]0
    foreach ($table in $tableRows) { $rowTotal += [int64]::Parse([string]$table['row_count'], $drillInvariant) }
    $result.tables_before = $tableRows.Count
    $result.rows_before = $rowTotal
    $gDir = Join-Path $rootDir ('pg-G-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    [void][IO.Directory]::CreateDirectory($gDir)
    $planDir = Join-Path $gDir 'plan'
    Write-Host ('世代: ' + $generationKey + '（練習 F の作業フォルダ ' + $archiveRoot + '）')
    Write-Host ('作業フォルダ: ' + $gDir)

    # 1. 起点を決める（manifest の版の印。外へは届かない）
    Write-Host '1/5 起点を決める: scripts\pg-migrate.mjs plan（manifest の版の印から、起点の schema.sql・差分・照合の SQL を作る）'
    $plan = Invoke-DrillNative $nodePath @('--disable-warning=ExperimentalWarning', $migrateScript, 'plan', '--fingerprint', $manifestPath, '--out', $planDir)
    $planAt = Get-DrillNow
    $result.durations_ms.plan = Get-DrillElapsedMs $startedAt $planAt
    if ($plan.Code -ne 0) {
        $cause = Get-NodeCause $plan
        if ($cause -eq 'database_ahead') { Stop-Drill '世代の版の印の最後の移行が、この作業場に無い（世代の方が新しい）' 'main の最新の作業場（差分の移行を足したブランチ）の ps1 を流す' }
        if ($cause -eq 'base_mismatch') { Stop-Drill '世代の版の印の12の列が、この作業場の起点の変換と合わない' 'この出力を Claude に渡す（変換の決まりが変わったなら、手順書13の「差分で上げられないとき」）' }
        Stop-Drill ('起点を決められなかった（' + $cause + '）') 'この出力を Claude に渡す'
    }
    $summary = (@($plan.Out) -join '') | ConvertFrom-Json
    if ([string]$summary.state -ne 'delta') { Stop-Drill ('当てるものが無い（世代の版の印は、この作業場の最後の移行 ' + [string]$summary.to + ' と同じ）') '差分の移行を足したブランチの作業場で流す（練習 G は、世代より新しい移行があるときに流す）' }
    $result.from = [string]$summary.from
    $result.to = [string]$summary.to
    $result.sections = @($summary.sections).Count
    $expected = [ordered]@{}
    foreach ($property in $summary.new_tables.PSObject.Properties) { $expected[$property.Name] = $property.Value }
    $result.expected_new_tables = $expected
    Write-DrillOk ('起点 ' + $result.from + ' → ' + $result.to + '（新しい節 ' + $result.sections + '・新しい表 ' + $expected.Count + '）')

    # 2. 戻す（コンテナ A に、道具が出した起点の schema.sql で）
    Write-Host ('2/5 戻す: コンテナ ' + $nameA + ' に、起点の schema.sql で core の scripts\ops\pg-restore.mjs')
    $targetA = Start-DrillTarget $nameA @("type=bind,source=$planDir,target=/plan,readonly", "type=bind,source=$appPath,target=/work,readonly") 'pg-G'
    $restoreStarted = Get-DrillNow
    $artifactDir = Join-Path $gDir 'artifacts'
    Set-DrillPgEnv $targetA
    $restore = Invoke-DrillNative $nodePath @('--disable-warning=ExperimentalWarning', $restoreScript, '--archive', $archiveRoot, '--manifest', $generationKey,
        '--schema', (Join-Path $planDir 'base-schema.sql'), '--artifacts', $artifactDir, '--confirm-empty-target')
    $restoreFinished = Get-DrillNow
    $result.times_utc.restore_finished = Format-DrillUtc $restoreFinished
    $result.durations_ms.restore = Get-DrillElapsedMs $restoreStarted $restoreFinished
    # 原本の複写は練習 F で確かめた。この練習では使わないので消す（作業フォルダの中だけ）。消せなくても練習の結果には響かないので止めない
    # （PS 5.1 は 260 文字を超えるパスの再帰の削除で落ちることがある）
    if ((Test-Path -LiteralPath $artifactDir) -and (Test-DrillUnderRoot $gDir $artifactDir)) {
        try { Remove-Item -LiteralPath $artifactDir -Recurse -Force -ErrorAction Stop }
        catch { Write-Host ('原本の複写のフォルダを消せなかった（練習の結果には響かない。あとで手で消す）: ' + $artifactDir) }
    }
    if ($restore.Code -ne 0) {
        $cause = Get-NodeCause $restore
        if ($cause -eq 'schema_mismatch') { Stop-Drill '戻しが schema_mismatch で止まった（道具が出した起点の schema.sql が、世代の版の印と合わない）' 'この出力を Claude に渡す（変換の決まりが変わったかもしれない）' }
        Stop-Drill ('戻しが ' + $cause + ' で止まった') 'この出力を Claude に渡す（コンテナはこのあと消す）'
    }
    $restoredPath = Join-Path $gDir 'restored.json'
    [IO.File]::WriteAllText($restoredPath, (@($restore.Out) -join "`n").Trim(), $drillUtf8)
    Write-DrillOk ('戻し: 表 ' + $tableRows.Count + '・行 ' + $rowTotal + '・所要 ' + (Format-DrillSeconds $result.durations_ms.restore))

    # 3. 当てる（同じコンテナ A に psql の -1。照合の前 → 差分 → 照合の後 → COMMIT）
    Write-Host ('3/5 当てる: コンテナ ' + $nameA + ' に psql の -1 で check-before.sql → delta.sql → check-after.sql → COMMIT')
    $applyStarted = Get-DrillNow
    $result.times_utc.apply_started = Format-DrillUtc $applyStarted
    $apply = Invoke-DrillNative $dockerPath @('exec', $nameA, 'psql', '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-v', 'SHOW_CONTEXT=never',
        '-U', 'postgres', '-d', 'postgres', '-1', '-f', '/plan/check-before.sql', '-f', '/plan/delta.sql', '-f', '/plan/check-after.sql')
    $applyFinished = Get-DrillNow
    $result.times_utc.apply_finished = Format-DrillUtc $applyFinished
    $result.durations_ms.apply = Get-DrillElapsedMs $applyStarted $applyFinished
    if ($apply.Code -ne 0) {
        $cause = Get-PsqlCause $apply
        Stop-Drill ('差分の移行が ' + $cause + ' で止まった（全部戻った）') 'この出力を Claude に渡す'
    }
    $outputs = ConvertTo-OutputMap $apply.Out
    foreach ($key in @('reconcile_before', 'reconcile_after', 'new_tables', 'apply_started', 'apply_checked')) { if (-not $outputs.ContainsKey($key)) { Stop-Drill ('照合の出力（' + $key + '）が無い') 'この出力を Claude に渡す' } }
    $sqlStarted = ConvertFrom-DrillPgTime $outputs['apply_started']
    $sqlChecked = ConvertFrom-DrillPgTime $outputs['apply_checked']
    $result.times_utc.apply_sql_started = $outputs['apply_started']
    $result.times_utc.apply_sql_checked = $outputs['apply_checked']
    if ($sqlStarted -and $sqlChecked) { $result.durations_ms.apply_in_transaction = Get-DrillElapsedMs $sqlStarted $sqlChecked }
    Write-DrillOk ('当てた: psql の -1（照合の前から COMMIT まで）' + (Format-DrillSeconds $result.durations_ms.apply))
    # ここから先で止まったら、差分はコンテナ A に当て済み（COMMIT 済み）。手元の練習なので、コンテナは片付けで消え、やり直しは同じ1行で作り直す
    $result.committed = $true
    $afterNext = 'この出力を Claude に渡す（差分はコンテナ A に当て済み〈COMMIT 済み〉。コンテナは片付けで消えるので、やり直すときは同じ1行で作り直す）'

    # 4. 新しい全体（コンテナ B に、この作業場の pg/schema.sql）
    Write-Host ('4/5 新しい全体: コンテナ ' + $nameB + ' に、この作業場の pg\schema.sql を psql の -1 で')
    $targetB = Start-DrillTarget $nameB @("type=bind,source=$appPath,target=/work,readonly") 'pg-G'
    $fullStarted = Get-DrillNow
    $full = Invoke-DrillNative $dockerPath @('exec', $nameB, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-1', '-f', '/work/pg/schema.sql')
    $fullFinished = Get-DrillNow
    $result.times_utc.full_finished = Format-DrillUtc $fullFinished
    $result.durations_ms.full_schema = Get-DrillElapsedMs $fullStarted $fullFinished
    if ($full.Code -ne 0) { Stop-Drill '新しい全体の pg/schema.sql を当てられなかった' $afterNext }

    # 5. 比べる
    Write-Host '5/5 比べる: 版の印とカタログの数（A）・定義（A と B）・照合（起点の reconcile.sql の前と後・manifest）・新しい表の行の数'
    $catalog = Invoke-DrillNative $dockerPath @('exec', $nameA, 'psql', '-X', '-q', '-tA', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-f', '/work/pg/verify-catalog.sql')
    if ($catalog.Code -ne 0) { Stop-Drill '差分で当てた DB の verify-catalog.sql を流せなかった' $afterNext }
    $countRows = @($catalog.Out | Where-Object { ([string]$_).Split('|').Count -eq 5 -and ([string]$_).Split('|')[1] -in @('tables', 'triggers', 'functions', 'identities', 'foreign_keys', 'indexes') })
    $result.catalog_ok = ($countRows.Count -eq 6 -and @($countRows | Where-Object { ([string]$_).Split('|')[4] -ne 't' }).Count -eq 0)
    $tablesRow = @($countRows | Where-Object { ([string]$_).Split('|')[1] -eq 'tables' })
    if ($tablesRow.Count -eq 1) { $result.tables_after = [int64]::Parse(([string]$tablesRow[0]).Split('|')[2], $drillInvariant) }
    $snapshotA = Join-Path $gDir 'definition-delta.json'
    $snapshotB = Join-Path $gDir 'definition-full.json'
    Set-DrillPgEnv $targetA
    $takeA = Invoke-DrillNative $nodePath @('--disable-warning=ExperimentalWarning', $migrateScript, 'snapshot', '--out', $snapshotA)
    Set-DrillPgEnv $targetB
    $takeB = Invoke-DrillNative $nodePath @('--disable-warning=ExperimentalWarning', $migrateScript, 'snapshot', '--out', $snapshotB)
    if ($takeA.Code -ne 0 -or $takeB.Code -ne 0) { Stop-Drill ('定義を写せなかった（' + (Get-NodeCause $(if ($takeA.Code -ne 0) { $takeA } else { $takeB })) + '）') $afterNext }
    $compare = Invoke-DrillNative $nodePath @('--disable-warning=ExperimentalWarning', $migrateScript, 'compare', '--left', $snapshotB, '--right', $snapshotA)
    if ($compare.Code -eq 2) { Stop-Drill '定義の写しを読めなかった' $afterNext }
    $compared = (@($compare.Out) -join '') | ConvertFrom-Json
    $result.definitions_equal = [bool]$compared.equal
    $result.definition_differences = @($compared.differences).Count
    $beforeFile = Join-Path $gDir 'reconcile-before.json'
    $afterFile = Join-Path $gDir 'reconcile-after.json'
    [IO.File]::WriteAllText($beforeFile, $outputs['reconcile_before'], $drillUtf8)
    [IO.File]::WriteAllText($afterFile, $outputs['reconcile_after'], $drillUtf8)
    $reconcile = Invoke-DrillNative $nodePath @('--disable-warning=ExperimentalWarning', $reconcileScript, '--left', $beforeFile, '--right', $afterFile)
    $againstManifest = Invoke-DrillNative $nodePath @('--disable-warning=ExperimentalWarning', $reconcileScript, '--left', $manifestPath, '--right', $beforeFile)
    if ($reconcile.Code -eq 2 -or $againstManifest.Code -eq 2) { Stop-Drill '照合の入力を読めなかった' $afterNext }
    $result.reconcile_equal = ($reconcile.Code -eq 0)
    $result.manifest_equal = ($againstManifest.Code -eq 0)
    $result.reconcile_tables = @(($outputs['reconcile_before'] | ConvertFrom-Json)).Count
    $actual = [ordered]@{}
    foreach ($property in ($outputs['new_tables'] | ConvertFrom-Json).PSObject.Properties) { $actual[$property.Name] = [int64]$property.Value }
    $result.new_tables = $actual
    $comparedAt = Get-DrillNow
    $result.times_utc.compared = Format-DrillUtc $comparedAt
    $result.durations_ms.compare = Get-DrillElapsedMs $fullFinished $comparedAt
    $result.durations_ms.total = Get-DrillElapsedMs $startedAt $comparedAt
    $rowsDiffer = @($expected.Keys | Where-Object { $null -ne $expected[$_] -and [int64]$expected[$_] -ne $actual[$_] })
    if (-not $result.catalog_ok) { Stop-Drill '差分で当てた DB のカタログの数が、版の印と合わない' $afterNext }
    if (-not $result.definitions_equal) { Stop-Drill ('差分で当てた DB と新しい全体の DB の定義が違う（' + $result.definition_differences + ' か所）') ('この出力と ' + $snapshotA + '・' + $snapshotB + ' を Claude に渡す（定義の写しに行の値は無い）') }
    if (-not $result.manifest_equal) { Stop-Drill '戻した DB の照合（起点の reconcile.sql）が manifest と違う' $afterNext }
    if (-not $result.reconcile_equal) { Stop-Drill '当てる前と後で、元の表の件数か金額が違う' $afterNext }
    if ($rowsDiffer.Count -gt 0) { Stop-Drill ('新しい表の行の数が移行の正解と違う: ' + ($rowsDiffer -join '・')) $afterNext }
    Write-DrillOk ('比べた: カタログの数と版の印が一致・定義が一致・元の表 ' + $result.reconcile_tables + ' の件数と金額が当てる前と同じで manifest とも同じ・新しい表の行の数が移行の正解と同じ')
    $result.outcome = 'ok'
    $succeeded = $true
    $exitWith = 0
}
catch {
    Write-DrillStop $_
    $exitWith = 1
}
finally {
    if ($dockerPath) {
        foreach ($name in $owned) {
            if (Remove-DrillContainer $dockerPath $name) { Write-Host ('片付け: コンテナ ' + $name + ' を消した') }
            else { Write-Host ('片付け: コンテナ ' + $name + ' が残った。docker rm -f -v ' + $name + ' を流す') }
        }
    }
    Restore-DrillEnv $savedEnv
    $targetA = $null
    $targetB = $null
    if ($gDir -and (Test-Path -LiteralPath $gDir)) {
        try { Write-DrillJson (Join-Path $gDir 'pg-G-result.json') $result }
        catch { Write-Host '結果の JSON を書けなかった（画面の数を使う）' }
    }
}

if ($succeeded) {
    Write-Host ''
    Write-Host '== 練習 G の結果 =='
    Write-Host ('世代: ' + $result.manifest_key + '（manifest の SHA-256: ' + $result.manifest_sha256 + '・snapshot ' + $result.snapshot_at_utc + '）')
    Write-Host ('起点 ' + $result.from + ' → ' + $result.to + '・新しい節 ' + $result.sections + '・表 ' + $result.tables_before + ' → ' + $result.tables_after)
    Write-Host ('戻し: 行 ' + $result.rows_before + '・' + (Format-DrillSeconds $result.durations_ms.restore))
    Write-Host ('差分の移行（psql の -1。照合の前から COMMIT まで）: ' + (Format-DrillSeconds $result.durations_ms.apply) + '（トランザクションの中の差分と照合の後: ' + $result.durations_ms.apply_in_transaction + ' ms）')
    Write-Host ('新しい表の行: ' + (($result.new_tables.Keys | ForEach-Object { $_ + ' ' + $result.new_tables[$_] }) -join '・'))
    Write-Host ('新しい全体の当て: ' + (Format-DrillSeconds $result.durations_ms.full_schema) + '・比べ: ' + (Format-DrillSeconds $result.durations_ms.compare) + '・全体: ' + (Format-DrillSeconds $result.durations_ms.total))
    $resultPath = Join-Path $gDir 'pg-G-result.json'
    Write-Host ('結果の JSON: ' + $resultPath)
    $remove = Read-DrillAnswer '作業フォルダを消しますか（消すなら yes と打つ。Enter で残す）'
    if ($remove -eq 'yes') { [void](Remove-DrillWorkDir $rootDir $gDir 'pg-G-result.json') }
    else { Write-Host '作業フォルダを残した（練習 F の作業フォルダはそのまま）' }
    Write-Host '判定: OK'
    Write-Host '次の一手: この出力（または pg-G-result.json）を Claude に渡す。staging への適用は、そのあと代表が決める'
}
exit $exitWith
