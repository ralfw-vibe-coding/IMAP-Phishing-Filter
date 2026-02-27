# IMAP Phishing Filter (Desktop UI MVP)

This is a Tauri + React desktop UI that can:

- manage IMAP accounts (stored as JSON in the app data dir)
- store passwords in macOS Keychain (MVP: macOS only)
- start an **on-demand** scan by spawning the Node engine from the repo root and streaming logs into the UI

## Dev setup

1. Install JS deps for the UI:
   - `cd desktop && npm install`
2. Ensure the Node engine is built (repo root):
   - `npm install`
   - `npm run build` (creates `dist/scan.js`)
3. Run the desktop app:
   - `cd desktop && npm run tauri dev`

## Notes

- Passwords are stored in Keychain under service name `imap-phishing-filter`.
- The on-demand scan requires `AI_API_KEY` to be available in the environment of the process running the scan.

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
