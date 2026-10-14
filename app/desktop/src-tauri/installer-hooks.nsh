; PixPath installer hooks (included by Tauri's NSIS installer).
;
; PixPath was called Btrace up to v0.2.x. Windows registers an install under
; the product name, so the first PixPath update would otherwise install next
; to the old "Btrace" instead of replacing it. After PixPath is installed,
; look for the old Btrace entry (per-user install, our publisher only) and run
; its own uninstaller silently, then add PixPath's Start menu shortcut (an
; update skips it, and the uninstaller removed Btrace's). App data is kept:
; it lives under the bundle identifier (com.barrytickle.btrace), which has
; not changed.

!macro NSIS_HOOK_POSTINSTALL
  ; Borrow three registers; the installer's own code continues after us.
  Push $R7
  Push $R8
  Push $R9
  ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Btrace" "InstallLocation"
  ReadRegStr $R9 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Btrace" "Publisher"
  StrCmp $R8 "" btrace_done
  StrCmp $R9 "Barry Tickle" 0 btrace_done
  ; InstallLocation is stored in quotes: strip them.
  StrCpy $R7 $R8 1
  StrCmp $R7 '"' 0 +3
    StrCpy $R8 $R8 "" 1
    StrCpy $R8 $R8 -1
  IfFileExists "$R8\uninstall.exe" 0 btrace_done
    DetailPrint "Removing the old Btrace install (now PixPath)"
    ; _?= runs the uninstaller in place so ExecWait really waits for it.
    ExecWait '"$R8\uninstall.exe" /S _?=$R8'
    Delete "$R8\uninstall.exe"
    RMDir "$R8"
    DeleteRegKey HKCU "Software\Barry Tickle\Btrace"
    ; An update runs in update mode, which skips the Start menu shortcut
    ; (it expects the old one), but Btrace's uninstaller just removed
    ; Btrace's. Add PixPath's, where Tauri's own installer puts it.
    IfFileExists "$SMPROGRAMS\${PRODUCTNAME}.lnk" +2 0
      CreateShortCut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  btrace_done:
  Pop $R9
  Pop $R8
  Pop $R7
!macroend
