# ps1-rules: strict
# Windows PowerShell 5.1. PG 計画 段2 S2: staging の日次の書き出し専用の R2 を作り、pg-daily/ を30日で消す規則を付ける。
# 代表が次の1行で流す（手順は core の docs/platform/operations/runbooks/05-staging.md「日次の書き出し専用の R2」）:
#   powershell -ExecutionPolicy Bypass -File "<core の絶対パス>\apps\integrated-prototype\scripts\pg-exports-bucket.ps1"
# -WhatIf を付けると、呼ぶ wrangler の引数を表示するだけで、wrangler は呼ばない。
# AI のセッションからは -WhatIf と、偽の npx.cmd で流す試験（core の scripts/ops/pg-exports-bucket.test.mjs）だけで流す。
#
# 順番: 0 ログインの確かめ（whoami --json）→ 1 バケットが無ければ apac に作る → 2 pg-daily/ を30日で消す規則が無ければ足す
#       → 3 規則の一覧で確かめる → 4 原本の R2（PRIVATE_ARTIFACTS）に期限の規則が無いことを確かめる。
# 出力は OK／NG と次の一手だけ。wrangler の出力（バケットの一覧・アカウント）は画面に出さない。
# 引数と出力の形は wrangler 4.127.0 の r2 bucket list・create・lifecycle list・lifecycle add（--help と実装）に合わせた。
# create は --update-config=false で設定ファイルへの書き足しの質問を出さず、lifecycle add は名前・prefix・--expire-days・--force を
# 全部渡して質問を出さない。アカウントは wrangler.cloud.jsonc の account_id を CLOUDFLARE_ACCOUNT_ID で渡し、選ぶ質問を出さない。
[CmdletBinding(SupportsShouldProcess = $true)]
param()
$ErrorActionPreference = 'Stop'
$dryRun = [bool]$WhatIfPreference
$appPath = Split-Path -Parent $PSScriptRoot
$exportBucket = 'openingnight-integrated-demo-staging-pg-exports'
$artifactBucket = 'openingnight-integrated-demo-staging'
$ruleName = 'pg-daily-30d'
$rulePrefix = 'pg-daily/'
$ruleDays = 30
$ruleAction = 'Expire objects after ' + $ruleDays + ' days'

$whoamiArgs = @('whoami', '--json')
$listArgs = @('r2', 'bucket', 'list')
$createArgs = @('r2', 'bucket', 'create', $exportBucket, '--location', 'apac', '--update-config=false')
$exportRulesArgs = @('r2', 'bucket', 'lifecycle', 'list', $exportBucket)
$addArgs = @('r2', 'bucket', 'lifecycle', 'add', $exportBucket, $ruleName, $rulePrefix, '--expire-days', [string]$ruleDays, '--force')
$artifactRulesArgs = @('r2', 'bucket', 'lifecycle', 'list', $artifactBucket)

function Format-Command([string[]]$WranglerArgs) { 'npx.cmd --no-install wrangler ' + ($WranglerArgs -join ' ') }
# Write-Ok・Stop-Ng は文として呼ぶ（値を受け取る式の中で呼ぶと、出力が変数に入って画面に出ない）
function Write-Ok([string]$Message) { Write-Output ('OK  ' + $Message) }
function Stop-Ng([string]$Message, [string]$NextStep) {
    Write-Output ('NG  ' + $Message)
    Write-Output ('次の一手: ' + $NextStep)
    Write-Output '判定: NG'
    exit 1
}

# 外部コマンドは pg-staging.ps1 と同じ形で包み、終了コードで成否を決める。
# PS 5.1 は native の stderr を ErrorRecord にする（終了コード 0 でも）ので、呼ぶあいだだけ Continue にする。
function Invoke-Wrangler([string[]]$WranglerArgs) {
    $commandArgs = @('--no-install', 'wrangler') + $WranglerArgs
    $ErrorActionPreference = 'Continue'
    try {
        $captured = & npx.cmd @commandArgs 2>&1
        $nativeExit = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = 'Stop' }
    $joined = (@($captured | ForEach-Object { [string]$_ }) -join "`n") -replace '\x1b\[[0-9;?]*[A-Za-z]', ''
    [pscustomobject]@{ ExitCode = $nativeExit; Text = $joined }
}

# lifecycle list の「name: … / enabled: … / prefix: … / action: …」の塊を、規則1つずつの表にする
function ConvertFrom-LifecycleList([string]$Listing) {
    $current = $null
    foreach ($line in ($Listing -split "`n")) {
        $hit = [regex]::Match($line, '^\s*(name|enabled|prefix|action):\s*(.*?)\s*$')
        if (-not $hit.Success) { continue }
        if ($hit.Groups[1].Value -eq 'name') {
            if ($null -ne $current) { $current }
            $current = @{ name = $hit.Groups[2].Value; enabled = ''; prefix = ''; action = '' }
        }
        elseif ($null -ne $current) { $current[$hit.Groups[1].Value] = $hit.Groups[2].Value }
    }
    if ($null -ne $current) { $current }
}

function Read-Rules([string[]]$WranglerArgs, [string]$Bucket) {
    $ruleListing = Invoke-Wrangler $WranglerArgs
    $rules = @(ConvertFrom-LifecycleList $ruleListing.Text)
    # 規則が0件のときは wrangler の「There are no lifecycle rules」の文がある。どちらも無ければ形が読めていない
    $readable = $ruleListing.ExitCode -eq 0 -and ($rules.Count -gt 0 -or $ruleListing.Text.Contains("There are no lifecycle rules for bucket '" + $Bucket + "'"))
    [pscustomobject]@{ ExitCode = $ruleListing.ExitCode; Readable = $readable; Rules = $rules }
}
function Stop-Unreadable($Result, [string[]]$WranglerArgs, [string]$Label) {
    if ($Result.ExitCode -ne 0) {
        Stop-Ng ($Label + ' の期限の規則を読めなかった（wrangler の終了コード ' + $Result.ExitCode + '）') ('もう一度この1行を流す。続けて落ちるなら、apps\integrated-prototype で ' + (Format-Command $WranglerArgs) + ' を流し、出力を Claude に渡す')
    }
    Stop-Ng ($Label + ' の期限の規則の一覧の形が読めない') 'apps\integrated-prototype で npx.cmd --no-install wrangler --version が 4.127.0 かを確かめ、Claude に伝える'
}

function Test-ExportRule($Rule) {
    $Rule.enabled -eq 'Yes' -and $Rule.prefix -eq $rulePrefix -and (@($Rule.action -split ', ') -contains $ruleAction)
}

$savedAccount = [Environment]::GetEnvironmentVariable('CLOUDFLARE_ACCOUNT_ID', 'Process')
$pushed = $false
try {
    $configPath = Join-Path $appPath 'wrangler.cloud.jsonc'
    if (-not (Test-Path -LiteralPath $configPath)) { Stop-Ng 'wrangler.cloud.jsonc が見つからない' 'core の apps\integrated-prototype\scripts\pg-exports-bucket.ps1 を、絶対パスでそのまま流す' }
    $account = [regex]::Match([IO.File]::ReadAllText($configPath), '"account_id"\s*:\s*"([0-9a-f]{32})"')
    if (-not $account.Success) { Stop-Ng 'wrangler.cloud.jsonc に account_id が無い' 'main の最新に同期してから流し直す' }

    if ($dryRun) {
        Write-Output '予行（-WhatIf）: wrangler は呼ばない。呼ぶ順と引数（apps\integrated-prototype で、CLOUDFLARE_ACCOUNT_ID を wrangler.cloud.jsonc の account_id にして呼ぶ）:'
        Write-Output ('  ' + (Format-Command $whoamiArgs))
        Write-Output ('  ' + (Format-Command $listArgs))
        Write-Output ('  （バケットが無いときだけ）' + (Format-Command $createArgs))
        Write-Output ('  （作ったときだけ。作れたかの確かめ）' + (Format-Command $listArgs))
        Write-Output ('  ' + (Format-Command $exportRulesArgs))
        Write-Output ('  （規則が無いときだけ）' + (Format-Command $addArgs))
        Write-Output ('  （足したときだけ。足せたかの確かめ）' + (Format-Command $exportRulesArgs))
        Write-Output ('  ' + (Format-Command $artifactRulesArgs))
        Write-Output '判定: 予行のみ（何も変えていない）'
        exit 0
    }

    if ($null -eq (Get-Command 'npx.cmd' -ErrorAction SilentlyContinue)) { Stop-Ng 'npx.cmd が見つからない' 'Node.js 24 を入れてから流し直す' }
    if (-not (Test-Path -LiteralPath (Join-Path $appPath 'node_modules\wrangler\package.json'))) {
        Stop-Ng 'apps\integrated-prototype に wrangler が入っていない' 'Claude に伝える（依存の入れ方を確かめる）'
    }
    [Environment]::SetEnvironmentVariable('CLOUDFLARE_ACCOUNT_ID', $account.Groups[1].Value, 'Process')
    Push-Location -LiteralPath $appPath
    $pushed = $true

    # 0. ログイン（--json は未ログインなら終了コードが 0 でない。出力のメール・アカウントは出さない）
    if ((Invoke-Wrangler $whoamiArgs).ExitCode -ne 0) {
        Stop-Ng 'wrangler にログインしていない' 'apps\integrated-prototype で npx.cmd --no-install wrangler login を流してから、もう一度この1行を流す'
    }

    # 1. 書き出し専用のバケット
    $listed = Invoke-Wrangler $listArgs
    if ($listed.ExitCode -ne 0 -or -not $listed.Text.Contains('Listing buckets...')) {
        Stop-Ng ('R2 のバケットの一覧を読めなかった（wrangler の終了コード ' + $listed.ExitCode + '）') 'もう一度この1行を流す。続けて落ちるなら Claude に伝える'
    }
    $names = @([regex]::Matches($listed.Text, '(?m)^\s*name:\s*(\S+)\s*$') | ForEach-Object { $_.Groups[1].Value })
    if ($names -contains $exportBucket) {
        Write-Ok ('書き出し専用の R2 ' + $exportBucket + ' はある')
    }
    else {
        $created = Invoke-Wrangler $createArgs
        if ($created.ExitCode -ne 0) {
            Stop-Ng ('書き出し専用の R2 ' + $exportBucket + ' を作れなかった（wrangler の終了コード ' + $created.ExitCode + '）') 'R2 の画面でバケットが無いことを確かめ、もう一度この1行を流す。続けて落ちるなら Claude に伝える'
        }
        $relisted = Invoke-Wrangler $listArgs
        $renames = @([regex]::Matches($relisted.Text, '(?m)^\s*name:\s*(\S+)\s*$') | ForEach-Object { $_.Groups[1].Value })
        if ($relisted.ExitCode -ne 0 -or -not ($renames -contains $exportBucket)) {
            Stop-Ng ('作った書き出し専用の R2 ' + $exportBucket + ' が一覧に出ない') 'R2 の画面でバケットを確かめ、出力を Claude に渡す'
        }
        Write-Ok ('書き出し専用の R2 ' + $exportBucket + ' を apac に作った')
    }

    # 2・3. pg-daily/ を30日で消す規則
    $read = Read-Rules $exportRulesArgs $exportBucket
    if (-not $read.Readable) { Stop-Unreadable $read $exportRulesArgs '書き出し専用の R2' }
    $rules = @($read.Rules)
    $good = @($rules | Where-Object { Test-ExportRule $_ })
    if ($good.Count -eq 0) {
        if (@($rules | Where-Object { $_.name -eq $ruleName }).Count -gt 0) {
            Stop-Ng ('同じ名前の規則 ' + $ruleName + ' があるが、' + $rulePrefix + ' を' + $ruleDays + '日で消す形でない') ('R2 の画面（' + $exportBucket + ' の設定 → オブジェクトのライフサイクルの規則）で ' + $ruleName + ' を消してから、もう一度この1行を流す')
        }
        $added = Invoke-Wrangler $addArgs
        if ($added.ExitCode -ne 0) {
            Stop-Ng ('期限の規則 ' + $ruleName + ' を足せなかった（wrangler の終了コード ' + $added.ExitCode + '）') 'もう一度この1行を流す。続けて落ちるなら Claude に伝える'
        }
        $read = Read-Rules $exportRulesArgs $exportBucket
        if (-not $read.Readable) { Stop-Unreadable $read $exportRulesArgs '書き出し専用の R2' }
        $rules = @($read.Rules)
        $good = @($rules | Where-Object { Test-ExportRule $_ })
        if ($good.Count -eq 0) {
            Stop-Ng ('足した規則 ' + $ruleName + ' が一覧に ' + $rulePrefix + ' を' + $ruleDays + '日で消す形で出ない') 'R2 の画面で規則を確かめ、出力を Claude に渡す'
        }
        Write-Ok ('期限の規則 ' + $ruleName + '（' + $rulePrefix + ' を' + $ruleDays + '日で消す）を足し、一覧で確かめた')
    }
    else {
        Write-Ok ('期限の規則（' + $rulePrefix + ' を' + $ruleDays + '日で消す）は一覧にある: ' + (($good | ForEach-Object { $_.name }) -join '・'))
    }
    $others = @($rules | Where-Object { -not (Test-ExportRule $_) -and $_.enabled -eq 'Yes' -and $_.action.Contains('Expire objects') -and
        ($_.prefix -eq '(all prefixes)' -or $rulePrefix.StartsWith($_.prefix)) })
    if ($others.Count -gt 0) {
        Stop-Ng ('ほかの期限の規則が ' + $rulePrefix + ' にもかかる: ' + (($others | ForEach-Object { $_.name }) -join '・')) 'R2 の画面でその規則を確かめ、出力を Claude に渡す（30日より早く世代が消えうる）'
    }

    # 4. 原本の R2 に期限の規則が無い（原本は消えると戻せない）
    $read = Read-Rules $artifactRulesArgs $artifactBucket
    if (-not $read.Readable) { Stop-Unreadable $read $artifactRulesArgs ('原本の R2 ' + $artifactBucket) }
    $expiring = @(@($read.Rules) | Where-Object { $_.action.Contains('Expire objects') })
    if ($expiring.Count -gt 0) {
        Stop-Ng ('原本の R2 ' + $artifactBucket + ' に期限の規則がある: ' + (($expiring | ForEach-Object { $_.name }) -join '・')) '規則を消さずに、この出力を Claude に渡す（原本は消えると戻せない。消す前に中身と経緯を確かめる）'
    }
    Write-Ok ('原本の R2 ' + $artifactBucket + ' に期限の規則は無い')
    Write-Output '判定: OK'
    Write-Output '次の一手: この出力を Claude に渡す（S1 のマージと staging への配備に進む）'
    exit 0
}
catch {
    Write-Output 'NG  予期しない失敗で止まった'
    Write-Output '次の一手: この出力を Claude に渡す（接続値・トークンは出していない）'
    Write-Output '判定: NG'
    exit 1
}
finally {
    if ($pushed) { Pop-Location }
    [Environment]::SetEnvironmentVariable('CLOUDFLARE_ACCOUNT_ID', $savedAccount, 'Process')
}
