; Installer hooks for the Windows (NSIS) installer. Wired in tauri.conf.json, bundle.windows.nsis.installerHooks.
; Tauri's installer.nsi runs NSIS_HOOK_PREINSTALL at the start of the install section, before it copies any file.
;
; Why: Agent OS runs its own copy of Node, $INSTDIR\resources\node\node.exe, as its server. Windows will not
; let an installer overwrite a program that is running, so an update (or a reinstall) over an Agent OS that
; is still running could stop half way. This hook stops that one program, and nothing else, before the files
; are copied.
;
; What it touches: only node.exe processes whose own path is inside $INSTDIR\resources\node\ (the trailing
; backslash is part of the test, so a folder such as ...\node2 never matches). It waits up to 15 seconds for
; them to exit. A failure of any kind is ignored: the install goes on either way.
;
; The folder reaches PowerShell through an environment variable, not through the command line, so spaces,
; quotes and apostrophes in the install path cannot change what the script does. Processes are found with
; CIM (WMI) because this installer is a 32-bit program, and a 32-bit PowerShell cannot read the path of a
; 64-bit node.exe through Get-Process. A "$" in an NSIS string is written "$$".

!macro NSIS_HOOK_PREINSTALL
  System::Call 'Kernel32::SetEnvironmentVariable(t "AGENTOS_NODE_DIR", t "$INSTDIR\resources\node") i .r0'
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { $$dir = [System.IO.Path]::GetFullPath($$env:AGENTOS_NODE_DIR).TrimEnd([char]92) + [char]92; $$mine = { Get-CimInstance Win32_Process | Where-Object { $$_.Name -eq 'node.exe' -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$dir, [System.StringComparison]::OrdinalIgnoreCase) } }; @(& $$mine) | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; $$end = (Get-Date).AddSeconds(15); while (@(& $$mine).Count -gt 0 -and (Get-Date) -lt $$end) { Start-Sleep -Milliseconds 250 } } catch { }; exit 0"`
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "AGENTOS_NODE_DIR", t "") i .r0'
!macroend
