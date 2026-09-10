import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const execute = promisify(execFile);
let selection = null;

export function chooseProjectFolder() {
  if (selection) return selection;
  selection = openProjectFolder().finally(() => { selection = null; });
  return selection;
}

async function openProjectFolder() {
  if (process.platform !== "win32") throw new Error("폴더 선택 창은 Windows에서 지원합니다. 폴더 경로를 직접 입력하세요.");
  try {
    // No user input is interpolated into the PowerShell program.
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$nativeSource = @'
${readFileSync(new URL("./folder-picker.cs", import.meta.url), "utf8")}
'@
Add-Type -TypeDefinition $nativeSource
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Width = 1
$owner.Height = 1
$owner.StartPosition = 'CenterScreen'
try {
  $owner.Show()
  $owner.Activate()
  $selectedPath = [Bridge.NativeFolderPicker]::Show($owner.Handle)
  if ($null -ne $selectedPath) {
    [Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($selectedPath)))
  }
} finally { $owner.Dispose() }
`;
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 300000, maxBuffer: 65536 });
    const encoded = stdout.trim();
    return { targetRoot: encoded ? Buffer.from(encoded, "base64").toString("utf8") : null };
  } catch (error) {
    if (error.killed) throw new Error("폴더 선택 대기 시간이 지났습니다. 다시 폴더를 선택하세요.");
    throw new Error(`폴더 선택 창을 열지 못했습니다 (${error.code || "WINDOW_ERROR"}). 경로를 직접 입력하거나 다시 시도하세요.`);
  }
}
