# Module E: keep PowerShell concerned only with invocation and viewing current evidence.
[CmdletBinding()]
param([switch]$Manual, [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
# Native nonzero exits are recorded by Node; do not turn them into an early
# PowerShell exception that hides the current receipt.
if (Test-Path Variable:PSNativeCommandUseErrorActionPreference) { $PSNativeCommandUseErrorActionPreference = $false }
$previousRunId = $env:BRIDGE_VERIFICATION_RUN_ID
$runId = [guid]::NewGuid().ToString('N')
$env:BRIDGE_VERIFICATION_RUN_ID = $runId
$exitCode = 2
try {
    $root = (git rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $root) { throw 'Run from the app-web-agent-bridge checkout.' }
    $root = $root.Trim()
    $entry = Join-Path $root 'scripts/windows-diagnostics.mjs'
    if (-not (Test-Path -LiteralPath $entry)) { throw 'Wrong checkout: diagnostics entry not found.' }
    $dir = Join-Path $root '.agent-controller'
    if ($env:BRIDGE_VERIFICATION_OUTPUT) { $dir = [IO.Path]::GetFullPath($env:BRIDGE_VERIFICATION_OUTPUT) }
    $arguments = @($entry)
    if ($Manual) { $arguments += '--manual' }
    $invokedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    & node @arguments
    $exitCode = $LASTEXITCODE
    $receipt = Join-Path $dir 'latest-windows-diagnostics.json'
    $log = Join-Path $dir 'latest-windows-diagnostics.log'
    if (-not (Test-Path -LiteralPath $receipt)) { throw 'This run did not create a diagnostics result.' }
    $result = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
    if ($result.verificationRunId -ne $runId -or $result.scope -ne 'windows-diagnostics/regression+ack+minimal-reload' -or
        $result.terminal -ne $true -or $result.exitCode -ne $exitCode) { throw 'Current run receipt identity/scope/termination mismatch.' }
    if (-not $result.startedAt -or -not $result.finishedAt -or -not $result.generatedAt) { throw 'Current result generation metadata missing.' }
    $startedMs = ([DateTimeOffset]$result.startedAt).ToUnixTimeMilliseconds()
    $finishedMs = ([DateTimeOffset]$result.finishedAt).ToUnixTimeMilliseconds()
    $generatedMs = ([DateTimeOffset]$result.generatedAt).ToUnixTimeMilliseconds()
    if ($startedMs -lt $invokedAtMs -or $finishedMs -lt $startedMs -or $generatedMs -lt $finishedMs) { throw 'Current result timestamps are invalid.' }
    $result.stages | Select-Object name,status,startedAt,finishedAt | Format-Table
    Write-Host "Run: $runId | Native bridge function: $($result.bridgeFunction)"
    Write-Host "Next: $($result.nextAction)"
    Write-Host "Log: $log"
    Write-Host "Result: $receipt"
    if (-not $NoOpen) {
        if (Test-Path -LiteralPath $log) { & notepad.exe $log }
        & notepad.exe $receipt
    }
} catch {
    Write-Error -ErrorAction Continue $_
    $exitCode = 2
} finally {
    if ($null -eq $previousRunId) { Remove-Item Env:BRIDGE_VERIFICATION_RUN_ID -ErrorAction SilentlyContinue }
    else { $env:BRIDGE_VERIFICATION_RUN_ID = $previousRunId }
}
exit $exitCode
