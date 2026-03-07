Die Änderung der IMAP-Konten sollte durch ein Passwort geschützt werden.
Das Passwort wird in der Environment Variable `DASHBOARD_PASSWORD` gespeichert.
Sobald eine Änderung an den IMAP Konten durchgeführt werden soll, wird einmalig eine Autorisierung mit dem Passwort eingefordert.
Die Autorisierung gilt nur so lange, wie das Dashboard einmal geladen wurde. Wird die Seite erneut geladen, muss auch wieder neu autorisiert werden.