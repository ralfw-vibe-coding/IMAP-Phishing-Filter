# PhishingKiller

PhishingKiller ist ein lokales IMAP-Phishing-Tool mit Desktop-UI (Tauri + React) und einer Node/TypeScript-Scan-Engine.

Was die App macht:
- überwacht IMAP-Postfächer (on-demand oder kontinuierlich via Polling),
- analysiert neue E-Mails mit einem OpenAI-Modell (`gpt-5-mini`),
- behandelt erkannte Phishing-Mails pro Konto entweder per Flag oder Verschieben in einen `Phishing`-Ordner,
- speichert `lastSeenUid`, damit bereits geprüfte Mails nicht erneut analysiert werden.

## Projektaufbau

- Root (`/`): Node/TypeScript-Engine (`scan.ts`, `phishingfilter.ts`, `ai.ts`).
- `desktop/`: Tauri Desktop-App (React UI + Rust Backend).
- `scripts/`: Build/Deploy-Helfer für macOS (`dist-mac.sh`, `deploy-mac.sh`).

## Als Entwickler starten

### 1) Voraussetzungen installieren

Im Repo-Root:

```bash
npm install
cd desktop && npm install
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
