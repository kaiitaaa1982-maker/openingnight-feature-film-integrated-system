$ErrorActionPreference = 'Stop'
$appDirectory = $PSScriptRoot
$nodeExecutable = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
if (!(Test-Path -LiteralPath $nodeExecutable)) { $nodeExecutable = (Get-Command node).Source }
Push-Location $appDirectory
try {
    & $nodeExecutable scripts/init-workbench-demo.mjs
    if ($LASTEXITCODE -ne 0) { throw '架空DBの準備に失敗しました' }
    & $nodeExecutable node_modules/vite/bin/vite.js build --configLoader runner
    if ($LASTEXITCODE -ne 0) { throw 'ビルドに失敗しました' }
    $env:ON_DB_FILE = Join-Path $appDirectory 'data/workbench-demo.sqlite'
    $env:PORT = '9046'
    & $nodeExecutable src/server.mjs
} finally { Pop-Location }
