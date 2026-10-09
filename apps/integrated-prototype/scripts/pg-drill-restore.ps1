# ps1-rules: strict
# Windows PowerShell 5.1。PG 計画 段2の実測 S9（練習 F）: R2 の日次の書き出しの世代を取り、手元の Docker の空の PostgreSQL 18.6 へ戻して照合する。
# 代表が次の1行で流す（手順は core の docs/platform/operations/runbooks/03-restore-drill.md「練習 F」）:
#   powershell -ExecutionPolicy Bypass -File "<core の作業場>\apps\integrated-prototype\scripts\pg-drill-restore.ps1"
# 聞かれること: 世代の manifest のキー（-ManifestKey で渡せば聞かない）・前回の作業フォルダの続きを使うか（同じ世代の取得が残っているときだけ）・
#   最後に作業フォルダを消すか（Enter で残す。練習 E がこのフォルダの manifest を使う）
# 流れ: 1 取得（書き出し専用の R2 から manifest → parts と blobs を1つずつ。手元に manifest と同じ大きさと SHA-256 のファイルがあれば飛ばすので、
#   途中で止まっても同じ1行で続きから取れる）→ 2 戻し先（手元の Docker に名前つきのコンテナで空の postgres:18.6-alpine を作り、127.0.0.1 の
#   空いているポートにだけ公開。パスワードはその場で作る使い捨ての値で、画面・記録に出さない）→ 3 DB の戻し（core の scripts/ops/pg-restore.mjs）
#   → 4 原本の確認（pg-restore.mjs が --artifacts へ書いた複写の SHA-256 と数が manifest の blobs と合う）→ 5 照合（scripts/ops/pg-reconcile.mjs）
#   → finally で、作ったコンテナだけを名前で消す。区切りの時刻・所要時間・数を、数値だけの pg-F-result.json（作業フォルダ）と画面に出す
# 作業フォルダは %USERPROFILE%\ondrill\pg-F-<時刻>\（リポジトリの外）。行の値・接続値・wrangler の出力は画面に出さない
# ・-ArchiveDir <フォルダ>: 取得を飛ばし、そのフォルダにある世代（<フォルダ>\pg-daily\…）から戻す（Claude の予行用。wrangler を呼ばない）
# ・-WhatIf: 呼ぶ wrangler の引数を出すだけ（wrangler・Docker・node を呼ばず、フォルダも作らない）。-ArchiveDir も付ければ、その世代の全部の引数を出す
# ・-SchemaFile: 書き出したときの main の版の pg\schema.sql（版の印が合わずに止まったとき、Claude が渡す1行で使う）
# ・-WorkRoot・-ContainerName: 試験用（既定は %USERPROFILE%\ondrill と on-drill-pg-f）
# 終了コード: 0 一致まで通った（と -WhatIf）・1 止まった（画面の「次の一手」を見る）
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ManifestKey,
    [string]$ArchiveDir,
    [string]$SchemaFile,
    [string]$WorkRoot,
    [ValidatePattern('^[a-z0-9][a-z0-9_.-]{0,62}$')][string]$ContainerName
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'pg-drill-common.ps1')
# param の既定値は本文で決める（param の名前へは代入しない。ps1-rules の検査）
$dockerName = 'on-drill-pg-f'
if ($ContainerName) { $dockerName = $ContainerName }

$dryRun = [bool]$WhatIfPreference
$appPath = Split-Path -Parent $PSScriptRoot
$coreRoot = Split-Path -Parent (Split-Path -Parent $appPath)
$restoreScript = Join-Path $coreRoot 'scripts\ops\pg-restore.mjs'
$reconcileScript = Join-Path $coreRoot 'scripts\ops\pg-reconcile.mjs'
$pitrScript = Join-Path $PSScriptRoot 'pg-drill-pitr.ps1'
$savedEnv = Save-DrillEnv @('PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE', 'POSTGRES_PASSWORD', 'CLOUDFLARE_ACCOUNT_ID')

$result = [ordered]@{
    drill = 'F'; outcome = 'ng'; mode = $null; manifest_key = $null; manifest_sha256 = $null; snapshot_at_utc = $null
    schema_last_migration = $null
    objects = [ordered]@{ total = 0; parts = 0; blobs = 0; bytes = 0; fetched = 0; skipped = 0 }
    times_utc = [ordered]@{ acquire_started = $null; acquire_finished = $null; target_ready = $null; restore_finished = $null; blobs_checked = $null; reconcile_finished = $null }
    durations_ms = [ordered]@{ acquire = $null; target = $null; restore = $null; blobs = $null; reconcile = $null; total = $null }
    tables = $null; rows = $null; blobs = $null; blob_fingerprints_match = $null; reconcile_equal = $null; differences = $null
}
$rootDir = $null
$workDir = $null
$dockerPath = $null
$containerOwned = $false
$pushed = $false
$succeeded = $false
$exitWith = 1

# 世代の manifest のキー（-ManifestKey か、尋ねて受ける）。形が違えば止める
function Get-RequestedKey {
    if ($ManifestKey) { $keyText = $ManifestKey }
    else {
        $keyText = Read-DrillAnswer '世代の manifest のキー（pg-daily/<日時>-<実行ID>/manifest.json。Workers Logs の manifest_key か R2 の画面で見る）'
        if ($null -eq $keyText) { Stop-Drill 'manifest のキーを尋ねられない' '-ManifestKey "pg-daily/…/manifest.json" を付けて流し直す' }
    }
    $resolvedKey = ConvertTo-DrillManifestKey $keyText
    if (-not $resolvedKey) {
        Stop-Drill 'manifest のキーの形が違う（pg-daily/<日時>-<実行ID>/manifest.json）' 'R2 の画面の pg-daily/ の下で manifest.json がある世代を選び、そのキーをそのまま貼って流し直す'
    }
    return $resolvedKey
}

Write-Host '練習 F（R2 の日次の書き出しの世代を、手元の Docker の空の PostgreSQL 18.6 へ戻して照合する）'

if ($dryRun) {
    try {
        $generationKey = Get-RequestedKey
        $generation = $generationKey.Substring(0, $generationKey.Length - '/manifest.json'.Length)
        $planned = Join-Path (Resolve-DrillRoot $WorkRoot) ('pg-F-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        Write-Host '予行（-WhatIf）: wrangler・Docker・node は呼ばない。呼ぶ順と引数（apps\integrated-prototype で、CLOUDFLARE_ACCOUNT_ID を wrangler.cloud.jsonc の account_id にして呼ぶ）:'
        Write-Host ('  ' + (Format-DrillCommand @('--no-install', 'wrangler', 'whoami', '--json')))
        Write-Host ('  ' + (Format-DrillCommand (Get-DrillR2GetArgs $generationKey (Get-DrillLocalPath $planned $generationKey))))
        $preview = $null
        if ($ArchiveDir) { $preview = Read-DrillManifest (Get-DrillLocalPath ([IO.Path]::GetFullPath($ArchiveDir)) $generationKey) }
        if ($preview) {
            foreach ($object in (Get-DrillObjects $preview $generation)) {
                Write-Host ('  ' + (Format-DrillCommand (Get-DrillR2GetArgs $object.Key (Get-DrillLocalPath $planned $object.Key))))
            }
        }
        else {
            Write-Host ('  （manifest の parts と blobs の1つずつ。手元に同じ大きさと SHA-256 のファイルがあれば飛ばす）' +
                (Format-DrillCommand (Get-DrillR2GetArgs ($generation + '/<parts か blobs のキー>') ($planned + '\' + ($generation -replace '/', '\') + '\<キー>'))))
        }
        Write-Host '判定: 予行のみ（何も変えていない）'
        $exitWith = 0
    }
    catch {
        Write-DrillStop $_
        $exitWith = 1
    }
    exit $exitWith
}

try {
    $generationKey = Get-RequestedKey
    $generation = $generationKey.Substring(0, $generationKey.Length - '/manifest.json'.Length)
    $result.manifest_key = $generationKey
    $rootDir = Resolve-DrillRoot $WorkRoot
    $archiveSource = $null
    if ($ArchiveDir) {
        $archiveSource = [IO.Path]::GetFullPath($ArchiveDir)
        if (-not (Test-Path -LiteralPath $archiveSource -PathType Container)) { Stop-Drill '-ArchiveDir のフォルダが無い' '世代を書き出したフォルダの絶対パスを渡す' }
    }

    # 0. 先に確かめる（長い取得のあとで止まらないように）
    $nodePath = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $nodePath) { Stop-Drill 'node が見つからない' 'Node.js 24 を入れてから、同じ1行を流し直す' }
    if (-not (Test-Path -LiteralPath $restoreScript) -or -not (Test-Path -LiteralPath $reconcileScript)) { Stop-Drill 'core の scripts\ops に pg-restore.mjs・pg-reconcile.mjs が無い' 'main の最新に同期した core の作業場の ps1 を流す' }
    if (-not (Test-Path -LiteralPath (Join-Path $appPath 'node_modules\pg\package.json'))) {
        Stop-Drill 'apps\integrated-prototype に依存（pg）が入っていない' 'pg と wrangler の入っている core の作業場（配備に使う作業場など）の ps1 を流す。分からなければ Claude に絶対パスの1行を頼む'
    }
    if ($SchemaFile) { $schemaPath = [IO.Path]::GetFullPath($SchemaFile) } else { $schemaPath = Join-Path $appPath 'pg\schema.sql' }
    if (-not (Test-Path -LiteralPath $schemaPath -PathType Leaf)) { Stop-Drill 'schema.sql が見つからない' '-SchemaFile を外すか、Claude が渡した絶対パスのまま流し直す' }
    $dockerPath = Get-DrillDocker

    # 作業フォルダ: 同じ世代の取得が残っている前回のフォルダがあれば、続きから使うかを尋ねる（Enter で使う）
    if (-not (Test-Path -LiteralPath $rootDir)) { [void][IO.Directory]::CreateDirectory($rootDir) }
    if (-not $archiveSource) {
        $previous = @(Get-ChildItem -LiteralPath $rootDir -Directory -Filter 'pg-F-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending |
            Where-Object { Test-Path -LiteralPath (Get-DrillLocalPath $_.FullName $generationKey) -PathType Leaf })
        if ($previous.Count -gt 0) {
            $reuse = Read-DrillAnswer ('前回の作業フォルダ ' + $previous[0].FullName + ' に同じ世代の取得が残っている。続きから使う（Enter）・新しく取り直す（new と打つ）')
            if ($reuse -ne 'new') { $workDir = $previous[0].FullName }
        }
    }
    if (-not $workDir) {
        $workDir = Join-Path $rootDir ('pg-F-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        [void][IO.Directory]::CreateDirectory($workDir)
    }
    if ($archiveSource) { $archiveRoot = $archiveSource; $result.mode = 'archive-dir' } else { $archiveRoot = $workDir; $result.mode = 'r2' }
    $manifestPath = Get-DrillLocalPath $archiveRoot $generationKey
    Write-Host ('世代: ' + $generationKey)
    Write-Host ('作業フォルダ: ' + $workDir)
    Push-Location -LiteralPath $appPath
    $pushed = $true

    # 1. 取得
    $acquireStarted = Get-DrillNow
    $result.times_utc.acquire_started = Format-DrillUtc $acquireStarted
    $wranglerReady = $false
    $manifest = Read-DrillManifest $manifestPath
    if (-not $manifest) {
        if ($archiveSource) { Stop-Drill '-ArchiveDir の世代に manifest.json が無い（か形が違う）' '-ArchiveDir と -ManifestKey の組を確かめる' }
        Initialize-DrillWrangler $appPath
        $wranglerReady = $true
        if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath -Force }
        if (-not (Invoke-DrillR2Get $generationKey $manifestPath)) {
            if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath -Force }
            Stop-Drill 'manifest を取れなかった（キーが無いか、R2 に届かない）' 'R2 の画面で、そのキーの manifest.json があるかを確かめてから、同じ1行を流し直す'
        }
        $manifest = Read-DrillManifest $manifestPath
        if (-not $manifest) { Stop-Drill '取った manifest の形が違う' 'manifest を手で直さない。この出力を Claude に渡す' }
    }
    $result.manifest_sha256 = Get-DrillSha256 $manifestPath
    $snapshot = ConvertFrom-DrillPgTime ([string]$manifest['snapshot_at'])
    if ($snapshot) { $result.snapshot_at_utc = Format-DrillUtc $snapshot }
    if ($manifest['schema'] -is [System.Collections.IDictionary]) { $result.schema_last_migration = [string]$manifest['schema']['last_migration'] }
    $objects = Get-DrillObjects $manifest $generation
    $result.objects.total = $objects.Count
    $result.objects.parts = @($objects | Where-Object { $_.Kind -eq 'part' }).Count
    $result.objects.blobs = @($objects | Where-Object { $_.Kind -eq 'blob' }).Count
    $result.objects.bytes = [int64](($objects | Measure-Object -Property Bytes -Sum).Sum)
    if ($archiveSource) { Write-Host ('1/5 取得: -ArchiveDir の世代を使う（取らない）。' + $objects.Count + ' 個の大きさと SHA-256 を確かめる') }
    else { Write-Host ('1/5 取得: ' + $objects.Count + ' 個を1つずつ取る（手元に manifest と同じ大きさと SHA-256 のファイルがあれば飛ばす）') }
    $done = 0
    foreach ($object in $objects) {
        $objectFile = Get-DrillLocalPath $archiveRoot $object.Key
        if (Test-DrillObjectFile $objectFile $object) { $result.objects.skipped += 1 }
        elseif ($archiveSource) {
            Stop-Drill ('-ArchiveDir の世代のファイルが欠けているか manifest と違う: ' + $object.Key) '-ArchiveDir の世代を書き出し直す'
        }
        else {
            if (-not $wranglerReady) { Initialize-DrillWrangler $appPath; $wranglerReady = $true }
            if (Test-Path -LiteralPath $objectFile) { Remove-Item -LiteralPath $objectFile -Force }
            if (-not (Invoke-DrillR2Get $object.Key $objectFile)) {
                Stop-Drill ('取れなかった: ' + $object.Key) 'R2 に届くか（ネットにつながっているか）を確かめてから、同じ1行を流し直す（取れた分は飛ばして続きから取る）'
            }
            if (-not (Test-DrillObjectFile $objectFile $object)) {
                Remove-Item -LiteralPath $objectFile -Force
                Stop-Drill ('取ったファイルの大きさか SHA-256 が manifest と違う: ' + $object.Key) '同じ1行を流し直す。続けて違うなら、manifest を手で直さずにこの出力を Claude に渡す（世代が壊れているかもしれない）'
            }
            $result.objects.fetched += 1
        }
        $done += 1
        if (-not $archiveSource -and ($done % 25 -eq 0) -and $done -lt $objects.Count) { Write-Host ('   取得 ' + $done + '/' + $objects.Count) }
    }
    $acquireFinished = Get-DrillNow
    $result.times_utc.acquire_finished = Format-DrillUtc $acquireFinished
    $result.durations_ms.acquire = Get-DrillElapsedMs $acquireStarted $acquireFinished
    Write-DrillOk ('取得: ' + $objects.Count + ' 個（parts ' + $result.objects.parts + '・blobs ' + $result.objects.blobs + '。取った ' + $result.objects.fetched +
        '・手元にあって飛ばした ' + $result.objects.skipped + '）・' + $result.objects.bytes + ' バイト・所要 ' + (Format-DrillSeconds $result.durations_ms.acquire))

    # 2. 戻し先: 名前つきのコンテナで空の PostgreSQL 18.6。同じ名前の残り（前に止まった回のもの）を先に片づける
    Write-Host ('2/5 戻し先: 手元の Docker に空の PostgreSQL 18.6（' + $drillImage + '）を名前 ' + $dockerName + ' で作る')
    if (Get-DrillContainerStatus $dockerPath $dockerName) {
        if (-not (Remove-DrillContainer $dockerPath $dockerName)) { Stop-Drill ('前の回のコンテナ ' + $dockerName + ' を消せない') ('docker rm -f -v ' + $dockerName + ' を流してから、同じ1行を流し直す') }
    }
    $port = Get-DrillFreePort
    $password = New-DrillPassword
    $env:POSTGRES_PASSWORD = $password
    $containerOwned = $true
    $started = Invoke-DrillNative $dockerPath @('run', '-d', '--name', $dockerName, '--label', 'openingnight.drill=pg-F', '-e', 'POSTGRES_PASSWORD',
        '-p', ('127.0.0.1:' + $port + ':5432'), $drillImage)
    $env:POSTGRES_PASSWORD = $null
    if ($started.Code -ne 0) { Stop-Drill '戻し先のコンテナを始められない' 'Docker Desktop を起動し直してから、同じ1行を流し直す（取れた分は飛ばす）' }
    $deadline = (Get-Date).AddSeconds(90)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        $probe = Invoke-DrillNative $dockerPath @('exec', $dockerName, 'pg_isready', '-q', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres')
        if ($probe.Code -eq 0) { $ready = $true; break }
        if ((Get-DrillContainerStatus $dockerPath $dockerName) -notlike 'Up*') { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { Stop-Drill '戻し先の PostgreSQL が90秒のうちに起動しない' 'Docker Desktop を起動し直してから、同じ1行を流し直す（取れた分は飛ばす）' }
    # 公開したポートの先まで応えるか（コンテナの中の pg_isready だけでは、公開したポートが即切れる不調を見落とす）
    $deadline = (Get-Date).AddSeconds(20)
    $reachable = $false
    while ((Get-Date) -lt $deadline) {
        if (Test-DrillPostgresPort $port 2000) { $reachable = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $reachable) {
        Stop-Drill ('127.0.0.1:' + $port + ' の PostgreSQL に届かない（Docker の公開ポートの不調かもしれない）') 'Docker Desktop を終了して起動し直してから、同じ1行を流し直す（取れた分は飛ばす）'
    }
    $targetReady = Get-DrillNow
    $result.times_utc.target_ready = Format-DrillUtc $targetReady
    $result.durations_ms.target = Get-DrillElapsedMs $acquireFinished $targetReady
    Write-DrillOk ('戻し先: 127.0.0.1:' + $port + ' だけに公開した空の PostgreSQL・所要 ' + (Format-DrillSeconds $result.durations_ms.target))

    # 3. DB の戻し（03 の練習 F の手順2の引数のまま。接続は pg 標準の環境変数で、値を出さない）
    Write-Host '3/5 DB の戻し: scripts\ops\pg-restore.mjs（全部を1つのトランザクションで戻し、件数と金額と SHA-256 を確かめてから確定する）'
    $artifactDir = Join-Path $workDir 'artifacts'
    if (Test-Path -LiteralPath $artifactDir) {
        # 前の回の複写を消してから書き直す（原本の数を数え直すため）。作業フォルダの中だけ
        if (-not (Test-DrillUnderRoot $workDir $artifactDir)) { Stop-Drill '原本の複写のフォルダが作業フォルダの外' 'この出力を Claude に渡す' }
        Remove-Item -LiteralPath $artifactDir -Recurse -Force
    }
    $env:PGHOST = '127.0.0.1'
    $env:PGPORT = [string]$port
    $env:PGUSER = 'postgres'
    $env:PGPASSWORD = $password
    $env:PGDATABASE = 'postgres'
    $env:PGSSLMODE = 'disable'
    $restore = Invoke-DrillNative $nodePath @('--disable-warning=ExperimentalWarning', $restoreScript, '--archive', $archiveRoot, '--manifest', $generationKey,
        '--schema', $schemaPath, '--artifacts', $artifactDir, '--confirm-empty-target')
    $restoreFinished = Get-DrillNow
    $result.times_utc.restore_finished = Format-DrillUtc $restoreFinished
    $result.durations_ms.restore = Get-DrillElapsedMs $targetReady $restoreFinished
    if ($restore.Code -ne 0) {
        $cause = 'unexpected'
        foreach ($line in @($restore.Err)) {
            $hit = [regex]::Match($line, '"event":"pg_restore_failed","cause":"([A-Za-z0-9_]+)"')
            if ($hit.Success) { $cause = $hit.Groups[1].Value }
        }
        if ($cause -eq 'schema_mismatch') {
            $fingerprint = ''
            if ($manifest['schema'] -is [System.Collections.IDictionary]) {
                $fingerprint = '（manifest の版の印: 最後の移行 ' + [string]$manifest['schema']['last_migration'] + '・ddl_sha256 の先頭 ' + ([string]$manifest['schema']['ddl_sha256']).Substring(0, [Math]::Min(12, ([string]$manifest['schema']['ddl_sha256']).Length)) + '）'
            }
            Stop-Drill ('DB の戻しが schema_mismatch で止まった。手元の schema.sql の版が、書き出したときの main の版と違う' + $fingerprint) '書き出したときの main の版の schema.sql が要る。取り違えて戻さない。この出力を Claude に渡す（Claude がその版の schema.sql を用意し、-SchemaFile を付けた1行を渡す）'
        }
        if ($cause -match '^(part_checksum|part_missing_or_large|part_order|table_checksum|invalid_part|invalid_ndjson|invalid_row_shape|manifest_missing|manifest_invalid|artifact_manifest_missing|artifact_manifest_extra|invalid_artifact_key|invalid_artifact_target|restore_reconciliation|table_set_mismatch|table_shape_mismatch)$') {
            Stop-Drill ('DB の戻しが ' + $cause + ' で止まった（取った世代が manifest と合わない）') 'manifest を手で直さない。前回の作業フォルダを使わずに取り直す（同じ1行を流し、続きを尋ねられたら new と打つ）。続けて止まるならこの出力を Claude に渡す'
        }
        if ($cause -eq 'unexpected' -or $cause -match '^(08|57P0)') {
            Stop-Drill ('DB の戻しが ' + $cause + ' で止まった（手元の PostgreSQL への接続が切れたかもしれない。Docker の公開ポートの不調かもしれない）') 'Docker Desktop を終了して起動し直してから、同じ1行を流し直す（取れた分は飛ばす）。続けて止まるならこの出力を Claude に渡す'
        }
        Stop-Drill ('DB の戻しが ' + $cause + ' で止まった') 'この出力を Claude に渡す（戻した DB は使わない。コンテナはこのあと消す）'
    }
    $restoredJson = (@($restore.Out) -join "`n").Trim()
    $restoredPath = Join-Path $workDir 'restored.json'
    [IO.File]::WriteAllText($restoredPath, $restoredJson, $drillUtf8)
    $tableRows = @($manifest['tables'])
    $rowTotal = [int64]0
    foreach ($table in $tableRows) { $rowTotal += [int64]::Parse([string]$table['row_count'], $drillInvariant) }
    $result.tables = $tableRows.Count
    $result.rows = $rowTotal
    Write-DrillOk ('DB の戻し: 表 ' + $tableRows.Count + '・行 ' + $rowTotal + '・所要 ' + (Format-DrillSeconds $result.durations_ms.restore))

    # 4. 原本の確認（03 の練習 F の手順3）: 複写の SHA-256 が manifest の blobs の sha256 とキーの名前の指紋の両方に合い、数も同じ
    Write-Host '4/5 原本の確認: R2 へ逃がした値の複写の指紋と数'
    $blobList = @($manifest['blobs'])
    foreach ($blob in $blobList) {
        $target = [string]$blob['target']
        $blobFile = Get-DrillLocalPath $artifactDir $target
        if (-not (Test-Path -LiteralPath $blobFile -PathType Leaf)) { Stop-Drill ('原本の複写が無い: ' + $target) 'この出力を Claude に渡す' }
        $blobHash = Get-DrillSha256 $blobFile
        if ($blobHash -ne [string]$blob['sha256'] -or -not $target.EndsWith('/' + $blobHash)) { Stop-Drill ('原本の指紋が manifest と違う: ' + $target) 'この出力を Claude に渡す（戻した DB は使わない）' }
    }
    $copied = 0
    if (Test-Path -LiteralPath $artifactDir) { $copied = @(Get-ChildItem -LiteralPath $artifactDir -Recurse -File).Count }
    if ($copied -ne $blobList.Count) { Stop-Drill ('原本の複写の数（' + $copied + '）が manifest の blobs（' + $blobList.Count + '）と違う') 'この出力を Claude に渡す' }
    $blobsChecked = Get-DrillNow
    $result.times_utc.blobs_checked = Format-DrillUtc $blobsChecked
    $result.durations_ms.blobs = Get-DrillElapsedMs $restoreFinished $blobsChecked
    $result.blobs = $blobList.Count
    $result.blob_fingerprints_match = $true
    Write-DrillOk ('原本: ' + $blobList.Count + ' 個の指紋と数が manifest と一致・所要 ' + (Format-DrillSeconds $result.durations_ms.blobs))

    # 5. 照合（表ごとの件数と金額の合計）
    Write-Host '5/5 照合: scripts\ops\pg-reconcile.mjs（manifest と戻した DB の表ごとの件数と金額の合計）'
    $reconcile = Invoke-DrillNative $nodePath @('--disable-warning=ExperimentalWarning', $reconcileScript, '--left', $manifestPath, '--right', $restoredPath)
    $reconcileFinished = Get-DrillNow
    $result.times_utc.reconcile_finished = Format-DrillUtc $reconcileFinished
    $result.durations_ms.reconcile = Get-DrillElapsedMs $blobsChecked $reconcileFinished
    $result.durations_ms.total = Get-DrillElapsedMs $acquireStarted $reconcileFinished
    $verdict = [regex]::Match((@($reconcile.Out) -join ''), '"equal":(true|false)')
    $diffCount = ([regex]::Matches((@($reconcile.Out) -join ''), '"reason":')).Count
    if ($reconcile.Code -eq 2 -or -not $verdict.Success) { Stop-Drill '照合の入力を読めなかった' 'この出力を Claude に渡す' }
    $result.reconcile_equal = ($reconcile.Code -eq 0 -and $verdict.Groups[1].Value -eq 'true')
    $result.differences = $diffCount
    if (-not $result.reconcile_equal) {
        # 違いの数は、表ごとの違いの項目（件数・金額の合計など）の数。1つの表で件数と金額が違えば2と数える
        Stop-Drill ('照合が不一致（違い ' + $diffCount + ' 件）') '戻した DB は使わない。この出力を Claude に渡す'
    }
    Write-DrillOk ('照合: 一致（表 ' + $tableRows.Count + ' の件数と金額の合計）・所要 ' + (Format-DrillSeconds $result.durations_ms.reconcile))
    $result.outcome = 'ok'
    $succeeded = $true
    $exitWith = 0
}
catch {
    Write-DrillStop $_
    $exitWith = 1
}
finally {
    if ($pushed) { Pop-Location }
    if ($containerOwned -and $dockerPath) {
        if (Remove-DrillContainer $dockerPath $dockerName) { Write-Host ('片付け: 戻し先のコンテナ ' + $dockerName + ' を消した') }
        else { Write-Host ('片付け: コンテナ ' + $dockerName + ' が残った。docker rm -f -v ' + $dockerName + ' を流す') }
    }
    Restore-DrillEnv $savedEnv
    $password = $null
    if ($workDir -and (Test-Path -LiteralPath $workDir)) {
        try { Write-DrillJson (Join-Path $workDir 'pg-F-result.json') $result }
        catch { Write-Host '結果の JSON を書けなかった（画面の数を使う）' }
    }
}

if ($succeeded) {
    Write-Host ''
    Write-Host '== 練習 F の結果 =='
    Write-Host ('世代: ' + $result.manifest_key + '（manifest の SHA-256: ' + $result.manifest_sha256 + '・snapshot ' + $result.snapshot_at_utc + '）')
    Write-Host ('取得: ' + $result.objects.total + ' 個・' + (Format-DrillSeconds $result.durations_ms.acquire) + '（' + $result.times_utc.acquire_started + ' → ' + $result.times_utc.acquire_finished + '）')
    Write-Host ('戻し先の準備: ' + (Format-DrillSeconds $result.durations_ms.target))
    Write-Host ('DB の戻し: 表 ' + $result.tables + '・行 ' + $result.rows + '・' + (Format-DrillSeconds $result.durations_ms.restore) + '（' + $result.times_utc.restore_finished + ' に終わり）')
    Write-Host ('原本の確認: ' + $result.blobs + ' 個・一致・' + (Format-DrillSeconds $result.durations_ms.blobs))
    Write-Host ('照合: 一致・' + (Format-DrillSeconds $result.durations_ms.reconcile) + '（' + $result.times_utc.reconcile_finished + ' に終わり）・取得の始めから ' + (Format-DrillSeconds $result.durations_ms.total))
    $resultPath = Join-Path $workDir 'pg-F-result.json'
    Write-Host ('結果の JSON: ' + $resultPath)
    $remove = Read-DrillAnswer '作業フォルダを消しますか（消すなら yes と打つ。Enter で残す。練習 E はこのフォルダの manifest を使う）'
    if ($remove -eq 'yes') { [void](Remove-DrillWorkDir $rootDir $workDir 'pg-F-result.json') }
    else {
        Write-Host '作業フォルダを残した'
        Write-Host '練習 E は、次の1行で流す（G1 の snapshot から24時間以内に始める）:'
        Write-Host ('  powershell -ExecutionPolicy Bypass -File "' + $pitrScript + '" -ManifestFile "' + $manifestPath + '"')
    }
    Write-Host '判定: OK'
    Write-Host '次の一手: この出力（または pg-F-result.json）を Claude に渡す'
}
exit $exitWith
