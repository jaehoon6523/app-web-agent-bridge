param([string]$ChromePath = $env:CHROME_PATH, [switch]$FullRegression)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$log = Join-Path $root 'preparation-tab-ux-verification-latest.log'
"Started: $([DateTime]::UtcNow.ToString('o'))" | Set-Content -Encoding utf8 $log
function Invoke-Logged([string]$Program, [string[]]$Arguments) {
  "RUN: $Program $($Arguments -join ' ')" | Tee-Object -FilePath $log -Append
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $Program @Arguments 2>&1 | Tee-Object -FilePath $log -Append; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $previousPreference }
  if ($code -ne 0) { throw "Verification failed ($code): $Program" }
}
try {
  Invoke-Logged 'git' @('rev-parse', 'HEAD')
  Invoke-Logged 'node' @('--version')
  Invoke-Logged 'node' @('scripts/lint.js')
  Invoke-Logged 'node' @('scripts/architecture-check.js')
  Invoke-Logged 'npm.cmd' @('run', 'typecheck')
  'TARGETED: START' | Tee-Object -FilePath $log -Append
  Invoke-Logged 'node' @('--test', 'tests/preparation-tab-choice.test.js', 'tests/preparation-tab-focus.test.js', 'tests/diagnostic-export.test.js', 'tests/extension-delivery-review.test.js', 'tests/flexible-tab-recovery.test.js', 'tests/preparation-stale-tab-integration.test.js', 'tests/preparation-api.test.js', 'tests/public/workflow-runtime.test.js')
  'TARGETED: PASS' | Tee-Object -FilePath $log -Append
  if ($FullRegression) { Invoke-Logged 'npm.cmd' @('run', 'check'); 'FULL_REGRESSION: PASS' | Tee-Object -FilePath $log -Append }
  else { 'FULL_REGRESSION: NOT_RUN (use -FullRegression)' | Tee-Object -FilePath $log -Append }
  if (-not $ChromePath) {
    foreach ($candidate in @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")) {
      if (Test-Path $candidate) { $ChromePath = $candidate; break }
    }
  }
  if ($ChromePath -and (Test-Path $ChromePath)) {
    $env:CHROME_PATH = $ChromePath
    Invoke-Logged 'node' @('scripts/preparation-tab-ux-browser.mjs')
  } else { throw 'Chrome executable not found. Supply -ChromePath; browser verification has not passed.' }
  'PASS: targeted contracts and local browser fixture. Installed extension and real ChatGPT flow NOT VERIFIED.' | Tee-Object -FilePath $log -Append
} catch {
  "FAIL: $($_.Exception.Message)" | Tee-Object -FilePath $log -Append
  exit 1
}
