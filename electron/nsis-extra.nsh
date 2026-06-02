; odysseus-electron/installer/nsis-extra.nsh
; Extra NSIS logic: checks for Python 3.11+ before completing install.
; If not found, offers to open python.org.

!macro customInstall
  ; Check if Python 3.11+ is available
  nsExec::ExecToStack '"python" --version'
  Pop $0  ; exit code
  Pop $1  ; output

  ${If} $0 != 0
    ; python not found — try python3
    nsExec::ExecToStack '"python3" --version'
    Pop $0
    Pop $1
  ${EndIf}

  ${If} $0 != 0
    MessageBox MB_YESNO|MB_ICONINFORMATION \
      "Python 3.11 or newer is required to run Odysseus.$\n$\nIt was not detected on your system. Open python.org to download it?$\n$\n(Odysseus will finish installing. Run it after installing Python.)" \
      IDNO done
    ExecShell "open" "https://www.python.org/downloads/"
  ${EndIf}

  done:
!macroend
