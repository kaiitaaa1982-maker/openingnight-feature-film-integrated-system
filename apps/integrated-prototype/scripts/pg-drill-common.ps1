# ps1-rules: strict
# Windows PowerShell 5.1。PG 計画 段2の実測 S9・S10 の2本（pg-drill-restore.ps1＝練習 F・pg-drill-pitr.ps1＝練習 E）が
# 「. (Join-Path $PSScriptRoot 'pg-drill-common.ps1')」で読む共通の部品。単独では流さない（関数と定数を定めるだけ）。
# 手順の正本は core の docs/platform/operations/runbooks/03-restore-drill.md の「PostgreSQL の準備」「練習 E」「練習 F」。
# ・外部コマンドは pg-staging.ps1:46-51 の形で包み、終了コードで成否を決める（Invoke-DrillNative）
# ・Docker は時間を区切って確かめる（docker info・docker version が止まったままになる不調の前例。Test-DrillDocker）
# ・SHA-256 は .NET で計算する（pwsh 7 から呼ばれて PSModulePath が混ざると Get-FileHash が消える前例）
# ・JSON は JavaScriptSerializer で読む（ConvertFrom-Json は 5.1 で約2MB を超える文字列を断る）。書くのは UTF-8（BOM なし）
# ・関数の引数の名前へは、このファイルのどこでも代入しない（PowerShell の変数は大文字と小文字を区別しない。ps1-rules の検査）

$drillImage = 'postgres:18.6-alpine'
$drillBucket = 'openingnight-integrated-demo-staging-pg-exports'
$drillFormat = 'openingnight-pg-ndjson-v1'
# 03 の練習 F の手順1と同じ形（src/data-platform/pg-restore-store.mjs の restorePgDatabase も同じ形だけを受け付ける）
$drillKeyPattern = '^pg-daily/[a-zA-Z0-9.-]+/manifest\.json$'
$drillUtf8 = New-Object System.Text.UTF8Encoding($false)
$drillInvariant = [Globalization.CultureInfo]::InvariantCulture

# 止める。呼んだ側の catch が Write-DrillStop で「NG」「次の一手」「判定: NG」を出す
function Stop-Drill([string]$Reason, [string]$NextStep) {
    $failure = New-Object System.Exception $Reason
    $failure.Data['drillNext'] = $NextStep
    throw $failure
}

# catch で受けた例外を出す。Stop-Drill 以外（思わぬ失敗）は、例外の文を出さない（パス・接続値を含みうる）。
# どこで止まったかを Claude が追えるように、値を含まない情報（いちばん内側の例外の型・ps1 の名前・行番号）だけを足す
function Write-DrillStop($Caught) {
    $drillNext = $null
    if ($Caught -and $Caught.Exception -and $Caught.Exception.Data.Contains('drillNext')) { $drillNext = [string]$Caught.Exception.Data['drillNext'] }
    if ($null -ne $drillNext) {
        Write-Host ('NG  ' + $Caught.Exception.Message)
        Write-Host ('次の一手: ' + $drillNext)
    }
    else {
        $failureKind = '型は不明'
        if ($Caught -and $Caught.Exception) { $failureKind = $Caught.Exception.GetBaseException().GetType().FullName }
        $failurePlace = ''
        if ($Caught -and $Caught.InvocationInfo -and $Caught.InvocationInfo.ScriptName) {
            $failurePlace = '・' + (Split-Path -Leaf $Caught.InvocationInfo.ScriptName) + ' の ' + $Caught.InvocationInfo.ScriptLineNumber + ' 行目'
        }
        Write-Host ('NG  予期しない失敗で止まった（' + $failureKind + $failurePlace + '）')
        Write-Host '次の一手: この画面の出力を Claude に渡す（接続値・パスワードは出していない。出したのは失敗の型と場所だけ）'
    }
    Write-Host '判定: NG'
}

function Write-DrillOk([string]$Message) { Write-Host ('OK  ' + $Message) }

# 人に尋ねる。-NonInteractive で Read-Host が使えないとき・入力が尽きたときは $null を返す（呼んだ側が既定か止めるかを決める）
function Read-DrillAnswer([string]$Prompt) {
    try { return (Read-Host $Prompt) }
    catch { return $null }
}

# パスワードを画面に出さずに受ける。尋ねられないときは $null
function Read-DrillSecret([string]$Prompt) {
    try { $secure = Read-Host $Prompt -AsSecureString }
    catch { return $null }
    if ($null -eq $secure) { return $null }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
}

# 外部コマンドを呼ぶ（pg-staging.ps1:46-51 の形）。PS 5.1 は外部コマンドの stderr を ErrorRecord にする（終了コード 0 でも）ので、
# 呼ぶあいだだけ Continue にし、終了コードで成否を決める。stdout と stderr の行を分けて返す（画面に出すかは呼んだ側が決める）
function Invoke-DrillNative([string]$CommandPath, [string[]]$CommandArgs) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $captured = & $CommandPath @CommandArgs 2>&1
        $nativeExit = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previous }
    $outLines = New-Object System.Collections.Generic.List[string]
    $errLines = New-Object System.Collections.Generic.List[string]
    foreach ($item in @($captured)) {
        if ($item -is [System.Management.Automation.ErrorRecord]) { $errLines.Add([string]$item.Exception.Message) }
        elseif ($null -ne $item) { $outLines.Add([string]$item) }
    }
    return [pscustomobject]@{ Code = $nativeExit; Out = $outLines.ToArray(); Err = $errLines.ToArray() }
}

# Docker が応えるかを時間を区切って確かめる（docker info・docker version が止まったままになる不調の前例がある）
function Test-DrillDocker([string]$DockerFile, [int]$TimeoutMs) {
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
        try { $proc.Kill() } catch { Write-Verbose 'docker の確かめを止められなかった' }
        return $false
    }
    return ($proc.ExitCode -eq 0 -and $stdout.Result.Trim().Length -gt 0)
}

# Docker を見つけて応えるかを確かめ、docker の絶対パスを返す。だめなら止める
function Get-DrillDocker {
    $docker = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $docker) { Stop-Drill 'Docker が見つからない' 'Docker Desktop を起動してから、同じ1行を流し直す' }
    if (-not (Test-DrillDocker $docker.Source 20000)) {
        Stop-Drill 'Docker が20秒のうちに応えない' 'Docker Desktop を終了して起動し直してから、同じ1行を流し直す。続けて応えないなら Claude に伝える'
    }
    return $docker.Source
}

# 記録した名前のコンテナがあれば、その状態（Up …・Exited …）。無ければ空文字
function Get-DrillContainerStatus([string]$DockerFile, [string]$NameOfContainer) {
    $found = Invoke-DrillNative $DockerFile @('ps', '-a', '--filter', ('name=^/' + $NameOfContainer + '$'), '--format', '{{.Status}}')
    if ($found.Code -ne 0) { return '' }
    return ((@($found.Out) -join '').Trim())
}

# 記録した名前のコンテナだけを、名前を付けたボリュームの無い使い捨てとして消す（-v で無名のボリュームも消す）。消えたかを返す
function Remove-DrillContainer([string]$DockerFile, [string]$NameOfContainer) {
    [void](Invoke-DrillNative $DockerFile @('rm', '-f', '-v', $NameOfContainer))
    return (-not (Get-DrillContainerStatus $DockerFile $NameOfContainer))
}

# 127.0.0.1 で空いているポート（OS に選ばせて閉じる。docker run の直前に呼ぶ）
function Get-DrillFreePort {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port }
    finally { $listener.Stop() }
}

# 公開したポートの先で PostgreSQL が応えるかを、SSLRequest（8バイト）を送って1バイトの答え（N か S）で確かめる。
# TCP がつながるだけでは足りない（公開したポートが数 ms で切れる Docker の不調の前例がある）
function Test-DrillPostgresPort([int]$PortNumber, [int]$WaitMs) {
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $connecting = $tcp.BeginConnect('127.0.0.1', $PortNumber, $null, $null)
        if (-not $connecting.AsyncWaitHandle.WaitOne($WaitMs)) { return $false }
        $tcp.EndConnect($connecting)
        $stream = $tcp.GetStream()
        $stream.ReadTimeout = $WaitMs
        $stream.WriteTimeout = $WaitMs
        [byte[]]$request = 0, 0, 0, 8, 4, 210, 22, 47
        $stream.Write($request, 0, $request.Length)
        $reply = $stream.ReadByte()
        return ($reply -eq 78 -or $reply -eq 83)
    }
    catch { return $false }
    finally { $tcp.Close() }
}

# 試験だけの使い捨てのパスワード（その場で作り、画面・記録に出さない）
function New-DrillPassword {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function Get-DrillSha256([string]$FilePath) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($FilePath)
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}

# JSON のファイルを Dictionary・object[] として読む。読めなければ $null
function Read-DrillJson([string]$JsonPath) {
    try {
        Add-Type -AssemblyName System.Web.Extensions
        $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $serializer.MaxJsonLength = [int]::MaxValue
        $serializer.RecursionLimit = 100
        $text = [IO.File]::ReadAllText($JsonPath, [Text.Encoding]::UTF8)
        return ,$serializer.DeserializeObject($text)
    }
    catch { return $null }
}

# 結果を UTF-8（BOM なし）の JSON で書く（PowerShell の管と Out-File を通さない）
function Write-DrillJson([string]$JsonPath, $JsonValue) {
    [IO.File]::WriteAllText($JsonPath, ($JsonValue | ConvertTo-Json -Depth 8), $drillUtf8)
}

# PostgreSQL の timestamptz の文字（clock_timestamp()::text。TimeZone UTC・DateStyle ISO で「2026-10-09 18:00:01.234567+00」）を読む。読めなければ $null
function ConvertFrom-DrillPgTime([string]$PgText) {
    $hit = [regex]::Match([string]$PgText, '^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,7})?\d*(Z|[+-]\d{2}(?::?\d{2})?)$')
    if (-not $hit.Success) { return $null }
    $zone = $hit.Groups[4].Value
    if ($zone -eq 'Z') { $zone = '+00:00' }
    elseif ($zone.Length -eq 3) { $zone = $zone + ':00' }
    elseif ($zone.Length -eq 5) { $zone = $zone.Substring(0, 3) + ':' + $zone.Substring(3) }
    $iso = $hit.Groups[1].Value + 'T' + $hit.Groups[2].Value + $hit.Groups[3].Value + $zone
    return [DateTimeOffset]::Parse($iso, $drillInvariant)
}

function Get-DrillNow { return [DateTimeOffset]::UtcNow }
function Format-DrillUtc([DateTimeOffset]$At) { return $At.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", $drillInvariant) }
function Format-DrillJst([DateTimeOffset]$At) { return $At.ToOffset([TimeSpan]::FromHours(9)).ToString('yyyy-MM-dd HH:mm:ss', $drillInvariant) + '（日本時間）' }
function Get-DrillElapsedMs([DateTimeOffset]$From, [DateTimeOffset]$To) { return [int64][Math]::Round(($To - $From).TotalMilliseconds) }
function Format-DrillSeconds([int64]$Milliseconds) { return ([double]$Milliseconds / 1000).ToString('0.0', $drillInvariant) + ' 秒' }

# 作業フォルダの根（既定は %USERPROFILE%\ondrill。リポジトリの外）。名前が ondrill でない根は受け付けない（片付けの確かめの前提）
function Resolve-DrillRoot([string]$RootText) {
    if ([string]::IsNullOrWhiteSpace($RootText)) { $resolved = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'ondrill')) }
    else { $resolved = [IO.Path]::GetFullPath($RootText) }
    if ((Split-Path -Leaf $resolved) -ne 'ondrill') { Stop-Drill '作業フォルダの根の名前が ondrill でない' '-WorkRoot を外して流し直す（既定は %USERPROFILE%\ondrill）' }
    return $resolved
}

# 消す前の確かめ（03 の片付けと同じ）: 消す先が ondrill の根の下にある
function Test-DrillUnderRoot([string]$RootDir, [string]$TargetDir) {
    $rootFull = [IO.Path]::GetFullPath($RootDir).TrimEnd('\') + '\'
    $targetFull = [IO.Path]::GetFullPath($TargetDir).TrimEnd('\')
    return ($targetFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase) -and $targetFull.Length -gt $rootFull.Length)
}

# ps1 が作った作業フォルダ（ondrill の根の直下の pg-F-<時刻>・pg-E-<時刻>）だけを消す。結果の JSON（数値だけ）は根へ写してから消す。
# 根の直下でない・名前の形が違うときは消さずに $false。消せなかった（ファイルを開いている・PS 5.1 の再帰の削除の失敗）ときも、
# 練習の結果は変わらないので止めずに、手で消す案内を出して $false（成功のあとに呼ぶ。生のエラーで終了コード 1 にしない）
function Remove-DrillWorkDir([string]$RootDir, [string]$TargetDir, [string]$ResultName) {
    $rootFull = [IO.Path]::GetFullPath($RootDir).TrimEnd('\')
    $targetFull = [IO.Path]::GetFullPath($TargetDir).TrimEnd('\')
    $leaf = Split-Path -Leaf $targetFull
    if (-not (Test-DrillUnderRoot $rootFull $targetFull) -or -not ((Split-Path -Parent $targetFull).Equals($rootFull, [StringComparison]::OrdinalIgnoreCase)) -or
        $leaf -cnotmatch '^pg-[EF]-\d{8}-\d{6}$' -or -not (Test-Path -LiteralPath $targetFull -PathType Container)) {
        Write-Host ('消さない: ' + $targetFull + ' は ' + $rootFull + ' の直下の練習の作業フォルダでない')
        return $false
    }
    $resultFile = Join-Path $targetFull $ResultName
    try {
        if (Test-Path -LiteralPath $resultFile -PathType Leaf) { Copy-Item -LiteralPath $resultFile -Destination (Join-Path $rootFull ($leaf + '-result.json')) -Force -ErrorAction Stop }
        Remove-Item -LiteralPath $targetFull -Recurse -Force -ErrorAction Stop
    }
    catch {
        Write-Host ('作業フォルダを消せなかった（練習の結果は OK）。エクスプローラーなどでこのフォルダを開いていれば閉じて、' + $targetFull + ' を手で消す')
        return $false
    }
    Write-Host ('消した: ' + $targetFull + '（結果の JSON は ' + (Join-Path $rootFull ($leaf + '-result.json')) + ' に残した）')
    return $true
}

# 世代の manifest のキーを整える（前後の空白とバケットの名前の前置きを外す）。形が違えば $null
function ConvertTo-DrillManifestKey([string]$KeyText) {
    $trimmed = ([string]$KeyText).Trim().Trim('"').Trim()
    if ($trimmed.StartsWith($drillBucket + '/')) { $trimmed = $trimmed.Substring($drillBucket.Length + 1) }
    if ($trimmed -cnotmatch $drillKeyPattern) { return $null }
    return $trimmed
}

# キーから作業フォルダの中のファイルのパス（/ を \ に替える）
function Get-DrillLocalPath([string]$BaseDir, [string]$ObjectKey) { return (Join-Path $BaseDir ($ObjectKey -replace '/', '\')) }

# manifest を読み、形（format・tables・blobs）を確かめる。読めない・形が違うときは $null
function Read-DrillManifest([string]$ManifestPath) {
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { return $null }
    $parsed = Read-DrillJson $ManifestPath
    if ($null -eq $parsed -or -not ($parsed -is [System.Collections.IDictionary])) { return $null }
    if ($parsed['format'] -ne $drillFormat -or -not ($parsed['tables'] -is [array]) -or $parsed['tables'].Count -lt 1 -or -not ($parsed['blobs'] -is [array])) { return $null }
    return $parsed
}

# manifest の parts と blobs を、03 の練習 F の手順1と同じ規則（世代の下・.. と \ と : が無い）で確かめて並べる。
# 加えて、コマンドの行に渡すキーは英数字と ._/- だけ、SHA-256 は64桁の16進、大きさは0以上の整数に限る。外れたら止める
function Get-DrillObjects($Manifest, [string]$Generation) {
    $list = New-Object System.Collections.Generic.List[object]
    $entries = New-Object System.Collections.Generic.List[object]
    foreach ($table in @($Manifest['tables'])) {
        foreach ($part in @($table['parts'])) { $entries.Add(@{ kind = 'part'; item = $part }) }
    }
    foreach ($blob in @($Manifest['blobs'])) { $entries.Add(@{ kind = 'blob'; item = $blob }) }
    foreach ($entry in $entries) {
        $item = $entry.item
        $entryKey = [string]$item['key']
        $entryHash = [string]$item['sha256']
        $entryBytes = $item['bytes']
        if (-not $entryKey.StartsWith($Generation + '/') -or $entryKey -match '\.\.|[\\:]' -or $entryKey -cnotmatch '^[A-Za-z0-9._/-]+$' -or
            $entryHash -cnotmatch '^[a-f0-9]{64}$' -or -not ($entryBytes -is [int] -or $entryBytes -is [long]) -or [int64]$entryBytes -lt 0) {
            Stop-Drill 'manifest の parts か blobs に、世代の外を指すキーか形の違う項目がある' 'manifest を手で直さない。この出力を Claude に渡す（世代が壊れているかもしれない。次の世代で取り直すかを決める）'
        }
        $list.Add([pscustomobject]@{ Kind = $entry.kind; Key = $entryKey; Sha256 = $entryHash; Bytes = [int64]$entryBytes })
    }
    return ,$list.ToArray()
}

# 手元のファイルが manifest の大きさと SHA-256 に合うか
function Test-DrillObjectFile([string]$FilePath, $Expected) {
    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { return $false }
    if ((Get-Item -LiteralPath $FilePath).Length -ne $Expected.Bytes) { return $false }
    return ((Get-DrillSha256 $FilePath) -eq $Expected.Sha256)
}

# wrangler の呼び方（apps\integrated-prototype から、npx.cmd --no-install で）
function Get-DrillR2GetArgs([string]$ObjectKey, [string]$TargetFile) { return @('--no-install', 'wrangler', 'r2', 'object', 'get', ($drillBucket + '/' + $ObjectKey), '--remote', '--file', $TargetFile) }
function Format-DrillCommand([string[]]$CommandArgs) {
    $shown = foreach ($one in $CommandArgs) { if ($one -match '\s') { '"' + $one + '"' } else { $one } }
    return ('npx.cmd ' + ($shown -join ' '))
}

# wrangler を呼べるか（npx.cmd・依存の wrangler・アカウント）と、ログインしているかを確かめる。
# アカウントは wrangler.cloud.jsonc の account_id を CLOUDFLARE_ACCOUNT_ID で渡し、選ぶ質問を出さない（pg-exports-bucket.ps1 と同じ）
function Initialize-DrillWrangler([string]$AppDir) {
    if ($null -eq (Get-Command 'npx.cmd' -ErrorAction SilentlyContinue)) { Stop-Drill 'npx.cmd が見つからない' 'Node.js 24 を入れてから、同じ1行を流し直す' }
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'node_modules\wrangler\package.json'))) {
        Stop-Drill 'apps\integrated-prototype に wrangler が入っていない' 'wrangler の入っている core の作業場（配備に使う作業場など）の ps1 を流す。分からなければ Claude に絶対パスの1行を頼む'
    }
    $configPath = Join-Path $AppDir 'wrangler.cloud.jsonc'
    $account = $null
    if (Test-Path -LiteralPath $configPath) { $account = [regex]::Match([IO.File]::ReadAllText($configPath), '"account_id"\s*:\s*"([0-9a-f]{32})"') }
    if ($null -eq $account -or -not $account.Success) { Stop-Drill 'wrangler.cloud.jsonc に account_id が無い' 'main の最新に同期してから、同じ1行を流し直す' }
    [Environment]::SetEnvironmentVariable('CLOUDFLARE_ACCOUNT_ID', $account.Groups[1].Value, 'Process')
    # --json は未ログインなら終了コードが 0 でない。出力のメール・アカウントは出さない
    $whoami = Invoke-DrillNative 'npx.cmd' @('--no-install', 'wrangler', 'whoami', '--json')
    if ($whoami.Code -ne 0) {
        Stop-Drill 'wrangler にログインしていない' 'apps\integrated-prototype で npx.cmd --no-install wrangler login を流してから、同じ1行を流し直す（取れた分は飛ばして続きから取る）'
    }
}

# 1つ取る。うまくいかなければ間をあけて3回まで。取れたか（終了コード 0 でファイルがある）を返す。wrangler の出力は画面に出さない
function Invoke-DrillR2Get([string]$ObjectKey, [string]$TargetFile) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $fetched = Invoke-DrillNative 'npx.cmd' (Get-DrillR2GetArgs $ObjectKey $TargetFile)
        if ($fetched.Code -eq 0 -and (Test-Path -LiteralPath $TargetFile -PathType Leaf)) { return $true }
        if ($attempt -lt 3) { Start-Sleep -Seconds (2 * $attempt) }
    }
    return $false
}

# 環境変数を控える・戻す（$null は消す）
function Save-DrillEnv([string[]]$EnvNames) {
    $saved = @{}
    foreach ($envName in $EnvNames) { $saved[$envName] = [Environment]::GetEnvironmentVariable($envName, 'Process') }
    return $saved
}
function Restore-DrillEnv([hashtable]$SavedEnv) {
    foreach ($envName in @($SavedEnv.Keys)) { [Environment]::SetEnvironmentVariable($envName, $SavedEnv[$envName], 'Process') }
}
