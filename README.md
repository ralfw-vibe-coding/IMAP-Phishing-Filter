# IMAP Phishing Filter (local first)

This is a small TypeScript/Node app that watches one or more IMAP folders using IMAP IDLE, parses new emails, runs a phishing check, and logs suspicious messages.

## Setup

1. Install deps:
   - `npm install`
2. Create `.env` from `.env.example` and set `IMAP_ACCOUNTS`.
3. Run locally:
   - `npm run dev`

If `npm run dev:tsx` fails with an esbuild platform mismatch (Rosetta vs native), use `npm run dev` (ts-node) or reinstall dependencies under the same CPU architecture as your Node.

## Notes

- No polling: uses IMAP IDLE.
- On first run, the app sets a **baseline UID** per account and does **not** process existing messages.
- On reconnect, it checks for messages that arrived since the last seen UID.
