# Execute the real .ps1 with only native command boundaries replaced.
param([Parameter(Mandatory=$true)][string]$TargetScript, [Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
if (Test-Path Variable:PSNativeCommandUseErrorActionPreference) { $PSNativeCommandUseErrorActionPreference = $false }
$engine = @('powershell.exe','pwsh.exe','pwsh') | ForEach-Object { Join-Path $PSHOME $_ } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('bridge-powershell-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
function Quote-PS([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
try {
    foreach ($mode in @('normal','missing','stale','scope','nonterminal','exitMismatch','generation','manual','wrongLocation')) {
        $directory = Join-Path $tempRoot $mode
        New-Item -ItemType Directory -Path $directory | Out-Null
        $scriptText = @'
$ErrorActionPreference = 'Stop'
$env:BRIDGE_VERIFICATION_OUTPUT = __DIRECTORY__
$env:BRIDGE_VERIFICATION_RUN_ID = 'previous-session-id'
$env:PS_DIAGNOSTIC_TEST_MODE = __MODE__
Set-Location -LiteralPath __LOCATION__
function global:notepad.exe {
    param([string]$File)
    Add-Content -LiteralPath (Join-Path $env:BRIDGE_VERIFICATION_OUTPUT 'opened.txt') -Value $File
}
function global:node {
    $mode = $env:PS_DIAGNOSTIC_TEST_MODE
    $dir = $env:BRIDGE_VERIFICATION_OUTPUT
    $arguments = @($args)
    [IO.File]::WriteAllText((Join-Path $dir 'arguments.txt'), ($arguments -join "`n"))
    if ($mode -eq 'missing') { $global:LASTEXITCODE = 0; return }
    $record = @{
        verificationRunId = $(if ($mode -eq 'stale') {'old-run'} else {$env:BRIDGE_VERIFICATION_RUN_ID})
        scope = $(if ($mode -eq 'scope') {'wrong'} else {'windows-diagnostics/regression+ack+minimal-reload'})
        terminal = ($mode -ne 'nonterminal')
        exitCode = $(if ($mode -eq 'exitMismatch') {7} elseif ($mode -eq 'manual') {2} else {0})
        startedAt = [DateTimeOffset]::UtcNow.ToString('o')
        finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
        generatedAt = $(if ($mode -eq 'generation') {$null} else {[DateTimeOffset]::UtcNow.ToString('o')})
        bridgeFunction = 'UNVERIFIED'
        nextAction = 'read this run'
        stages = @(@{name='ack';status='PASS'},@{name='reload';status=$(if ($mode -eq 'manual') {'AWAITING_MANUAL'} else {'PASS'})})
    }
    $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $dir 'latest-windows-diagnostics.json') -Encoding UTF8
    [IO.File]::WriteAllText((Join-Path $dir 'latest-windows-diagnostics.log'), 'this run')
    $global:LASTEXITCODE = $(if ($mode -eq 'manual') {2} else {0})
}
& __TARGET__ __MANUAL__
$code = $LASTEXITCODE
if ($env:BRIDGE_VERIFICATION_RUN_ID -ne 'previous-session-id') { throw 'RUN_ID_ENV_NOT_RESTORED' }
exit $code
'@
        $location = if ($mode -eq 'wrongLocation') { $directory } else { $Root }
        $scriptText = $scriptText.Replace('__DIRECTORY__', (Quote-PS $directory)).Replace('__MODE__', (Quote-PS $mode)).
            Replace('__LOCATION__', (Quote-PS $location)).Replace('__TARGET__', (Quote-PS $TargetScript)).
            Replace('__MANUAL__', $(if ($mode -eq 'manual') {'-Manual'} else {''}))
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($scriptText))
        # Negative cases intentionally emit stderr and exit 2. Windows PowerShell
        # wraps stderr in ErrorRecord; inspect the real exit code after capture.
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $output = & $engine -NoProfile -NonInteractive -EncodedCommand $encoded 2>&1 | ForEach-Object { [string]$_ }
            $actual = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previousPreference }
        $expected = if ($mode -eq 'normal') {0} else {2}
        if ($actual -ne $expected) { throw "Case $mode exit $actual, expected $expected`n$output" }
        $opened = Join-Path $directory 'opened.txt'
        if ($mode -in @('normal','manual')) {
            if (-not (Test-Path $opened) -or @(Get-Content $opened).Count -ne 2) { throw "Case $mode did not open both current files" }
        } elseif (Test-Path $opened) { throw "Case $mode opened stale or invalid files" }
        if ($mode -eq 'manual') {
            if ((Get-Content (Join-Path $directory 'arguments.txt') -Raw) -notmatch '\-\-manual') { throw 'Manual flag was not forwarded' }
        }
        if ($mode -eq 'wrongLocation' -and (Test-Path (Join-Path $directory 'arguments.txt'))) { throw 'Node launched from wrong checkout' }
        Write-Output "PS_WORKFLOW_CASE $mode PASS"
    }
} finally { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
