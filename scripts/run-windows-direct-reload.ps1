# Windows evidence collection. Run at repository root after applying the matching patch.
# Latest logs/receipts are overwritten. No bridge product code is modified.
$ErrorActionPreference = 'Stop'
$previousVerificationRunId = $env:BRIDGE_VERIFICATION_RUN_ID
$verificationRunId = [guid]::NewGuid().ToString('N')
$env:BRIDGE_VERIFICATION_RUN_ID = $verificationRunId
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
        expectedHead = 'ca67622081ab2c4b324a8e1f87a6eccd13a9f3d6'
        verificationRunId = $verificationRunId
        actualHead = $head
        trackedChanges = $tree
        node = $node
        executable = (Resolve-Path $env:UI_BROWSER_EXECUTABLE).Path
        executableSha256 = (Get-FileHash $env:UI_BROWSER_EXECUTABLE -Algorithm SHA256).Hash.ToLowerInvariant()
        directScriptSha256 = (Get-FileHash $script -Algorithm SHA256).Hash.ToLowerInvariant()
        supervisorSha256 = (Get-FileHash $core -Algorithm SHA256).Hash.ToLowerInvariant()
        identitySha256 = (Get-FileHash (Join-Path $root 'scripts\direct-mv3-identity.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
        ackReceiptHelperSha256 = (Get-FileHash (Join-Path $root 'scripts\ack-windows-result.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
        referenceReceipt = $(if ($baseline) { $baselinePath } else { $null })
        referenceHead = $(if ($baseline) { $baseline.gitHead } else { $null })
        referenceBrowser = $(if ($baseline) { $baseline.cases[0].browserVersion } else { $null })
        referenceBrowserSha256 = $(if ($baseline) { $baseline.cases[0].launch.executableSha256 } else { $null })
        directObservation = 'Chromium process launched by Node (not Playwright), CDP attached via DevToolsActivePort'
        differences = @('Playwright launcher/default args removed','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','fresh profile per A/B')
    }
    $envPath = Join-Path $dir 'latest-direct-chromium-environment.json'
    $envRecord | ConvertTo-Json -Depth 12 | Set-Content -Path $envPath -Encoding UTF8
    Write-Host "VERIFICATION RUN ID: $verificationRunId"
    Write-Host "SOURCE HEAD: $head"
    Write-Host "CHROMIUM EXE: $($envRecord.executable)"
    Write-Host "CHROMIUM SHA256: $($envRecord.executableSha256)"
    if ($head -ne $envRecord.expectedHead) {
        Write-Warning 'Source HEAD differs from ca676220. No git checkout/reset/pull has been performed.'
    }
    if ($tree.Count) { Write-Host 'WORKTREE CHANGES:'; $tree | ForEach-Object { Write-Host "  $_" } }
    if ($baseline -and $baseline.cases[0].launch.executableSha256 -ne $envRecord.executableSha256) {
        throw 'Chromium executable changed from prior A-D evidence; direct comparison withheld'
    }
    # Every ACK invocation has its own ID. Remove *both* old receipts before
    # launching the runner. Even if it fails before producing a JSON receipt,
    # write this run's explicit RESULT_NOT_CREATED/FAIL, never copy an old PASS.
    $ackLog = Join-Path $dir 'latest-ack-windows.log'
    $ackReceipt = Join-Path $dir 'latest-test-result.json'
    $ackVerified = Join-Path $dir 'latest-ack-windows-result.json'
    Remove-Item -LiteralPath $ackReceipt -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ackVerified -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $ackReceipt) { throw 'Cannot clear the previous ACK test receipt' }
    if (Test-Path -LiteralPath $ackVerified) { throw 'Cannot clear the previous ACK verification receipt' }
    $ackStartedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    & node .\scripts\run-tests.mjs .\tests\delivery-ack-restart.test.js .\tests\delivery-terminal-reconciliation.test.js .\tests\discussion-response-atomicity.test.js *> $ackLog
    $ackExit = $LASTEXITCODE
    Add-Content -LiteralPath $ackLog -Value "VERIFICATION_RUN_ID $verificationRunId"
    & node .\scripts\ack-windows-result.mjs $verificationRunId $ackStartedMs $ackExit $ackReceipt $ackVerified
    $ackVerifyExit = $LASTEXITCODE
    if (-not (Test-Path -LiteralPath $ackVerified)) { throw 'This run did not create an ACK verification receipt' }
    $ack = Get-Content -LiteralPath $ackVerified -Raw | ConvertFrom-Json
    if ($ack.verificationRunId -ne $verificationRunId) { throw 'ACK run identity mismatch' }
    Write-Host "ACK CONTRACT EXIT: $ackExit / ACK RECEIPT VERDICT: $($ack.status) ($($ack.reason))"
    # Independent direct-Chromium A/B (no Playwright); preserve raw outcomes even when reload fails.
    $directLog = Join-Path $dir 'latest-direct-chromium-reload.log'
    $matrixReceipt = Join-Path $dir 'latest-direct-chromium-reload.json'
    Remove-Item -LiteralPath $matrixReceipt -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $matrixReceipt) { throw 'Cannot clear the previous direct comparison result' }
    & node .\scripts\direct-chromium-reload-compare.mjs *> $directLog
    $directExit = $LASTEXITCODE
    Add-Content -LiteralPath $directLog -Value "VERIFICATION_RUN_ID $verificationRunId"
    if (Test-Path $matrixReceipt) {
        $rawComparison = Get-Content $matrixReceipt -Raw | ConvertFrom-Json
        if ($rawComparison.verificationRunId -ne $verificationRunId) { throw 'Direct comparison run ID mismatch' }
        $result = Get-Content $matrixReceipt -Raw | ConvertFrom-Json
        $result.cases | Select-Object id,stage,execution,functionalRecovery,reloadBoundaryEvidence,reloadResult,@{N='childExit';E={$_.childExit.code}},@{N='cleanup';E={$_.cleanup.status}} | Format-Table
    }
    Write-Host "DIRECT COMPARISON EXIT: $directExit (0 means experiments COMPLETE, not reload PASS)"
    Write-Host "ENVIRONMENT: $envPath"
    Write-Host "ACK LOG: $ackLog"
    Write-Host "ACK RECEIPT: $(Join-Path $dir 'latest-ack-windows-result.json')"
    Write-Host "DIRECT LOG: $directLog"
    Write-Host "DIRECT RAW RECEIPT: $matrixReceipt"
    if ($ackExit -ne 0 -or $ackVerifyExit -ne 0 -or $directExit -ne 0) { exit 1 }
} finally {
    if ($null -eq $previousVerificationRunId) { Remove-Item Env:BRIDGE_VERIFICATION_RUN_ID -ErrorAction SilentlyContinue }
    else { $env:BRIDGE_VERIFICATION_RUN_ID = $previousVerificationRunId }
    Pop-Location
}
