# Windows evidence collection. Run at repository root after applying the matching patch.
# Latest logs/receipts are overwritten. No bridge product code is modified.
$ErrorActionPreference = 'Stop'
$root = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Run from the app-web-agent-bridge checkout' }
Push-Location $root
try {
    $dir = Join-Path $root '.agent-controller'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $script = Join-Path $root 'scripts\direct-chromium-reload-compare.mjs'
    $core = Join-Path $root 'scripts\mv3-reload-core.mjs'
    if (-not (Test-Path $script) -or -not (Test-Path $core)) { throw 'Direct comparator/core not found' }
    $head = (git rev-parse HEAD).Trim()
    $tree = @(git status --porcelain=v1)
    $node = (node --version).Trim()
    $baselinePath = Join-Path $dir 'latest-minimal-native-reload-matrix-headed.json'
    if (-not (Test-Path $baselinePath)) { $baselinePath = Join-Path $dir 'latest-minimal-native-reload-matrix-v2.json' }
    if (-not (Test-Path $baselinePath)) { throw 'Previous A-D raw JSON is required to pin the exact Chromium binary.' }
    $baseline = Get-Content $baselinePath -Raw | ConvertFrom-Json
    if (-not $baseline.cases -or -not $baseline.cases[0].launch.executablePath) {
        throw 'Previous A-D result does not record a Chromium executable.'
    }
    $referenceExecutable = $baseline.cases[0].launch.executablePath
    if (-not $env:UI_BROWSER_EXECUTABLE) { $env:UI_BROWSER_EXECUTABLE = $referenceExecutable }
    if (-not (Test-Path -LiteralPath $env:UI_BROWSER_EXECUTABLE)) {
        throw 'The previously tested Chromium executable no longer exists. Restore it or set UI_BROWSER_EXECUTABLE explicitly.'
    }
    $envRecord = [ordered]@{
        capturedAt = (Get-Date).ToUniversalTime().ToString('o')
        expectedHead = 'e331ea8ee971ac70febaea3dd04a5de021f2ca18'
        actualHead = $head
        trackedChanges = $tree
        node = $node
        executable = (Resolve-Path $env:UI_BROWSER_EXECUTABLE).Path
        executableSha256 = (Get-FileHash $env:UI_BROWSER_EXECUTABLE -Algorithm SHA256).Hash.ToLowerInvariant()
        directScriptSha256 = (Get-FileHash $script -Algorithm SHA256).Hash.ToLowerInvariant()
        supervisorSha256 = (Get-FileHash $core -Algorithm SHA256).Hash.ToLowerInvariant()
        referenceReceipt = $(if ($baseline) { $baselinePath } else { $null })
        referenceHead = $(if ($baseline) { $baseline.gitHead } else { $null })
        referenceBrowser = $(if ($baseline) { $baseline.cases[0].browserVersion } else { $null })
        referenceBrowserSha256 = $(if ($baseline) { $baseline.cases[0].launch.executableSha256 } else { $null })
        directObservation = 'Chromium process launched by Node (not Playwright), CDP attached via DevToolsActivePort'
        differences = @('Playwright launcher/default args removed','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','fresh profile per A/B')
    }
    $envPath = Join-Path $dir 'latest-direct-chromium-environment.json'
    $envRecord | ConvertTo-Json -Depth 12 | Set-Content -Path $envPath -Encoding UTF8
    Write-Host "SOURCE HEAD: $head"
    Write-Host "CHROMIUM EXE: $($envRecord.executable)"
    Write-Host "CHROMIUM SHA256: $($envRecord.executableSha256)"
    if ($head -ne $envRecord.expectedHead) {
        Write-Warning 'Source HEAD differs from e331ea8. No git checkout/reset/pull has been performed.'
    }
    if ($tree.Count) { Write-Host 'WORKTREE CHANGES:'; $tree | ForEach-Object { Write-Host "  $_" } }
    if ($baseline -and $baseline.cases[0].launch.executableSha256 -ne $envRecord.executableSha256) {
        throw 'Chromium executable changed from prior A-D evidence; direct comparison withheld'
    }
    # ACK/reconnect tests do not require Chromium reload. Keep their receipts separately.
    $ackLog = Join-Path $dir 'latest-ack-windows.log'
    & node .\scripts\run-tests.mjs .\tests\delivery-ack-restart.test.js .\tests\delivery-terminal-reconciliation.test.js .\tests\discussion-response-atomicity.test.js *> $ackLog
    $ackExit = $LASTEXITCODE
    $ackReceipt = Join-Path $dir 'latest-test-result.json'
    if (Test-Path $ackReceipt) { Copy-Item $ackReceipt (Join-Path $dir 'latest-ack-windows-result.json') -Force }
    Write-Host "ACK CONTRACT EXIT: $ackExit"
    # Independent direct-Chromium A/B (no Playwright); preserve raw outcomes even when reload fails.
    $directLog = Join-Path $dir 'latest-direct-chromium-reload.log'
    & node .\scripts\direct-chromium-reload-compare.mjs *> $directLog
    $directExit = $LASTEXITCODE
    $matrixReceipt = Join-Path $dir 'latest-direct-chromium-reload.json'
    if (Test-Path $matrixReceipt) {
        $result = Get-Content $matrixReceipt -Raw | ConvertFrom-Json
        $result.cases | Select-Object id,stage,execution,functionalRecovery,reloadBoundaryEvidence,reloadResult,@{N='childExit';E={$_.childExit.code}},@{N='cleanup';E={$_.cleanup.status}} | Format-Table
    }
    Write-Host "DIRECT COMPARISON EXIT: $directExit (0 means experiments COMPLETE, not reload PASS)"
    Write-Host "ENVIRONMENT: $envPath"
    Write-Host "ACK LOG: $ackLog"
    Write-Host "ACK RECEIPT: $(Join-Path $dir 'latest-ack-windows-result.json')"
    Write-Host "DIRECT LOG: $directLog"
    Write-Host "DIRECT RAW RECEIPT: $matrixReceipt"
    if ($ackExit -ne 0 -or $directExit -ne 0) { exit 1 }
} finally { Pop-Location }
