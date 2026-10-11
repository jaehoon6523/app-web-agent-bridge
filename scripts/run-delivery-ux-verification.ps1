# Run from any directory. The latest test log is replaced, never accumulated across runs.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'test-latest.log'
Push-Location $root
try {
    $base = (git rev-parse HEAD 2>&1 | Out-String).Trim()
    $status = (git status --porcelain=v1 2>&1 | Out-String).Trim()
    $statusText = if ([string]::IsNullOrWhiteSpace($status)) { '(clean)' } else { $status }
    @("Delivery UX verification", "UTC: $((Get-Date).ToUniversalTime().ToString('o'))",
      "Local HEAD: $base", "Node: $(node --version)", "Working tree:", $statusText, '') |
      Set-Content -Path $log -Encoding utf8
    $script:failed = $false
    function Invoke-Logged($label, $command) {
        Add-Content -Path $log -Value "`n=== $label ===" -Encoding utf8
        & cmd.exe /d /s /c $command 2>&1 | ForEach-Object {
            $line = "$_"
            Write-Output $line
            Add-Content -Path $log -Value $line -Encoding utf8
        }
        $code = $LASTEXITCODE
        Add-Content -Path $log -Value "Exit code [$label]: $code" -Encoding utf8
        if ($code -ne 0) { $script:failed = $true }
    }
    Invoke-Logged 'UI mock tests' 'node --test tests/delivery-recovery-ui.test.js'
    Invoke-Logged 'Recovery contract tests' 'node --experimental-sqlite --test tests/delivery-terminal-reconciliation.test.js tests/delivery-terminal-http.test.js tests/extension-delivery-review.test.js'
    Invoke-Logged 'Platform regression' 'npm run test:platform'
    Invoke-Logged 'Full verification (check, browser, native extension, browser platform, controlled E2E)' 'npm run verify:all'
    if ($script:failed) { exit 1 }
} finally {
    Pop-Location
}
