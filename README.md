# PhishingKiller

PhishingKiller ist ein lokales IMAP-Phishing-Tool mit Desktop-UI (Tauri + React) und einer Node/TypeScript-Scan-Engine.

Was die App macht:
- überwacht IMAP-Postfächer (on-demand oder kontinuierlich via Polling),
- analysiert neue E-Mails mit einem OpenAI-Modell (`gpt-5-mini`),
- behandelt erkannte Phishing-Mails pro Konto entweder per Flag oder Verschieben in einen `Phishing`-Ordner,
- speichert `lastSeenUid`, damit bereits geprüfte Mails nicht erneut analysiert werden.

## Projektaufbau

- Root (`/`): Node/TypeScript-App + Workspaces.
- `packages/body/`: geteilte Fachlogik (Domain + Processor).
- `packages/providers-node/`: IMAP/OpenAI-Provider für Node-Umgebungen.
- `packages/providers-netlify/`: Persistenz-/Lease-Provider für Netlify.
- `desktop/`: Tauri Desktop-App (React UI + Rust Backend).
- `netlify/`: Netlify Functions (scheduled + background + status).
- `scripts/`: Build/Deploy-Helfer.

## Als Entwickler starten

### 1) Voraussetzungen installieren

Im Repo-Root:

```bash
npm install
```

### 2) Umgebungsvariablen setzen

`.env` im Repo-Root anlegen (oder von `.env.example` ableiten), insbesondere:
- `AI_API_KEY`
- IMAP-Kontodaten (werden in der Desktop-App verwaltet; Passwörter landen im Keychain)

### 3) Desktop-App im Dev-Modus starten

Im Repo-Root:

```bash
npm run desktop:dev
```

Das startet Vite + Tauri (`tauri dev`) und öffnet das App-Fenster.

## Distribution erstellen

Für macOS (aus Repo-Root):

```bash
npm run dist:mac
```

Details:
- baut die Node-Engine (`npm run build`),
- baut die Tauri-App als `.app` Bundle,
- Ausgabe typischerweise unter:
  - `desktop/src-tauri/target/release/bundle/macos/PhishingKiller.app`

Optional schneller Debug-Build:

```bash
PROFILE=debug npm run dist:mac
```

## Deployment auf macOS

### Option A: per Script (empfohlen)

```bash
npm run deploy:mac
```

Standard-Ziel ist `~/Applications`.

Optional anderes Ziel:

```bash
DEST_DIR=/Applications npm run deploy:mac
```

### Option B: manuell

1. `npm run dist:mac`
2. Finder öffnen:
   - `desktop/src-tauri/target/release/bundle/macos/PhishingKiller.app`
3. `.app` nach `~/Applications` oder `/Applications` ziehen.

## Netlify Deployment

Dieser Abschnitt beschreibt den Cloud-Betrieb über Netlify Functions:
- `scheduled-scan`: läuft jede Minute und stößt einen Lauf an.
- `scan-background`: führt den eigentlichen IMAP+KI-Scan aus.
- `scan-status`: gibt Status/Version/letzte Ergebnisse zurück.

### 1) Netlify Site verbinden

Im Netlify UI:
1. Repository verbinden.
2. **Base directory** auf `netlify` setzen.
3. Build/Publish-Felder können leer bleiben (Functions-only).
4. Deploy auslösen.

Hinweis:
- Der Scheduler ist in `netlify/netlify.toml` konfiguriert:
  - `schedule = "* * * * *"` (jede 60 Sekunden)

### 2) Upstash Redis einrichten (für gemeinsamen Zustand)

Warum:
- Ohne shared Store sehen verschiedene Function-Instanzen nicht denselben Zustand.
- Für `lastSeenUid`, Lock/Lease und Status ist ein gemeinsamer Store nötig.

Schritte:
1. Bei Upstash eine Redis-DB anlegen.
2. Aus den DB-Details kopieren:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
3. Beide Werte in Netlify als Environment Variables eintragen.

### 3) Netlify Environment Variables setzen

Pflicht:
- `AI_API_KEY`
- `IMAP_ACCOUNTS` (JSON-Array mit 1..n Konten)
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Empfohlen:
- `LOG_LEVEL=0` (minimales Logging)
- `SCAN_MAX_MESSAGES_PER_TICK=25`
- `SCAN_LEASE_TTL_SECONDS=900`

Beispiel für `IMAP_ACCOUNTS`:

```json
[
  {
    "id": "acc-1",
    "label": "ralfw",
    "server": "imap.example.com:993",
    "user": "info@example.com",
    "password": "secret",
    "folder": "INBOX",
    "phishingTreatment": "flag",
    "phishingThreshold": 0.5
  },
  {
    "id": "acc-2",
    "label": "ralf@wwe",
    "server": "imaps://mail.example.net:993",
    "user": "info@example.net",
    "password": "secret2",
    "folder": "INBOX",
    "phishingTreatment": "move_to_phishing_folder"
  }
]
```

### 4) Verifizieren per curl

Bekannte Basis-URL:

```bash
BASE="https://<project name>.netlify.app"
```

Status prüfen:

```bash
curl -s "$BASE/.netlify/functions/scan-status" | jq
```

Manuellen Scan anstoßen:

```bash
curl -i -s -X POST "$BASE/.netlify/functions/scan-background"
```

Kompletter Testlauf:

```bash
BASE="https://<project name>.netlify.app"

echo "1) Status vorher"
curl -s "$BASE/.netlify/functions/scan-status" | jq

echo "2) Background Scan starten"
curl -i -s -X POST "$BASE/.netlify/functions/scan-background"

echo "3) Warten"
sleep 5

echo "4) Status nachher"
curl -s "$BASE/.netlify/functions/scan-status" | jq
```

Erwartung:
- `storeKind` ist `upstash`
- `upstashConfigured` ist `true`
- `status.status` wird `ok` (oder `busy`, falls ein Lauf bereits aktiv ist)
- `accounts[].lastSeenUid` enthält Zahlen statt `null`

### 5) Logs verstehen

Bei Netlify im Bereich `Functions`:
- `scheduled-scan`: Tick/Trigger/Skip-Logs des Schedulers.
- `scan-background`: eigentliche Scan-Logs pro Account.
- `scan-status`: reine Statusabfragen.

`LOG_LEVEL`:
- `0`: minimal (Start, geprüfte Mails, PHISHING-Gründe, Ende)
- `1`: zusätzlich Orchestrierungs-Logs
- `2`: zusätzlich Debug-Details

## Voraussetzungen für Betrieb

### macOS

Erforderlich:
- Node.js (empfohlen LTS, mindestens `>=18`, besser `>=20`)
- Netzwerkzugriff auf deinen IMAP-Server
- gültiger OpenAI API Key (`AI_API_KEY`)

Für Entwicklung/Build zusätzlich:
- Rust Toolchain (`rustup`, `cargo`)
- Xcode Command Line Tools oder Xcode
- akzeptierte Xcode-Lizenz:
  - `sudo xcodebuild -license`

Hinweise:
- Passwörter werden im macOS Keychain gespeichert.
- Beim Start aus Finder kann `PATH` eingeschränkt sein; die App sucht `node` an üblichen Pfaden (`/opt/homebrew/bin/node`, `/usr/local/bin/node`, `~/.nvm/...`, `~/.volta/bin/node` usw.).

### Windows

Der aktuelle Automations-Flow (`dist:mac` / `deploy:mac`) ist macOS-spezifisch.

Für Betrieb auf Windows brauchst du:
- Node.js (empfohlen LTS, mindestens `>=18`)
- OpenAI API Key und IMAP-Zugangsdaten
- einen nativen Tauri-Windows-Build (manuell mit `tauri build` auf Windows)

Für Entwicklung/Build auf Windows zusätzlich:
- Rust Toolchain
- Microsoft C++ Build Tools (Visual Studio Build Tools)
- WebView2 Runtime (normalerweise vorhanden auf aktuellen Windows-Versionen)
