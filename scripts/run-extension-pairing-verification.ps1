$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
$logDirectory = Join-Path (Get-Location) '.agent-controller\diagnostics'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$log = Join-Path $logDirectory 'extension-pairing-verification-latest.log'
Set-Content -Path $log -Value "Verification started: $(Get-Date -Format o)`nNode: $(node --version)`n" -Encoding UTF8

function Invoke-Verification([string]$Name, [string[]]$Arguments) {
  Add-Content -Path $log -Value "`n== $Name ==" -Encoding UTF8
  & $Arguments[0] $Arguments[1..($Arguments.Length - 1)] 2>&1 |
    ForEach-Object { $_.ToString() } | Tee-Object -FilePath $log -Append
  if ($LASTEXITCODE -ne 0) {
    Add-Content -Path $log -Value "FAILED: $Name (exit $LASTEXITCODE)" -Encoding UTF8
    throw "Verification failed: $Name. See $log"
  }
}

try {
  Invoke-Verification 'pairing and reconnect tests' @('node', '--experimental-sqlite', '--test',
    '--experimental-test-isolation=none', 'tests/extension-pairing.test.js',
    'tests/extension-pairing-http.test.js', 'tests/extension-reconnect.test.js')
  Invoke-Verification 'repository check' @('npm', 'run', 'check')
  Add-Content -Path $log -Value "`nPASS: $(Get-Date -Format o)" -Encoding UTF8
  Write-Host "Latest verification log: $log"
} catch {
  Write-Host "Latest verification log: $log"
  exit 1
}
