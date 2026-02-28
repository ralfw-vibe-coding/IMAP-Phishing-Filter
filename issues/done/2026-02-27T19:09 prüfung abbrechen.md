Eine gerade laufender Prüfung eines Postfachs sollte abgebrochen werden können.
Während die Prüfung läuft, kann ein roter "Stop!" Button angezeigt werden.
Wenn auf diesen geklickt wird, sollte die Prüfung abgebrochen werden.
Der Button sollte nur dann zu sehen sein, wenn eine Prüfung gerade läuft.

---
Erledigt:
- UI zeigt pro Account während `Scanning` einen roten `Stop!`-Button.
- Klick auf `Stop!` triggert einen neuen Tauri-Command `cancel_scan`, der den laufenden Node-Scan-Prozess beendet (per `child.kill()`), ohne die App zu crashen.
- Start eines zweiten Scans während bereits ein Scan läuft wird verhindert (Fehlermeldung aus Backend).
