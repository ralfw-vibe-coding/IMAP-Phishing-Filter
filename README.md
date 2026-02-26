# IMAP Phishing Filter (local first)

This is a small TypeScript/Node app that watches one or more IMAP folders using IMAP IDLE, parses new emails, runs a phishing check, and logs suspicious messages.

## Setup

1. Install deps:
   - `npm install`
2. Create `.env` from `.env.example` and set `IMAP_ACCOUNTS`.
3. Run locally:
   - `npm run dev`

If `npm run dev:tsx` fails with an esbuild platform mismatch (Rosetta vs native), either reinstall dependencies under the same CPU architecture as your Node, or just use `npm run dev` (build + run from `dist/`).

## Notes

- No polling: uses IMAP IDLE.
- On first run, the app sets a **baseline UID** per account and does **not** process existing messages.
- On reconnect, it checks for messages that arrived since the last seen UID.
- Phishing detection uses OpenAI model `gpt-5-mini` and loads the prompt template from `phishingdetection_prompt.txt`. Set `AI_API_KEY` in `.env`.
