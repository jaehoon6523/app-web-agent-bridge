import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

let warned = false;
function writeWarning(error) {
  if (!warned) process.stderr.write(`[E2E diagnostics] ${error.message}\n`);
  warned = true;
}

export function recordProcess(role, pid, parentPid = process.pid) {
  const directory = process.env.BRIDGE_E2E_DIAGNOSTICS_DIR;
  if (!directory) return;
  try {
    fs.appendFileSync(path.join(directory, 'processes.jsonl'),
      JSON.stringify({at:new Date().toISOString(),role,pid,parentPid})+'\n');
  } catch (error) { writeWarning(error); }
}

export function startResourceSamples(directory) {
  const file = path.join(directory, 'resources.jsonl');
  const sample = () => {
    try {
      const disk = fs.statfsSync(directory);
      fs.appendFileSync(file, JSON.stringify({at:new Date().toISOString(),
        availableMemoryBytes:os.freemem(),diskAvailableBytes:disk.bavail*disk.bsize})+'\n');
    } catch (error) { writeWarning(error); }
  };
  sample();
  const timer = setInterval(sample, 1000);
  timer.unref();
  return () => clearInterval(timer);
}

const windowsMemoryCommand = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct PerformanceInfo {
  public uint cb;
  public UIntPtr CommitTotal, CommitLimit, CommitPeak, PhysicalTotal, PhysicalAvailable;
  public UIntPtr SystemCache, KernelTotal, KernelPaged, KernelNonpaged, PageSize;
  public uint HandleCount, ProcessCount, ThreadCount;
}
public static class SystemPerformance {
  [DllImport("psapi.dll", SetLastError=true)]
  public static extern bool GetPerformanceInfo(out PerformanceInfo info, uint size);
}
'@
$info = New-Object PerformanceInfo
$size = [Runtime.InteropServices.Marshal]::SizeOf($info)
$file = Join-Path $env:BRIDGE_E2E_DIAGNOSTICS_DIR 'windows-memory.jsonl'
while (Get-Process -Id $env:BRIDGE_E2E_OWNER_PID -ErrorAction SilentlyContinue) {
  if (-not [SystemPerformance]::GetPerformanceInfo([ref]$info, [uint32]$size)) {
    throw "GetPerformanceInfo failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  @{at=[DateTime]::UtcNow.ToString('o');
    commitBytes=$info.CommitTotal.ToUInt64()*$info.PageSize.ToUInt64();
    commitLimitBytes=$info.CommitLimit.ToUInt64()*$info.PageSize.ToUInt64();
    physicalAvailableBytes=$info.PhysicalAvailable.ToUInt64()*$info.PageSize.ToUInt64()} |
    ConvertTo-Json -Compress | Add-Content -LiteralPath $file -Encoding utf8
  Start-Sleep -Seconds 1
}`;

export function startWindowsMemorySamples(directory) {
  if (process.platform !== 'win32') return () => {};
  let stopRequested = false;
  const child = spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',windowsMemoryCommand],
    {windowsHide:true,stdio:['ignore','ignore','pipe'],
      env:{...process.env,BRIDGE_E2E_DIAGNOSTICS_DIR:directory,BRIDGE_E2E_OWNER_PID:String(process.pid)}});
  child.once('error',writeWarning);
  child.stderr.on('data',chunk => {
    try { fs.appendFileSync(path.join(directory,'windows-memory-error.log'),chunk); }
    catch (error) { writeWarning(error); }
  });
  child.once('close',(code,signal) => {
    try { fs.writeFileSync(path.join(directory,'windows-memory-status.json'),JSON.stringify({code,signal,
      stopRequested,
      samples:fs.existsSync(path.join(directory,'windows-memory.jsonl'))
        ? fs.readFileSync(path.join(directory,'windows-memory.jsonl'),'utf8').trim().split('\n').length : 0})); }
    catch (error) { writeWarning(error); }
  });
  return () => { stopRequested = true; child.kill(); };
}
