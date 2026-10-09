# ps1-rules: strict
# Windows PowerShell 5.1。PG 計画 段2の実測 S10（練習 E）: 基準の世代 G1 の manifest と、PlanetScale の PITR で作った drill のブランチを照合する。
# 代表が次の1行で流す（練習 F の最後に出る1行。手順は core の docs/platform/operations/runbooks/03-restore-drill.md「練習 E」）:
#   powershell -ExecutionPolicy Bypass -File "<core の作業場>\apps\integrated-prototype\scripts\pg-drill-pitr.ps1" -ManifestFile "<F の作業フォルダ>\pg-daily\…\manifest.json"
# -ManifestFile を付けないときは manifest のキーを尋ね、F と同じ取得（manifest だけ）で用意する。
# 流れ: 1 G1 の snapshot の時刻を UTC と日本時間で出す。今が snapshot から24時間を過ぎていたら止める（次の世代を基準にやり直す）
#   → 2 G1 の後に staging を使っていないかを尋ね（Enter だけで進む。ほかの答えは止める）、今の時刻（UTC）を戻す時刻として記録する
#   （G1 の snapshot より後で、24時間以内であることを確かめる）
#   → 3 「staging の画面で架空の作品を1件登録して Enter」→ 4 戻す時刻から新しい drill のブランチを作るよう、時刻（UTC と日本時間）と
#   pscale の1行を出す（代表に時刻を手で打たせない。pscale は別の窓で流す）→ 「PITR を始めた」で Enter（その時刻を記録し、24時間以内かを確かめる）
#   → 復旧の時刻が戻す時刻と合うかを尋ねる（違えば消して同じ時刻で作り直す）→ 「drill のブランチにつながるようになった」で Enter
#   → 5 接続値を尋ね（Host・Username は Read-Host、Password は -AsSecureString。03 の共通準備と同じ。窓に前の値が残っていても使わない）、
#   環境変数の名前だけを docker へ渡す。手元の Docker の postgres:18.6-alpine の psql（-1 を付けない・ON_ERROR_STOP=1・verify-full・
#   PGSSLROOTCERT=system）で reconcile-json.sql を流し、core の scripts/ops/pg-reconcile.mjs で G1 の manifest と照合する
#   （一致すれば、G1 の後に入れた1件が drill に無いことも示せる）
#   → 6 「drill のブランチを消して Enter」（その時刻を記録）。接続の環境変数を消す
# Enter だけを待つ問い（1件の登録・PITR の開始・接続可能・削除）では、何かを打った・貼ったときは、この窓では流れていないことを伝えて尋ね直す
# 区切りの時刻・所要時間・照合の一致を、数値だけの pg-E-result.json（%USERPROFILE%\ondrill\pg-E-<時刻>\）と画面に出す。行の値・接続値は出さない
# ・-LocalTarget: PITR と代表への問いを飛ばし、照合の部分だけを手元の DB（PGHOST=127.0.0.1 などを先に設定）に向けて流す（Claude の予行用）
# ・-WorkRoot は試験用（既定は %USERPROFILE%\ondrill）。-PlanetScaleDatabase・-SourceBranch は pscale の1行に入れる名前
# 終了コード: 0 一致まで通った・1 止まった（画面の「次の一手」を見る）
[CmdletBinding()]
param(
    [string]$ManifestFile,
    [string]$ManifestKey,
    [switch]$LocalTarget,
    [string]$WorkRoot,
    [ValidatePattern('^[a-z0-9][a-z0-9_-]{0,63}$')][string]$PlanetScaleDatabase,
    [ValidatePattern('^[a-z0-9][a-z0-9-]{0,63}$')][string]$SourceBranch
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'pg-drill-common.ps1')
# param の既定値は本文で決める（param の名前へは代入しない。ps1-rules の検査）。staging は openingnight_integrated の main（runbooks/11 手順3）
$databaseName = 'openingnight_integrated'
if ($PlanetScaleDatabase) { $databaseName = $PlanetScaleDatabase }
$sourceName = 'main'
if ($SourceBranch) { $sourceName = $SourceBranch }

$appPath = Split-Path -Parent $PSScriptRoot
$coreRoot = Split-Path -Parent (Split-Path -Parent $appPath)
$reconcileScript = Join-Path $coreRoot 'scripts\ops\pg-reconcile.mjs'
$reconcileSql = Join-Path $appPath 'pg\reconcile.sql'
$pgNames = @('PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE', 'CLOUDFLARE_ACCOUNT_ID')
$savedEnv = Save-DrillEnv $pgNames
$maxHours = 24

$result = [ordered]@{
    drill = 'E'; outcome = 'ng'; mode = $null; manifest_key = $null; manifest_sha256 = $null; snapshot_at_utc = $null
    hours_since_snapshot = $null; drill_branch = $null; restore_point_utc = $null; pitr_rounds = $null
    times_utc = [ordered]@{ started = $null; insert_done = $null; pitr_started = $null; connectable = $null; reconcile_finished = $null; branch_deleted = $null }
    durations_ms = [ordered]@{ pitr_to_connectable = $null; connectable_to_reconciled = $null; pitr_to_reconciled = $null; branch_lifetime = $null }
    tables = $null; reconcile_equal = $null; differences = $null
}
$workDir = $null
$pushed = $false
$succeeded = $false
$pitrStarted = $null
$pitrRound = 1
$exitWith = 1
$nextGeneration = '次の世代を基準にやり直す（次の世代の manifest のキーで練習 F の取得をしてから、F の最後に出る1行を流す）'
$afterPitrNext = 'このあと drill のブランチを消す。次の世代を基準にやり直す（次の世代までは staging の画面を使わない。次の世代の manifest のキーで練習 F の取得をしてから、F の最後に出る1行を流す）'

# 尋ねる（Enter を待つ）。尋ねられないときは止める（-NonInteractive では PITR の手順を進められない）
function Wait-DrillEnter([string]$Prompt) {
    $reply = Read-DrillAnswer $Prompt
    if ($null -eq $reply) { Stop-Drill '尋ねられないので止めた（-NonInteractive では流せない）' '-NonInteractive を外して、同じ1行を流し直す' }
    return $reply
}

# Enter だけを待つ（1件の登録・PITR の開始・接続可能・ブランチの削除）。何かを打った・貼ったときは、この窓では流れていないことを伝えて
# 尋ね直す（pscale の1行をこの窓に貼ると Enter の答えとして読まれ、PITR を始めていない・ブランチを消していないのに時刻を記録してしまう）。
# 尋ねられないときは $null
function Read-DrillEnterOnly([string]$EnterPrompt) {
    while ($true) {
        $typedLine = Read-DrillAnswer $EnterPrompt
        if ($null -eq $typedLine -or [string]::IsNullOrWhiteSpace($typedLine)) { return $typedLine }
        Write-Host '   この窓に打った・貼った行は流れていない。pscale の行は別の PowerShell の窓（pscale にログインした窓）で流し、この窓では Enter だけを押す'
    }
}

# Read-DrillEnterOnly と同じ。尋ねられないときは止める
function Wait-DrillEnterOnly([string]$EnterPrompt) {
    if ($null -eq (Read-DrillEnterOnly $EnterPrompt)) { Stop-Drill '尋ねられないので止めた（-NonInteractive では流せない）' '-NonInteractive を外して、同じ1行を流し直す' }
}

# G1 の snapshot から maxHours 以内か（計画: G1 から24時間以内に PITR を始める）。起動したときだけでなく、戻す時刻を記録したとき・
# PITR を始めたときにも確かめる（問いのところで待つあいだに過ぎることがある）。過ぎていれば止める
function Assert-DrillWithinHours([DateTimeOffset]$CheckedAt, [string]$CheckedMoment, [string]$CheckedNext) {
    if (($CheckedAt - $snapshot).TotalHours -le $maxHours) { return }
    $momentText = ''
    if ($CheckedMoment) { $momentText = '（' + $CheckedMoment + '）' }
    Stop-Drill ('G1 の snapshot から ' + $maxHours + ' 時間を過ぎている' + $momentText) $CheckedNext
}

# PITR で新しい drill のブランチを作る案内（作り直すときも出す）。PlanetScale の画面の時刻の欄が UTC か日本時間かは確かめていないので、
# 両方を出して、画面の表示に合う方を貼ってもらう（合わない方を貼ると9時間ずれる）
function Show-DrillPitrGuide {
    Write-Host ''
    Write-Host ('!! PlanetScale で、下の時刻から「新しい」drill のブランチを作る。元の staging のブランチ（' + $sourceName + '）と本番は上書きしない !!')
    Write-Host ('   戻す時刻（UTC）: ' + $pointText + '（' + $pointUtcPlain + '）')
    Write-Host ('   戻す時刻（日本時間）: ' + $pointJst)
    Write-Host ('   新しいブランチの名前: ' + $branchName + '（名前に drill がある）')
    Write-Host '   画面で作るとき: DB の画面で、時刻を指定して新しいブランチへ戻す（point-in-time）。時刻の欄が UTC か日本時間かを画面の表示で見て、'
    Write-Host '     合う方の時刻を貼る（合わない方を貼ると9時間ずれる）。欄が UTC か日本時間か分からないときは、画面で作らずに下の pscale の1行で作る'
    Write-Host '   画面がまだその時刻を選べない（直前すぎる）ときは、数分待ってから同じ時刻で作る（時刻を変えない）'
    Write-Host '   pscale で作るとき: 次の1行を、別の PowerShell の窓（pscale にログインした窓）に貼って流す。この窓には貼らない（この窓では Enter だけを押す）'
    Write-Host ('     pscale branch create ' + $databaseName + ' ' + $branchName + ' --from ' + $sourceName + ' --restore-point ' + $pointText)
    Write-Host ('   DB の名前（' + $databaseName + '）か元のブランチ（' + $sourceName + '）が画面と違うときは、作らずに Claude に伝える')
}

# 作った drill のブランチの復旧の時刻が戻す時刻と合うかを尋ねる。合えば $true・違う（どちらの表示か分からない）なら $false。
# 画面で9時間前の時刻を選ぶと G1 より前に戻り、その間に書き込みが無ければ照合は一致してしまう（1件の確かめも外れを見つけられない）ので、人の目で確かめる
function Test-DrillRestorePoint {
    Write-Host ''
    Write-Host '   復旧の時刻の確かめ: pscale の1行で作ったなら、そのまま Enter。画面で作ったなら、drill のブランチの画面に出る復旧の時刻（restore point）を見て、'
    Write-Host ('   その表示が UTC なら ' + $pointUtcPlain + '、日本時間なら ' + $pointJst + ' と同じかを確かめる')
    while ($true) {
        $pointAnswer = Read-DrillAnswer '同じなら Enter だけを押す。違う・UTC か日本時間か分からないなら no と打つ'
        if ($null -eq $pointAnswer) { Stop-Drill '尋ねられないので止めた（-NonInteractive では流せない）' '-NonInteractive を外して、同じ1行を流し直す' }
        if ([string]::IsNullOrWhiteSpace($pointAnswer)) { return $true }
        if ($pointAnswer.Trim() -eq 'no') { return $false }
        Write-Host '   Enter だけ（同じ）か no（違う・分からない）で答える。pscale の行はこの窓では流れない'
    }
}

# 接続の値を1つ尋ねる。空か、形が違う文字（BadPattern）を含むときは理由を出して3回まで尋ね直し、それでも違えば止める
function Read-DrillValue([string]$Question, [string]$BadPattern, [string]$Complaint) {
    for ($try = 1; $try -le 3; $try++) {
        $typed = ([string](Wait-DrillEnter $Question)).Trim()
        if ($typed -and $typed -notmatch $BadPattern) { return $typed }
        if ($try -lt 3) { Write-Host ('   ' + $Complaint + '。もう一度貼る') }
    }
    Stop-Drill ($Complaint + '（3回）') '画面で drill のブランチの接続の値を確かめ、Claude に伝える（値は渡さない。drill のブランチはこのあと消す）'
}

# 結果の JSON を書く（作業フォルダがあるときだけ）
function Save-DrillResult {
    if ($workDir -and (Test-Path -LiteralPath $workDir)) {
        try { Write-DrillJson (Join-Path $workDir 'pg-E-result.json') $result }
        catch { Write-Host '結果の JSON を書けなかった（画面の数を使う）' }
    }
}

try {
    $startedAt = Get-DrillNow
    $result.times_utc.started = Format-DrillUtc $startedAt
    if ($LocalTarget) { $result.mode = 'local' } else { $result.mode = 'planetscale' }
    Write-Host '練習 E（基準の世代 G1 の manifest と、PlanetScale の PITR で作った drill のブランチを照合する）'
    if ($LocalTarget) { Write-Host '-LocalTarget: PITR と問いを飛ばし、照合だけを手元の DB に向けて流す（予行）' }

    # 0. 先に確かめる
    $nodePath = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $nodePath) { Stop-Drill 'node が見つからない' 'Node.js 24 を入れてから、同じ1行を流し直す' }
    if (-not (Test-Path -LiteralPath $reconcileScript) -or -not (Test-Path -LiteralPath $reconcileSql)) { Stop-Drill 'pg-reconcile.mjs か pg\reconcile.sql が無い' 'main の最新に同期した core の作業場の ps1 を流す' }
    if ($LocalTarget) {
        if (-not $ManifestFile) { Stop-Drill '-LocalTarget には -ManifestFile が要る' '-ManifestFile に基準の manifest の絶対パスを渡す' }
        if (@('127.0.0.1', 'localhost', '::1') -notcontains [string]$env:PGHOST -or [string]$env:PGPORT -notmatch '^\d{1,5}$' -or
            [string]::IsNullOrWhiteSpace($env:PGUSER) -or [string]::IsNullOrEmpty($env:PGPASSWORD)) {
            Stop-Drill '-LocalTarget は手元の DB だけに向ける（PGHOST=127.0.0.1・PGPORT・PGUSER・PGPASSWORD を先に設定する）' 'PG* を手元の DB の値にしてから流し直す'
        }
    }
    $dockerPath = Get-DrillDocker
    $rootDir = Resolve-DrillRoot $WorkRoot
    $workDir = Join-Path $rootDir ('pg-E-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    [void][IO.Directory]::CreateDirectory($workDir)
    Write-Host ('作業フォルダ: ' + $workDir)

    # 1. 基準の世代 G1 の manifest
    if ($ManifestFile) {
        $baselinePath = [IO.Path]::GetFullPath($ManifestFile)
        $keyHit = [regex]::Match($baselinePath, '(pg-daily[\\/][A-Za-z0-9.-]+[\\/]manifest\.json)$')
        if ($keyHit.Success) { $result.manifest_key = $keyHit.Groups[1].Value -replace '\\', '/' }
    }
    else {
        $keyText = $ManifestKey
        if (-not $keyText) { $keyText = Wait-DrillEnter '基準の世代 G1 の manifest のキー（pg-daily/<日時>-<実行ID>/manifest.json）' }
        $baselineKey = ConvertTo-DrillManifestKey $keyText
        if (-not $baselineKey) { Stop-Drill 'manifest のキーの形が違う（pg-daily/<日時>-<実行ID>/manifest.json）' 'R2 の画面で manifest.json がある世代のキーを貼って流し直す' }
        $result.manifest_key = $baselineKey
        $baselinePath = Get-DrillLocalPath $workDir $baselineKey
        Push-Location -LiteralPath $appPath
        $pushed = $true
        Initialize-DrillWrangler $appPath
        if (-not (Invoke-DrillR2Get $baselineKey $baselinePath)) {
            if (Test-Path -LiteralPath $baselinePath) { Remove-Item -LiteralPath $baselinePath -Force }
            Stop-Drill 'manifest を取れなかった（キーが無いか、R2 に届かない）' 'R2 の画面で、そのキーの manifest.json があるかを確かめてから、同じ1行を流し直す'
        }
        Pop-Location
        $pushed = $false
    }
    $baseline = Read-DrillManifest $baselinePath
    if (-not $baseline) { Stop-Drill '基準の manifest が無いか、形が違う' '練習 F の最後に出た1行（-ManifestFile 付き）をそのまま流す' }
    $result.manifest_sha256 = Get-DrillSha256 $baselinePath
    $result.tables = @($baseline['tables']).Count
    $snapshot = ConvertFrom-DrillPgTime ([string]$baseline['snapshot_at'])
    if ($null -eq $snapshot) { Stop-Drill 'manifest の snapshot_at を読めない' 'manifest を手で直さない。この出力を Claude に渡す' }
    $result.snapshot_at_utc = Format-DrillUtc $snapshot
    $now = Get-DrillNow
    $hours = ($now - $snapshot).TotalHours
    $result.hours_since_snapshot = [Math]::Round($hours, 2)
    Write-Host ('G1 の snapshot: ' + (Format-DrillUtc $snapshot) + '（UTC）・' + (Format-DrillJst $snapshot) + '・いまから ' + $hours.ToString('0.0', $drillInvariant) + ' 時間前')
    Assert-DrillWithinHours $now '' $nextGeneration
    if ($hours -lt 0) { Stop-Drill 'G1 の snapshot がいまより後になっている（この PC の時計がずれている）' 'Windows の時刻を合わせてから、同じ1行を流し直す' }

    # 照合の SQL（03 の共通準備と同じ形: 注釈の行を外し、末尾の ; を外して json_agg で包む）
    $sqlText = [IO.File]::ReadAllText($reconcileSql)
    $sqlText = [regex]::Replace($sqlText, '(?m)^--[^\r\n]*', '').Trim().TrimEnd(';')
    [IO.File]::WriteAllText((Join-Path $workDir 'reconcile-json.sql'), ('SELECT json_agg(t) FROM (' + $sqlText + ') t;'), $drillUtf8)

    if ($LocalTarget) {
        $dockerEnv = @('-e', 'PGHOST=host.docker.internal', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', ('PGDATABASE=' + $(if ($env:PGDATABASE) { $env:PGDATABASE } else { 'postgres' })),
            '-e', 'PGSSLMODE=disable')
    }
    else {
        # 2. 戻す時刻（今。G1 の snapshot より後で24時間以内）。Enter だけで進む（no・n・いいえ などは、使ったかもしれないものとして止める）
        $untouched = Read-DrillAnswer 'G1 の後に staging の画面で登録・変更をしていなければ Enter だけを押す（した・分からないなら no と打つ）'
        if ($null -eq $untouched) { Stop-Drill '尋ねられないので止めた（-NonInteractive では流せない）' '-NonInteractive を外して、同じ1行を流し直す' }
        if (-not [string]::IsNullOrWhiteSpace($untouched)) {
            Stop-Drill 'G1 の後に staging を使ったかもしれない（Enter 以外の答え。G1 と drill が合わなくなる）' '次の世代を基準にやり直す（次の世代までは staging の画面を使わない。次の世代の manifest のキーで練習 F の取得をしてから、F の最後に出る1行を流す）。使っていないなら、同じ1行を流して Enter だけを押す'
        }
        $restorePoint = Get-DrillNow
        $restorePoint = $restorePoint.AddTicks(-($restorePoint.Ticks % [TimeSpan]::TicksPerSecond))
        if ($restorePoint -le $snapshot) { Stop-Drill '戻す時刻が G1 の snapshot より後にならない' '1分待ってから、同じ1行を流し直す' }
        Assert-DrillWithinHours $restorePoint '戻す時刻を記録したとき' $nextGeneration
        $pointText = $restorePoint.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", $drillInvariant)
        $pointUtcPlain = $restorePoint.ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss', $drillInvariant)
        $pointJst = $restorePoint.ToOffset([TimeSpan]::FromHours(9)).ToString('yyyy-MM-dd HH:mm:ss', $drillInvariant)
        $baseBranch = 'integrated-drill-' + $restorePoint.ToUniversalTime().ToString('yyyyMMddHHmmss', $drillInvariant)
        $branchName = $baseBranch
        $result.restore_point_utc = $pointText
        $result.drill_branch = $branchName
        Write-Host ''
        Write-Host ('戻す時刻を記録した: ' + $pointText + '（UTC）・' + (Format-DrillJst $restorePoint))

        # 3. G1 の後に1件入れる（PITR の後の drill には無いはずの1件）
        Wait-DrillEnterOnly 'staging の画面で架空の作品を1件登録して、終わったら Enter'
        $result.times_utc.insert_done = Format-DrillUtc (Get-DrillNow)

        # 4. PITR で新しい drill のブランチを作る（元の staging のブランチと本番を上書きしない）
        Show-DrillPitrGuide
        Wait-DrillEnterOnly 'PITR を始めたら（drill のブランチを作り始めたら）Enter'
        $pitrStarted = Get-DrillNow
        $result.times_utc.pitr_started = Format-DrillUtc $pitrStarted
        Assert-DrillWithinHours $pitrStarted 'PITR を始めたとき' $afterPitrNext
        # 復旧の時刻が戻す時刻と違えば、そのブランチを消して同じ時刻で作り直す（同じ1行を流し直すと戻す時刻が1件の後になるので、ここでやり直す）
        while (-not (Test-DrillRestorePoint)) {
            if ($pitrRound -ge 3) {
                Stop-Drill '復旧の時刻が3回とも戻す時刻と合わない' 'このあと drill のブランチを消す。この出力を Claude に渡す（G1 の後に1件入れたので、やり直すときは次の世代を基準にする）'
            }
            $pitrRound += 1
            Write-Host ('   その drill のブランチ（' + $branchName + '）は使わない。PlanetScale で消してから、同じ戻す時刻で、次の新しい名前のブランチを作り直す')
            $branchName = $baseBranch + '-' + $pitrRound
            $result.drill_branch = $branchName
            Show-DrillPitrGuide
            Wait-DrillEnterOnly '前の drill のブランチを消し、作り直しを始めたら Enter'
            $pitrStarted = Get-DrillNow
            $result.times_utc.pitr_started = Format-DrillUtc $pitrStarted
            Assert-DrillWithinHours $pitrStarted 'PITR を作り直したとき' $afterPitrNext
        }
        $result.pitr_rounds = $pitrRound
        Write-Host ''
        Write-Host '   drill のブランチの準備が終わるのを待つ。ブランチにロールが要るときは、次のどちらかで作る:'
        Write-Host ('   ・drill のブランチ（' + $branchName + '）を選んで Connect → Create a role で「Default role」を作る')
        Write-Host '   ・Default のロールを作れないときは、Settings → Roles で drill のブランチのロールを作る（User-defined なら pg_read_all_data を付ける）'
        Write-Host '   出た Host・Username・Password は、このあと聞かれたら貼る。パスワード管理・チャット・ファイルには写さない（ブランチごと消す）'
        Wait-DrillEnterOnly 'drill のブランチにつながるようになったら（ロールの値が出たら）Enter'
        $connectable = Get-DrillNow
        $result.times_utc.connectable = Format-DrillUtc $connectable
        $result.durations_ms.pitr_to_connectable = Get-DrillElapsedMs $pitrStarted $connectable

        # 5. 接続値（03 の共通準備と同じ。Host・Username は Read-Host、Password は -AsSecureString。値は画面に戻さず、
        # 環境変数の名前だけを docker へ渡す）。形が違えば、その項目だけを3回まで尋ね直す（最初からやり直さない）。
        # 窓に前の値が残っていても使わない（03 の共通準備を手で流した窓など。古いパスワードでつながず、必ず尋ねる）
        foreach ($staleName in @('PGHOST', 'PGUSER', 'PGPASSWORD')) { [Environment]::SetEnvironmentVariable($staleName, $null, 'Process') }
        $env:PGHOST = Read-DrillValue '復旧した drill の Host（….psdb.cloud の形の名前だけ）' '[/\s@:]' 'Host の形が違う（https:// や :5432 を付けず、名前だけを貼る）'
        $env:PGUSER = Read-DrillValue '復旧した drill の Username（接続の画面の Username の欄の値。ロールの名前ではない）' '\s' 'Username が空か、空白を含む'
        # -AsSecureString は管で渡した入力を読めずに止まったままになるので、管のときは尋ねずに止める
        if ([Console]::IsInputRedirected) { Stop-Drill 'パスワードは画面で入力する（入力を管で渡さない）' 'PowerShell の画面で、同じ1行を流し直す' }
        $typedPassword = $null
        for ($attempt = 1; $attempt -le 3 -and [string]::IsNullOrEmpty($typedPassword); $attempt++) { $typedPassword = Read-DrillSecret 'Password' }
        if ([string]::IsNullOrEmpty($typedPassword)) { Stop-Drill 'Password を受け取れなかった' 'drill のブランチのロールの Password を確かめ、Claude に伝える（値は渡さない。drill のブランチはこのあと消す）' }
        $env:PGPASSWORD = $typedPassword
        $typedPassword = $null
        $env:PGPORT = '5432'
        $env:PGDATABASE = 'postgres'
        $env:PGSSLMODE = 'verify-full'
        $dockerEnv = @('-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGDATABASE', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGSSLMODE', '-e', 'PGSSLROOTCERT=system')
    }

    # 照合: psql（-1 を付けない・ON_ERROR_STOP=1）で件数と金額だけを JSON で読み、manifest と比べる
    Write-Host '照合: 手元の Docker の psql で、表ごとの件数と金額の合計だけを読む'
    $pitrJson = Join-Path $workDir 'pitr.json'
    $psqlArgs = @('run', '--rm') + $dockerEnv + @('-e', 'PGCLIENTENCODING=UTF8', '-e', 'PGCONNECT_TIMEOUT=20', '-e', 'PGAPPNAME=on-drill-pitr',
        '--mount', ('type=bind,source=' + $workDir + ',target=/drill'), $drillImage,
        'psql', '-X', '-w', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '/drill/reconcile-json.sql', '-o', '/drill/pitr.json')
    # docker run が 125〜127 で終わったとき（像の取得の失敗・bind mount の誤り・Docker の不調）は Docker の失敗で、psql の終了コードではない。
    # PlanetScale に向けるときは、同じ1行を流し直すと戻す時刻が1件の後になるので、作った drill のブランチのまま Docker を直して照合をやり直す
    $dockerRound = 0
    while ($true) {
        $dockerRound += 1
        $psql = Invoke-DrillNative $dockerPath $psqlArgs
        if ($psql.Code -lt 125 -or $psql.Code -gt 127) { break }
        $dockerTrouble = '手元の Docker で psql を始められなかった（docker の終了コード ' + $psql.Code + '。像の取得か Docker の不調）'
        if ($LocalTarget) { Stop-Drill $dockerTrouble 'Docker Desktop を起動し直してから、同じ1行を流し直す' }
        if ($dockerRound -ge 3) { Stop-Drill ($dockerTrouble + '（3回）') 'このあと drill のブランチを消す。この出力を Claude に渡す（接続値は渡さない）' }
        Write-Host ('   ' + $dockerTrouble)
        Wait-DrillEnterOnly 'Docker Desktop を起動し直し、起動が終わったら Enter（同じ drill のブランチで照合をやり直す）'
        while (-not (Test-DrillDocker $dockerPath 20000)) { Wait-DrillEnterOnly 'Docker がまだ応えない。Docker Desktop の起動が終わってから Enter' }
    }
    if ($psql.Code -eq 2) {
        if ($LocalTarget) { Stop-Drill '手元の DB に接続できない（Docker の公開ポートの不調かもしれない）' 'Docker Desktop を終了して起動し直してから、同じ1行を流し直す' }
        Stop-Drill 'drill のブランチに接続できない（Host・Username・Password・ロール・ブランチの準備のどれか）' '画面で drill のブランチの準備とロールを確かめ、Claude に伝える（接続値は渡さない）。drill のブランチはこのあと消す'
    }
    if ($psql.Code -ne 0 -or -not (Test-Path -LiteralPath $pitrJson) -or (Get-Item -LiteralPath $pitrJson).Length -eq 0) {
        Stop-Drill ('照合の読み取りが失敗した（psql の終了コード ' + $psql.Code + '）') 'ロールに読み取りの権限があるかを確かめ、Claude に伝える（接続値は渡さない）'
    }
    $reconcile = Invoke-DrillNative $nodePath @('--disable-warning=ExperimentalWarning', $reconcileScript, '--left', $baselinePath, '--right', $pitrJson)
    $reconciled = Get-DrillNow
    $result.times_utc.reconcile_finished = Format-DrillUtc $reconciled
    if ($pitrStarted) {
        $result.durations_ms.connectable_to_reconciled = Get-DrillElapsedMs $connectable $reconciled
        $result.durations_ms.pitr_to_reconciled = Get-DrillElapsedMs $pitrStarted $reconciled
    }
    $reconcileText = (@($reconcile.Out) -join '')
    $verdict = [regex]::Match($reconcileText, '"equal":(true|false)')
    if ($reconcile.Code -eq 2 -or -not $verdict.Success) { Stop-Drill '照合の入力を読めなかった' 'この出力を Claude に渡す' }
    $result.reconcile_equal = ($reconcile.Code -eq 0 -and $verdict.Groups[1].Value -eq 'true')
    # 違いの数は、表ごとの違いの項目（件数・金額の合計など）の数。1つの表で件数と金額が違えば2と数える
    $result.differences = ([regex]::Matches($reconcileText, '"reason":')).Count
    if (-not $result.reconcile_equal) {
        $names = @([regex]::Matches($reconcileText, '"table":"([a-z0-9_]+)","reason":"([a-z_]+)"') | Select-Object -First 10 | ForEach-Object { $_.Groups[1].Value + '（' + $_.Groups[2].Value + '）' })
        Stop-Drill ('照合が不一致（違い ' + $result.differences + ' 件: ' + ($names -join '・') + '）') '戻した DB は使わない。この出力を Claude に渡す（戻す時刻と、G1 の後に staging を使っていないかを確かめる）'
    }
    Write-DrillOk ('照合: 一致（表 ' + $result.tables + ' の件数と金額の合計が G1 の manifest と同じ）')
    if (-not $LocalTarget) { Write-DrillOk 'G1 の後に staging へ入れた1件は drill に無い（表の件数が G1 と同じ）' }
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
    # 接続の環境変数を消す（-LocalTarget では、呼んだ側が先に入れた値に戻す。CLOUDFLARE_ACCOUNT_ID は元に戻す）
    foreach ($pgName in $pgNames) {
        if ($LocalTarget -or -not $pgName.StartsWith('PG')) { [Environment]::SetEnvironmentVariable($pgName, $savedEnv[$pgName], 'Process') }
        else { [Environment]::SetEnvironmentVariable($pgName, $null, 'Process') }
    }
    Save-DrillResult
    # PITR を始めていれば、途中で止まった（Ctrl+C を含む）ときも drill のブランチの名前と消し方を出す（費用がかかり続けるので）。尋ねるのは後
    if ($pitrStarted) {
        Write-Host ''
        Write-Host ('drill のブランチ ' + $result.drill_branch + ' を PlanetScale で消す（名前に drill があることを確かめる。元の ' + $sourceName + ' は消さない）')
        Write-Host ('   pscale で消すとき（別の PowerShell の窓で）: pscale branch delete ' + $databaseName + ' ' + $result.drill_branch)
        if ($pitrRound -gt 1) { Write-Host '   作り直す前の drill のブランチ（名前の終わりの番号が小さいもの・番号の無いもの）も残っていないかを画面で確かめる' }
    }
}

# 6. drill のブランチを消した時刻（PITR を始めたときだけ。止まったときも尋ねる）。Enter だけを待つ（pscale の行をこの窓に貼っても流れない）
if ($pitrStarted) {
    $deleted = Read-DrillEnterOnly 'drill のブランチを消したら Enter'
    if ($null -ne $deleted) {
        $deletedAt = Get-DrillNow
        $result.times_utc.branch_deleted = Format-DrillUtc $deletedAt
        $result.durations_ms.branch_lifetime = Get-DrillElapsedMs $pitrStarted $deletedAt
        Save-DrillResult
    }
    else { Write-Host '消した時刻を記録できなかった。消した時刻を記録に書く' }
}

if ($succeeded) {
    Write-Host ''
    Write-Host '== 練習 E の結果 =='
    Write-Host ('基準: ' + $result.manifest_key + '（manifest の SHA-256: ' + $result.manifest_sha256 + '・snapshot ' + $result.snapshot_at_utc + '）')
    if ($pitrStarted) {
        Write-Host ('戻す時刻: ' + $result.restore_point_utc + '・drill のブランチ: ' + $result.drill_branch)
        if ($pitrRound -gt 1) { Write-Host ('PITR は ' + $pitrRound + ' 回目に作ったブランチで測った（復旧の時刻が合わずに作り直した）') }
        Write-Host ('PITR の開始 → 接続可能: ' + (Format-DrillSeconds $result.durations_ms.pitr_to_connectable) + '・接続可能 → 照合の終わり: ' + (Format-DrillSeconds $result.durations_ms.connectable_to_reconciled) +
            '・PITR の開始 → 照合の終わり: ' + (Format-DrillSeconds $result.durations_ms.pitr_to_reconciled))
        if ($result.times_utc.branch_deleted) { Write-Host ('drill のブランチを消した: ' + $result.times_utc.branch_deleted + '（PITR の開始から ' + (Format-DrillSeconds $result.durations_ms.branch_lifetime) + '）') }
        Write-Host '費用: PlanetScale の請求の画面で、drill のブランチの分を後日確かめて記録に書く'
    }
    Write-Host ('照合: 一致（表 ' + $result.tables + '）')
    Write-Host ('結果の JSON: ' + (Join-Path $workDir 'pg-E-result.json'))
    if (-not $LocalTarget) {
        # 片付け: 練習 F の作業フォルダ（-ManifestFile のある pg-F-<時刻>）とこの作業フォルダ。ondrill の直下の練習の作業フォルダだけを消す
        $removeAnswer = Read-DrillAnswer '練習 F と E の作業フォルダを消しますか（消すなら yes と打つ。Enter で残す）'
        if ($removeAnswer -eq 'yes') {
            $fHit = [regex]::Match($baselinePath, '^(.+\\pg-F-\d{8}-\d{6})\\pg-daily\\[A-Za-z0-9.-]+\\manifest\.json$')
            if ($fHit.Success) { [void](Remove-DrillWorkDir $rootDir $fHit.Groups[1].Value 'pg-F-result.json') }
            [void](Remove-DrillWorkDir $rootDir $workDir 'pg-E-result.json')
        }
        else { Write-Host '作業フォルダを残した' }
    }
    Write-Host '判定: OK'
    Write-Host '次の一手: この出力（または pg-E-result.json）を Claude に渡す'
}
exit $exitWith
