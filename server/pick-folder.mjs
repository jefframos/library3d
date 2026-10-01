// Opens the OS's native "choose folder" dialog on this machine and resolves with the chosen absolute path (or null if cancelled).
import { spawn } from 'node:child_process';

// Explorer-style folder picker (IFileOpenDialog + FOS_PICKFOLDERS), owned by a hidden top-most window so it opens
// in front of the browser. Falls back to the classic FolderBrowserDialog if the COM route fails.
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint c, IntPtr f);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr e, out uint c);
    void Unadvise(uint c);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem si);
    void SetFolder(IShellItem si);
    void GetFolder(out IShellItem si);
    void GetCurrentSelection(out IShellItem si);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void GetResult(out IShellItem si);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem si);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItem item);

  public static string Pick(string title, string start, IntPtr owner) {
    var d = (IFileDialog)new FileOpenDialogRCW();
    uint opts; d.GetOptions(out opts);
    d.SetOptions(opts | 0x20 | 0x40 | 0x800); // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST
    d.SetTitle(title);
    d.SetOkButtonLabel("Use this folder");
    if (!string.IsNullOrEmpty(start)) {
      try { var g = typeof(IShellItem).GUID; IShellItem si; SHCreateItemFromParsingName(start, IntPtr.Zero, ref g, out si); d.SetFolder(si); } catch {}
    }
    if (d.Show(owner) != 0) return null;
    IShellItem r; d.GetResult(out r);
    string p; r.GetDisplayName(0x80058000, out p); // SIGDN_FILESYSPATH
    return p;
  }
}
'@
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; StartPosition = 'Manual'; Location = '-32000,-32000'; Size = '1,1' }
$owner.Show(); $owner.Activate()
try {
  $p = [FolderPicker]::Pick($env:PICK_TITLE, $env:PICK_START, $owner.Handle)
} catch {
  $d = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{ Description = $env:PICK_TITLE; ShowNewFolderButton = $true; SelectedPath = $env:PICK_START }
  $p = $null; if ($d.ShowDialog($owner) -eq 'OK') { $p = $d.SelectedPath }
}
$owner.Close()
if ($p) { [Console]::Out.Write($p) }
`;

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${cmd} exited with ${code}`))));
  });
}

let busy = false;

/** @returns {Promise<string|null>} */
export async function pickFolder({ title = 'Choose a folder', start = '' } = {}) {
  if (busy) throw Object.assign(new Error('A folder dialog is already open — check your taskbar.'), { status: 409 });
  busy = true;
  try {
    let out;
    if (process.platform === 'win32') {
      const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
      out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        PICK_TITLE: title,
        PICK_START: start,
      });
    } else if (process.platform === 'darwin') {
      const script = 'on run argv\nPOSIX path of (choose folder with prompt (item 1 of argv))\nend run';
      out = await run('osascript', ['-e', script, title]).catch((e) => (/User canceled|-128/.test(e.message) ? '' : Promise.reject(e)));
    } else {
      out = await run('zenity', ['--file-selection', '--directory', `--title=${title}`, ...(start ? [`--filename=${start}/`] : [])]).catch((e) =>
        /exited with 1$/.test(e.message) ? '' : Promise.reject(e),
      );
    }
    return out || null;
  } finally {
    busy = false;
  }
}
