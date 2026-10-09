# ps1-rules: strict
# Windows PowerShell 5.1。PG 計画 段2の実測（会社ルートの plans/2026-10-08-pg-stage2-measure.md の香盤表 S5・S6・S7）。
# 代表が1行で流す:
#   powershell -ExecutionPolicy Bypass -File <このファイルの絶対パス> -Url https://staging.example.invalid
# 流れ: 読み取りだけの事前の確認（measure-staging.mjs --check-only）→ 続けるかを尋ねる → 接続の見本取りを始める
#       → 計測（既定の6回）→ 見本取りを止めて集計 → 結果のフォルダと数値の要約を出す
# ・-Url は必須で既定値なし。https のときだけ、人が STAGING と打つ確認（-NonInteractive では Read-Host が使えず必ずここで止まる）のあと、
#   cloudflared access token -app=<Url> の終了コードと空文字を確かめる。トークンは表示せず、子の node にだけ環境変数 ON_ACCESS_TOKEN で渡し、
#   node が終わるたびに消す
# ・http://127.0.0.1:<port> と http://localhost:<port> は手元のアプリ（Claude の通しと試験用）。STAGING の確認も cloudflared も使わない
# ・結果は $env:USERPROFILE\ondrill\measure-<時刻>\（リポジトリの外）。node が UTF-8 で measure.json・measure.md（と check-only.*）を書き、
#   見本取りは pg-samples.csv（1秒ごとの見本）と pg-sampler.json（数値だけの集計）を書く
# ・見本取り: 手元の Docker の psql（postgres:18.6-alpine）を名前つきのコンテナで後ろで動かし、pg-sampler/sample.sql を \watch で1秒ごとに流す。
#   始める前に1回だけ pg-sampler/precheck.sql で、アプリのロールが1つに決まるかと pg_read_all_stats を使えるかを確かめ、外れたら見本取りを止める。
#   接続値は Read-Host -AsSecureString で受け（13 の手順と同じ）、環境変数の名前だけを docker へ渡す。すでに PGHOST があれば尋ねない（手元の試験用。
#   代表の手順では設定しない）。止める合図は docker kill --signal=INT。finally で、記録した名前のコンテナだけを消す。クエリ文・ロール名・接続値は出さない
# ・-SkipSampler で見本取りを省く。-CheckOnly で読み取りだけで終える。-Plan で回の計画を node の --plan へ渡す（予備の月を足すとき）
# ・-SamplerOnly は見本取りだけを -SamplerSeconds 秒流して集計する（Claude の試験用。計測はしない）
# 終了コード: 0 終わった（yes と打たずに計測を始めなかったときを含む）・1 測り始めたあとで止まった（node の終了コード 1。回の失敗・回のあいだの
#   トークンの残り）と、思わぬ誤り・2 測り始める前に止めた（STAGING の確認・入力・Docker・在籍・トークンの残り。-NonInteractive で
#   Read-Host が使えず尋ねられないときも、確認が取れないものとしてここ）・3 見本取りの前の確かめが外れた（-SamplerOnly）
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Url,
    [switch]$CheckOnly,
    [switch]$SkipSampler,
    [ValidatePattern('^$|^[ab]:\d{4}-\d{2}(,[ab]:\d{4}-\d{2})*$')][string]$Plan = '',
    [ValidateSet('verify-full','disable')][string]$SslMode = 'verify-full',
    [ValidateRange(60,86400)][int]$SampleLimit = 14400,
    [ValidatePattern('^[a-z0-9][a-z0-9_.-]{0,62}$')][string]$ContainerName = 'on-measure-pg-sampler',
    [switch]$SamplerOnly,
    [ValidateRange(1,3600)][int]$SamplerSeconds = 10,
    [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
$image = 'postgres:18.6-alpine'
$tokenName = 'ON_ACCESS_TOKEN'
$nodeScript = Join-Path $PSScriptRoot 'measure-staging.mjs'
$sqlDir = Join-Path $PSScriptRoot 'pg-sampler'
$pgNames = @('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE')
$savedPg = @{}
foreach ($name in $pgNames) { $savedPg[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
$accessToken = $null
$resultDir = $null
$createdDir = $false
$dockerPath = $null
$samplerRunning = $false
$samplerNote = $null
$exitWith = 0

# 止める（終了コードつき）。外側の catch が文だけを出す
function Stop-Measure([string]$Message, [int]$Code) {
    $failure = New-Object System.Exception $Message
    $failure.Data['exitCode'] = $Code
    throw $failure
}

# 人に尋ねる。-NonInteractive では Read-Host が例外になるので、確認が取れないものとして止める（終了コード 2）
function Read-Answer([string]$Prompt) {
    try { return (Read-Host $Prompt) }
    catch { Stop-Measure '確認を尋ねられないので止めました（-NonInteractive では流せません）' 2 }
}

function Read-TemporarySecret([string]$Prompt) {
    try { $secure = Read-Host $Prompt -AsSecureString }
    catch { Stop-Measure '接続値を尋ねられないので止めました（-NonInteractive では流せません）' 2 }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
}

# 外部コマンドを呼ぶ（pg-staging.ps1:46-51 の形）。PS 5.1 は外部コマンドの stderr を ErrorRecord にするので（終了コード0でも）、
# Continue のあいだだけ呼び、終了コードで成否を決める。返すのは stdout の文字列の行だけ（stderr は接続値を含みうるので捨てる）
function Invoke-Native([string]$FilePath, [string[]]$ArgumentList) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $FilePath @ArgumentList 2>&1
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previous }
    return [pscustomobject]@{ Code = $code; Lines = @($output | Where-Object { $_ -is [string] }) }
}

# Docker が応えるかを時間を区切って確かめる（docker info・docker version が止まったままになる不調の前例がある）
function Test-DockerReady([string]$DockerFile, [int]$TimeoutMs) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $DockerFile
    $info.Arguments = 'version --format {{.Server.Version}}'
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($info)
    $stdout = $proc.StandardOutput.ReadToEndAsync()
    [void]$proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutMs)) {
        try { $proc.Kill() } catch { Write-Verbose 'docker の確かめを止められませんでした' }
        return $false
    }
    return ($proc.ExitCode -eq 0 -and $stdout.Result.Trim().Length -gt 0)
}

# 記録した名前のコンテナの状態（無ければ空文字）
function Get-ContainerStatus([string]$Name) {
    $found = Invoke-Native $dockerPath @('ps','-a','--filter',('name=^/' + $Name + '$'),'--format','{{.Status}}')
    if ($found.Code -ne 0) { return '' }
    return ((@($found.Lines) -join '').Trim())
}

# docker run に渡す共通の指定。接続値は環境変数の名前だけを渡す（値をコマンドの行に書かない）
function Get-PsqlRunArgs {
    $list = @('--mount',('type=bind,source=' + $sqlDir + ',target=/sql,readonly'),'-e','PGHOST','-e','PGPORT','-e','PGUSER','-e','PGPASSWORD','-e','PGDATABASE',
        '-e',('PGSSLMODE=' + $SslMode),'-e','PGCLIENTENCODING=UTF8','-e','PGAPPNAME=on-measure-sampler')
    if ($SslMode -eq 'verify-full') { $list += @('-e','PGSSLROOTCERT=system') }
    return $list
}
$psqlCommand = @('psql','-X','-w','-q','-A','-t','-F',',','-v','ON_ERROR_STOP=1')

# 見本取りを始める。始められなければ理由（クエリ文・ロール名・接続値を含まない文）を返し、始めたら空文字
function Start-Sampler {
    $docker = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $docker) { return 'Docker が見つからない' }
    $script:dockerPath = $docker.Source
    if (-not (Test-DockerReady $dockerPath 20000)) { return 'Docker が20秒のうちに応えない（Docker Desktop を確かめる）' }
    if ([string]::IsNullOrEmpty($env:PGHOST)) {
        $env:PGHOST = Read-TemporarySecret 'PlanetScale の staging の host（URL ではない）'
        $env:PGUSER = Read-TemporarySecret 'Username（接続の画面の Username の欄の値。ロールの名前ではない）'
        $env:PGPASSWORD = Read-TemporarySecret 'パスワード'
    }
    if ([string]::IsNullOrEmpty($env:PGPORT)) { $env:PGPORT = '5432' }
    if ([string]::IsNullOrEmpty($env:PGDATABASE)) { $env:PGDATABASE = 'postgres' }
    if ([string]::IsNullOrWhiteSpace($env:PGHOST) -or $env:PGHOST -match '[/\s@]' -or [string]::IsNullOrWhiteSpace($env:PGUSER) -or [string]::IsNullOrEmpty($env:PGPASSWORD) -or $env:PGPORT -notmatch '^\d{1,5}$') {
        return '接続の入力が足りない・形が違う'
    }
    # 始める前に1回だけ: アプリのロールが1つに決まるか・pg_read_all_stats を使えるか（数と真偽だけを受け取る）
    $check = Invoke-Native $dockerPath (@('run','--rm') + (Get-PsqlRunArgs) + @($image) + $psqlCommand + @('-f','/sql/precheck.sql'))
    if ($check.Code -ne 0) { return 'psql で確かめられない（接続できない・権限がない。接続値は出さない。手元で確かめる）' }
    $answer = @($check.Lines | Where-Object { $_.Trim() }) | Select-Object -Last 1
    $parts = ([string]$answer).Trim().Split(',')
    if ($parts.Count -ne 2 -or $parts[0] -notmatch '^\d+$') { return '確かめの応答を読めない' }
    if ([int]$parts[0] -ne 1) { return ('アプリのロールが1つに決まらない（該当 ' + $parts[0] + '）') }
    if ($parts[1] -ne 't') { return 'このロールでは pg_read_all_stats を使えない（ほかのロールの接続の状態が見えない）' }
    # 同じ名前の残り（前に止まった回のもの）を先に片づけてから、後ろで動かす
    if (Get-ContainerStatus $ContainerName) { [void](Invoke-Native $dockerPath @('rm','-f',$ContainerName)) }
    $started = Invoke-Native $dockerPath (@('run','-d','--name',$ContainerName,'--mount',('type=bind,source=' + $resultDir + ',target=/out')) + (Get-PsqlRunArgs) + @($image) + $psqlCommand + @('-v',('limit=' + $SampleLimit),'-o','/out/pg-samples.csv','-f','/sql/sample.sql'))
    if ($started.Code -ne 0) { return '見本取りのコンテナを始められない' }
    $script:samplerRunning = $true
    $csv = Join-Path $resultDir 'pg-samples.csv'
    for ($wait = 0; $wait -lt 60; $wait++) {
        if ((Test-Path -LiteralPath $csv) -and (Get-Item -LiteralPath $csv).Length -gt 0) { return '' }
        if ((Get-ContainerStatus $ContainerName) -like 'Exited*') { break }
        Start-Sleep -Milliseconds 500
    }
    Stop-Sampler | Out-Null
    return '見本取りが最初の1行を書かない（接続値は出さない。手元で確かめる）'
}

# 止める合図（SIGINT）を送り、止まるのを待って集計し、記録した名前のコンテナを消す。集計（数値だけ）を返す
function Stop-Sampler {
    if (-not $samplerRunning) { return $null }
    $summary = $null
    try {
        [void](Invoke-Native $dockerPath @('kill','--signal=INT',$ContainerName))
        for ($wait = 0; $wait -lt 30; $wait++) {
            $status = Get-ContainerStatus $ContainerName
            if (-not $status -or $status -like 'Exited*') { break }
            Start-Sleep -Milliseconds 500
        }
        $summary = Get-SamplerSummary (Join-Path $resultDir 'pg-samples.csv')
        $json = $summary | ConvertTo-Json
        [IO.File]::WriteAllText((Join-Path $resultDir 'pg-sampler.json'), $json, (New-Object System.Text.UTF8Encoding $false))
    }
    finally {
        [void](Invoke-Native $dockerPath @('rm','-f',$ContainerName))
        $script:samplerRunning = $false
    }
    return $summary
}

# 見本の CSV（時刻,アプリのロールの接続数,active の最長の経過 ms,全体の接続数,max_connections）を数値だけに集計する
function Get-SamplerSummary([string]$CsvPath) {
    $samples = 0; $maxApp = [int64]0; $maxActive = [int64]0; $maxTotal = [int64]0; $maxConnections = [int64]0; $first = $null; $last = $null
    if (Test-Path -LiteralPath $CsvPath) {
        foreach ($line in [IO.File]::ReadAllLines($CsvPath)) {
            $cells = $line.Split(',')
            if ($cells.Count -ne 5 -or $cells[1] -notmatch '^\d+$' -or $cells[2] -notmatch '^\d+$' -or $cells[3] -notmatch '^\d+$' -or $cells[4] -notmatch '^\d+$') { continue }
            $samples++
            if (-not $first) { $first = $cells[0] }
            $last = $cells[0]
            $maxApp = [Math]::Max($maxApp, [int64]$cells[1])
            $maxActive = [Math]::Max($maxActive, [int64]$cells[2])
            $maxTotal = [Math]::Max($maxTotal, [int64]$cells[3])
            $maxConnections = [Math]::Max($maxConnections, [int64]$cells[4])
        }
    }
    return [pscustomobject]@{ samples = $samples; firstUtc = $first; lastUtc = $last; maxAppConnections = $maxApp; maxActiveMs = $maxActive; maxTotalConnections = $maxTotal; maxConnections = $maxConnections }
}

function Write-SamplerSummary($Summary) {
    if (-not $Summary) { return }
    $values = @($Summary.samples, $Summary.maxAppConnections, $Summary.maxActiveMs, $Summary.maxTotalConnections, $Summary.maxConnections, $Summary.firstUtc, $Summary.lastUtc)
    Write-Host ('見本取り: 見本 {0}・アプリのロールの接続の最大 {1}・その active の最長の経過の最大 {2} ms・全体の接続の最大 {3}・max_connections {4}（UTC {5}〜{6}）' -f $values)
}

try {
    $target = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$target)) { Stop-Measure '-Url は https://… か http://127.0.0.1:<port> の形で渡してください' 2 }
    $isHttps = $target.Scheme -eq 'https'
    $isLocal = ($target.Scheme -eq 'http') -and (@('127.0.0.1','localhost','[::1]') -contains $target.Host)
    if (-not ($isHttps -or $isLocal) -or $target.AbsolutePath -ne '/' -or $target.Query -or $target.Fragment -or $target.UserInfo) {
        Stop-Measure '-Url は origin だけにしてください（https://… か、手元の http://127.0.0.1:<port>）' 2
    }
    $origin = $target.GetLeftPart([UriPartial]::Authority)
    if ($isHttps) {
        # 同じ PC・同じ利用者なので、仕組みで閉じきれない分を人の確認で閉じる（pg-staging.ps1 と同じ形）
        if ((Read-Answer '向き先は STAGING ですか（STAGING と打つ）') -cne 'STAGING') { Stop-Measure '確認が取れないので止めました' 2 }
    }
    if (-not $SamplerOnly) {
        if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) { Stop-Measure 'node が見つかりません' 2 }
    }
    if ($isHttps -and -not $SamplerOnly) {
        $cloudflared = Get-Command cloudflared -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $cloudflared) { Stop-Measure ('cloudflared が見つかりません。入れてから cloudflared access login ' + $origin + ' を流してください') 2 }
        $tokenRun = Invoke-Native $cloudflared.Source @('access','token',('-app=' + $origin))
        $tokenCode = $tokenRun.Code
        $accessToken = [string](@($tokenRun.Lines | Where-Object { $_.Trim() }) | Select-Object -Last 1)
        $tokenRun = $null
        if ($tokenCode -ne 0 -or [string]::IsNullOrWhiteSpace($accessToken)) {
            Stop-Measure ('cloudflared access token が失敗しました（値は出さない）。cloudflared access login ' + $origin + ' を先に流してください') 2
        }
        $accessToken = $accessToken.Trim()
        if ($accessToken -notmatch '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$') { Stop-Measure 'cloudflared の応答がトークンの形ではありません（値は出さない）' 2 }
    }
    if ($OutDir) { $resultDir = [IO.Path]::GetFullPath($OutDir) }
    else { $resultDir = Join-Path $env:USERPROFILE ('ondrill\measure-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
    if (-not (Test-Path -LiteralPath $resultDir)) { [void][IO.Directory]::CreateDirectory($resultDir); $createdDir = $true }
    Write-Host ('結果のフォルダ: ' + $resultDir)

    if ($SamplerOnly) {
        $reason = Start-Sampler
        if ($reason) { Write-Host ('見本取りを止めます: ' + $reason); $exitWith = 3 }
        else {
            Write-Host ('見本取りを ' + $SamplerSeconds + ' 秒流します')
            Start-Sleep -Seconds $SamplerSeconds
            Write-SamplerSummary (Stop-Sampler)
        }
    }
    else {
        $nodeArgs = @('--disable-warning=ExperimentalWarning', $nodeScript, '--url', $origin, '--out-dir', $resultDir)
        if ($Plan) { $nodeArgs += @('--plan', $Plan) }
        # 読み取りだけの事前の確認（組織・取引先・各月の重なり・同じ原本・届くはずの報告）
        if ($accessToken) { [Environment]::SetEnvironmentVariable($tokenName, $accessToken, 'Process') }
        try {
            $ErrorActionPreference = 'Continue'
            & node @($nodeArgs + @('--check-only'))
            $checkExit = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = 'Stop'
            [Environment]::SetEnvironmentVariable($tokenName, $null, 'Process')
        }
        if ($checkExit -ne 0) { Stop-Measure '読み取りだけの確認で止まりました（上の文を見てください）' 2 }
        # Access のトークンの残りが2時間を切っていたら、接続値を尋ねて見本取りを始める前に止める（node が check-only.json に enough を残す）
        $checkReport = Get-Content -LiteralPath (Join-Path $resultDir 'check-only.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $CheckOnly -and $checkReport.token -and -not $checkReport.token.enough) {
            Stop-Measure ('Access のトークンの残りが2時間を切っています。cloudflared access login ' + $origin + ' からやり直し、同じコマンドで流してください') 2
        }
        if (-not $CheckOnly) {
            if ((Read-Answer '表を確かめて、計測を始めますか（yes と打つと始める）') -cne 'yes') { Stop-Measure '計測を始めずに終えました' 0 }
            if ($SkipSampler) { $samplerNote = '-SkipSampler で省いた' }
            else {
                $reason = Start-Sampler
                if ($reason) {
                    $samplerNote = $reason
                    Write-Host ('見本取りを止めます: ' + $reason)
                    if ((Read-Answer '見本取りなしで計測を続けますか（yes と打つと続ける）') -cne 'yes') { Stop-Measure '計測を始めずに終えました' 2 }
                }
                else { Write-Host '見本取りを始めました（1秒ごと）' }
            }
            if ($accessToken) { [Environment]::SetEnvironmentVariable($tokenName, $accessToken, 'Process') }
            try {
                $ErrorActionPreference = 'Continue'
                & node @nodeArgs
                $measureExit = $LASTEXITCODE
            }
            finally {
                $ErrorActionPreference = 'Stop'
                [Environment]::SetEnvironmentVariable($tokenName, $null, 'Process')
            }
            Start-Sleep -Seconds 2
            Write-SamplerSummary (Stop-Sampler)
            if ($samplerNote) { Write-Host ('見本取り: なし（' + $samplerNote + '）') }
            if ($measureExit -ne 0) {
                $exitWith = $measureExit
                Write-Host '計測は止まりました（上の案内を見てください）。同じコマンドで再開できます（登録済みの月は飛ばします）'
            }
        }
    }
}
catch {
    $code = $_.Exception.Data['exitCode']
    if ($null -eq $code) { $code = 1 }
    $exitWith = [int]$code
    Write-Host $_.Exception.Message
}
finally {
    if ($samplerRunning) {
        try { Write-SamplerSummary (Stop-Sampler) } catch { Write-Host '見本取りの片づけで失敗しました。docker ps -a で on-measure の名前のコンテナを確かめてください' }
    }
    [Environment]::SetEnvironmentVariable($tokenName, $null, 'Process')
    $accessToken = $null
    foreach ($name in $pgNames) { [Environment]::SetEnvironmentVariable($name, $savedPg[$name], 'Process') }
    if ($createdDir -and (Test-Path -LiteralPath $resultDir) -and -not (Get-ChildItem -LiteralPath $resultDir -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $resultDir
    }
    elseif ($resultDir -and (Test-Path -LiteralPath $resultDir)) { Write-Host ('結果: ' + $resultDir) }
}
exit $exitWith
