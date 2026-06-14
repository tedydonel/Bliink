; Bliink NSIS installer hooks.
; Adds Windows Firewall rules so devices can find and connect to each other
; on the local network without the user having to click the firewall prompt
; (or run setup-firewall.ps1 by hand). Runs elevated because the installer is
; perMachine.

!macro NSIS_HOOK_POSTINSTALL
  ; Clear any rules from a previous install first (idempotent reinstalls).
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Bliink"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Bliink Discovery UDP"'

  ; Allow the app through the firewall for all traffic on every profile —
  ; covers transfer/chat TCP ports and the UDP discovery beacon.
  nsExec::Exec 'netsh advfirewall firewall add rule name="Bliink" dir=in action=allow program="$INSTDIR\bliink.exe" enable=yes profile=any'
  ; Belt-and-braces: explicitly allow the UDP discovery port.
  nsExec::Exec 'netsh advfirewall firewall add rule name="Bliink Discovery UDP" dir=in action=allow protocol=UDP localport=9001 profile=any'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove the firewall rules we created on install.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Bliink"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Bliink Discovery UDP"'
!macroend
