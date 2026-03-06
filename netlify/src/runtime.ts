import {
  runScan, runWithLease, type AccountConfig, type ScanLogger, type ScanRequest, type ScanResult,
} from "../../packages/body/src/index.js";
import {
  AtomicLeaseProvider,
  FileAtomicStore,
  InMemoryAtomicStore,
  KvStateProvider,
  UpstashAtomicStore,
  type AtomicKeyValueStore,
} from "../../packages/providers-netlify/src/index.js";
import { ImapflowMailboxProvider, OpenAiPhishingProvider } from "../../packages/providers-node/src/index.js";
import { buildImapAccountConfigFromEnvShape } from "../../imap.js";

export const NETLIFY_VERSION_DISPLAY = "1.0.0.0";
const DEFAULT_NETLIFY_PROMPT_PATH = "/var/task/phishingdetection_prompt.txt";

type EnvAccountShape = {
  id?: string;
  label: string;
  server: string;
  user: string;
  password: string;
  folder: string;
  phishingTreatment?: "flag" | "move_to_phishing_folder";
  phishingThreshold?: number;
};

type RunStatusRecord = {
  updatedAtUnixMs: number;
  status: "idle" | "running" | "busy" | "ok" | "error";
  owner?: string;
  message?: string;
  processedAccounts?: number;
  results?: Array<{ accountId: string; processed: number; flagged: number; lastSeenUid: number }>;
};

function asNonEmptyString(
  value: unknown,
  path: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid IMAP_ACCOUNTS: ${path} must be a non-empty string`);
  }
  return value.trim();
}

function asOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid IMAP_ACCOUNTS: ${path} must be a string when provided`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asOptionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid IMAP_ACCOUNTS: ${path} must be a finite number when provided`);
  }
  return value;
}

function asOptionalTreatment(
  value: unknown,
  path: string,
): "flag" | "move_to_phishing_folder" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "flag" || value === "move_to_phishing_folder") return value;
  throw new Error(
    `Invalid IMAP_ACCOUNTS: ${path} must be "flag" or "move_to_phishing_folder"`,
  );
}

let storeSingleton: AtomicKeyValueStore | null = null;
let storeKindSingleton: "upstash" | "file" | "memory" | null = null;

function createStoreFromEnv(): AtomicKeyValueStore {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (upstashUrl && upstashToken) {
    storeKindSingleton = "upstash";
    return new UpstashAtomicStore({
      baseUrl: upstashUrl,
      token: upstashToken,
    });
  }

  const filePath = process.env.NETLIFY_ATOMIC_STORE_FILE?.trim();
  if (filePath) {
    storeKindSingleton = "file";
    return new FileAtomicStore(filePath);
  }

  // Best-effort default for serverless environments. /tmp is writable on Netlify functions.
  // This is still instance-local and not a globally consistent datastore.
  if (typeof process !== "undefined") {
    storeKindSingleton = "file";
    return new FileAtomicStore("/tmp/phishingkiller-atomic-store.json");
  }

  storeKindSingleton = "memory";
  return new InMemoryAtomicStore();
}

function getStore(): AtomicKeyValueStore {
  if (storeSingleton) return storeSingleton;
  storeSingleton = createStoreFromEnv();
  return storeSingleton;
}

async function writeJsonRecord(key: string, value: unknown): Promise<void> {
  const store = getStore();
  for (let i = 0; i < 20; i += 1) {
    const current = await store.get(key);
    const cas = await store.compareAndSwap(key, current?.revision ?? null, JSON.stringify(value));
    if (cas.ok) return;
  }
  throw new Error(`Failed to write record: ${key}`);
}

async function readJsonRecord<T>(key: string): Promise<T | null> {
  const store = getStore();
  const current = await store.get(key);
  if (!current) return null;
  try {
    return JSON.parse(current.value) as T;
  } catch {
    return null;
  }
}

function parseAccounts(): AccountConfig[] {
  const raw = process.env.IMAP_ACCOUNTS;
  if (!raw) {
    throw new Error("Missing IMAP_ACCOUNTS environment variable");
  }

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid IMAP_ACCOUNTS: must be valid JSON (${(error as Error).message})`,
    );
  }

  if (!Array.isArray(parsedUnknown)) {
    throw new Error("Invalid IMAP_ACCOUNTS: root value must be an array");
  }

  if (parsedUnknown.length === 0) {
    throw new Error("Invalid IMAP_ACCOUNTS: at least one account is required");
  }

  const parsed = parsedUnknown as EnvAccountShape[];
  const usedIds = new Set<string>();

  return parsed.map((acc, idx) => {
    if (!acc || typeof acc !== "object") {
      throw new Error(`Invalid IMAP_ACCOUNTS: account[${idx}] must be an object`);
    }

    const label = asNonEmptyString(acc.label, `account[${idx}].label`);
    const server = asNonEmptyString(acc.server, `account[${idx}].server`);
    const user = asNonEmptyString(acc.user, `account[${idx}].user`);
    const password = asNonEmptyString(acc.password, `account[${idx}].password`);
    const folder = asNonEmptyString(acc.folder, `account[${idx}].folder`);
    const explicitId = asOptionalString(acc.id, `account[${idx}].id`);
    const phishingTreatment = asOptionalTreatment(
      acc.phishingTreatment,
      `account[${idx}].phishingTreatment`,
    );
    const phishingThreshold = asOptionalNumber(
      acc.phishingThreshold,
      `account[${idx}].phishingThreshold`,
    );
    if (phishingThreshold !== undefined && (phishingThreshold < 0 || phishingThreshold > 1)) {
      throw new Error(`Invalid IMAP_ACCOUNTS: account[${idx}].phishingThreshold must be 0..1`);
    }

    const base = buildImapAccountConfigFromEnvShape({
      label,
      server,
      user,
      password,
      folder,
    });

    const id = explicitId ?? `${base.user}@${base.host}:${base.port}|${base.folder}|${idx}`;
    if (usedIds.has(id)) {
      throw new Error(`Invalid IMAP_ACCOUNTS: duplicate account id "${id}"`);
    }
    usedIds.add(id);

    return {
      id,
      label: base.label,
      host: base.host,
      port: base.port,
      secure: base.secure,
      user: base.user,
      password: base.password,
      folder: base.folder,
      phishingTreatment: phishingTreatment ?? "flag",
      ...(typeof phishingThreshold === "number" ? { phishingThreshold } : {}),
    };
  });
}

function createRuntime() {
  const store = getStore();
  const lease = new AtomicLeaseProvider(store);
  const mailbox = new ImapflowMailboxProvider();
  const promptPath = process.env.PHISHING_PROMPT_PATH?.trim() || DEFAULT_NETLIFY_PROMPT_PATH;
  const ai = new OpenAiPhishingProvider({ promptPath });
  const state = new KvStateProvider(store, "state:lastSeen");
  const accounts = parseAccounts();
  const maxMessagesPerTick = Math.max(
    1,
    Number.parseInt(process.env.SCAN_MAX_MESSAGES_PER_TICK ?? "25", 10) || 25,
  );
  const leaseTtlSeconds = Math.max(
    60,
    Number.parseInt(process.env.SCAN_LEASE_TTL_SECONDS ?? "900", 10) || 900,
  );
  const logLevelRaw = Number.parseInt(process.env.LOG_LEVEL ?? "0", 10);
  const logLevel = Number.isFinite(logLevelRaw) ? Math.max(0, Math.min(2, logLevelRaw)) : 0;

  return { lease, mailbox, ai, state, accounts, maxMessagesPerTick, leaseTtlSeconds, logLevel };
}

function createLogger(logLevel: number, accountLabel: string): ScanLogger {
  return {
    info: (message, extra) => {
      // LOG_LEVEL=0: keep minimal scan logging (start, checked email lines, end).
      if (logLevel >= 0) {
        if (extra) {
          // eslint-disable-next-line no-console
          console.log(`[scan][${accountLabel}] ${message}`, extra);
        } else {
          // eslint-disable-next-line no-console
          console.log(`[scan][${accountLabel}] ${message}`);
        }
      }
    },
    warn: (message, extra) => {
      // keep phishing reasons visible in minimal mode.
      if (extra) {
        // eslint-disable-next-line no-console
        console.warn(`[scan][${accountLabel}] ${message}`, extra);
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[scan][${accountLabel}] ${message}`);
      }
    },
    error: (message, extra) => {
      if (extra) {
        // eslint-disable-next-line no-console
        console.error(`[scan][${accountLabel}] ${message}`, extra);
      } else {
        // eslint-disable-next-line no-console
        console.error(`[scan][${accountLabel}] ${message}`);
      }
    },
  };
}

export async function triggerBackgroundScan(baseUrl: string): Promise<void> {
  const target = `${baseUrl.replace(/\/+$/, "")}/.netlify/functions/scan-background`;
  const response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ reason: "scheduled_tick" }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to trigger background scan (${response.status}): ${text}`);
  }
}

export async function runBackgroundScan(): Promise<
  | { status: "busy" }
  | { status: "ok"; processedAccounts: number; results: Array<{ accountId: string; result: ScanResult }> }
> {
  const runtime = createRuntime();
  const leaseKey = "netlify:phishing-scan:global";
  const owner = `run_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  if (runtime.logLevel >= 1) {
    // eslint-disable-next-line no-console
    console.log(`[bg] start owner=${owner} accounts=${runtime.accounts.length}`);
  }
  await writeJsonRecord("scan:status", {
    updatedAtUnixMs: Date.now(),
    status: "running",
    owner,
    message: "Background scan started",
  } satisfies RunStatusRecord);

  try {
    return await runWithLease(runtime.lease, {
    key: leaseKey,
    owner,
    ttlSeconds: runtime.leaseTtlSeconds,
    task: async () => {
      const results: Array<{ accountId: string; result: ScanResult }> = [];
      for (const account of runtime.accounts) {
        const renewed = await runtime.lease.renewLease(leaseKey, owner, runtime.leaseTtlSeconds);
        if (!renewed && runtime.logLevel >= 2) {
          // eslint-disable-next-line no-console
          console.warn(`[bg] lease renew failed owner=${owner} account=${account.id}`);
        }
        if (runtime.logLevel >= 1) {
          // eslint-disable-next-line no-console
          console.log(`[bg] scanning account=${account.id} mode=since max=${runtime.maxMessagesPerTick}`);
        }

        const request: ScanRequest = {
          account,
          kind: "since",
          maxMessages: runtime.maxMessagesPerTick,
        };
        const deps: {
          mailbox: ImapflowMailboxProvider;
          ai: OpenAiPhishingProvider;
          state: KvStateProvider;
          logger: ScanLogger;
          observer?: { onProgress: (progress: { lastSeenUid: number }) => void };
        } = {
          mailbox: runtime.mailbox,
          ai: runtime.ai,
          state: runtime.state,
          logger: createLogger(runtime.logLevel, account.label),
        };
        if (runtime.logLevel >= 2) {
          deps.observer = {
            onProgress: (progress) => {
              // eslint-disable-next-line no-console
              console.log(`[scan][${account.label}] progress lastSeenUid=${progress.lastSeenUid}`);
            },
          };
        }

        const result = await runScan(request, deps);
        results.push({ accountId: account.id, result });
        if (runtime.logLevel >= 1) {
          // eslint-disable-next-line no-console
          console.log(
            `[bg] done account=${account.id} processed=${result.processed} flagged=${result.flagged} lastSeenUid=${result.lastSeenUid}`,
          );
        }
      }
      return { status: "ok" as const, processedAccounts: runtime.accounts.length, results };
    },
    }).then(async (res) => {
      if (res.status === "busy") {
        if (runtime.logLevel >= 1) {
          // eslint-disable-next-line no-console
          console.log(`[bg] skipped owner=${owner} reason=busy`);
        }
        await writeJsonRecord("scan:status", {
          updatedAtUnixMs: Date.now(),
          status: "busy",
          owner,
          message: "Skipped because another run still holds the lease",
        } satisfies RunStatusRecord);
        return { status: "busy" as const };
      }
      if (runtime.logLevel >= 1) {
        // eslint-disable-next-line no-console
        console.log(`[bg] finished owner=${owner} processedAccounts=${res.value.processedAccounts}`);
      }
      await writeJsonRecord("scan:status", {
        updatedAtUnixMs: Date.now(),
        status: "ok",
        owner,
        processedAccounts: res.value.processedAccounts,
        results: res.value.results.map((r) => ({
          accountId: r.accountId,
          processed: r.result.processed,
          flagged: r.result.flagged,
          lastSeenUid: r.result.lastSeenUid,
        })),
      } satisfies RunStatusRecord);
      return res.value;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeJsonRecord("scan:status", {
      updatedAtUnixMs: Date.now(),
      status: "error",
      owner,
      message,
    } satisfies RunStatusRecord);
    throw error;
  }
}

export async function isBackgroundBusy(): Promise<boolean> {
  const runtime = createRuntime();
  return runtime.lease.isLeaseActive("netlify:phishing-scan:global");
}

export async function getScanStatus(): Promise<{
  version: string;
  storeKind: "upstash" | "file" | "memory";
  upstashConfigured: boolean;
  nowUnixMs: number;
  busy: boolean;
  status: RunStatusRecord | null;
  accounts: Array<{ accountId: string; label: string; lastSeenUid: number | null }>;
}> {
  const runtime = createRuntime();
  const busy = await runtime.lease.isLeaseActive("netlify:phishing-scan:global");
  const status = await readJsonRecord<RunStatusRecord>("scan:status");

  const accounts = await Promise.all(
    runtime.accounts.map(async (acc) => ({
      accountId: acc.id,
      label: acc.label,
      lastSeenUid: await runtime.state.getLastSeenUid(acc.id),
    })),
  );

  return {
    version: NETLIFY_VERSION_DISPLAY,
    storeKind: storeKindSingleton ?? "memory",
    upstashConfigured:
      Boolean(process.env.UPSTASH_REDIS_REST_URL?.trim()) &&
      Boolean(process.env.UPSTASH_REDIS_REST_TOKEN?.trim()),
    nowUnixMs: Date.now(),
    busy,
    status,
    accounts,
  };
}
