import "dotenv/config";
import { runScan, type AccountConfig, type ScanProgress, type ScanResult, type StateProvider } from "./packages/body/src/index.js";
import { ImapflowMailboxProvider, OpenAiPhishingProvider } from "./packages/providers-node/src/index.js";
import { buildImapAccountConfigFromEnvShape } from "./imap.js";

type EnvAccountShape = {
  label: string;
  server: string;
  user: string;
  password: string;
  folder: string;
};

function log(message: string) {
  // eslint-disable-next-line no-console
  console.log(message);
}

function scanResultLine(payload: unknown) {
  // This line is parsed by the desktop app. Keep it single-line.
  // eslint-disable-next-line no-console
  console.log(`@@SCAN_RESULT@@ ${JSON.stringify(payload)}`);
}

function scanProgressLine(payload: unknown) {
  // This line is parsed by the desktop app to persist progress even if the scan crashes.
  // eslint-disable-next-line no-console
  console.log(`@@SCAN_PROGRESS@@ ${JSON.stringify(payload)}`);
}

class InMemoryStateProvider implements StateProvider {
  private readonly lastSeenByAccountId = new Map<string, number>();

  constructor(args?: { initialAccountId?: string; initialLastSeenUid?: number | null }) {
    if (args?.initialAccountId && args.initialLastSeenUid && Number.isFinite(args.initialLastSeenUid)) {
      this.lastSeenByAccountId.set(args.initialAccountId, args.initialLastSeenUid);
    }
  }

  async getLastSeenUid(accountId: string): Promise<number | null> {
    return this.lastSeenByAccountId.get(accountId) ?? null;
  }

  async setLastSeenUid(accountId: string, uid: number): Promise<void> {
    this.lastSeenByAccountId.set(accountId, uid);
  }
}

function parseSinceUid(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function parseMaxMessages(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

async function main() {
  const raw = process.env.SCAN_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing SCAN_ACCOUNT_JSON env var");

  const scanKind = (process.env.SCAN_KIND ?? "latest").toLowerCase();
  const latestN = Math.max(1, Math.min(1000, Number.parseInt(process.env.SCAN_LATEST_N ?? "10", 10) || 10));
  const sinceUid = parseSinceUid(process.env.SCAN_SINCE_UID);
  const maxMessages = parseMaxMessages(process.env.SCAN_MAX_MESSAGES);
  const phishingAction = (process.env.SCAN_PHISHING_ACTION ?? "flag").toLowerCase();

  const account = JSON.parse(raw) as EnvAccountShape;
  const config = buildImapAccountConfigFromEnvShape(account);
  const accountConfig: AccountConfig = {
    id: `${config.user}@${config.host}:${config.port}|${config.folder}`,
    label: config.label,
    host: config.host,
    port: config.port,
    secure: config.secure,
    user: config.user,
    password: config.password,
    folder: config.folder,
    phishingTreatment: phishingAction === "move" ? "move_to_phishing_folder" : "flag",
  };

  const state = new InMemoryStateProvider({
    initialAccountId: accountConfig.id,
    initialLastSeenUid: sinceUid,
  });

  const observer = {
    onProgress(progress: ScanProgress) {
      scanProgressLine({ lastSeenUid: progress.lastSeenUid });
    },
    onResult(result: ScanResult) {
      scanResultLine(result);
    },
  };

  try {
    await runScan(
      {
        account: accountConfig,
        kind: scanKind === "since" ? "since" : "latest",
        latestN,
        sinceUid,
        maxMessages,
      },
      {
        mailbox: new ImapflowMailboxProvider(),
        ai: new OpenAiPhishingProvider(),
        state,
        observer,
        logger: {
          info: (message) => log(message),
          warn: (message) => log(message),
          error: (message) => log(message),
        },
      },
    );
  } catch {
    process.exit(1);
  }
}

void main();
