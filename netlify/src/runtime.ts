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

export const NETLIFY_VERSION_DISPLAY = "1.0.0.3";
const DEFAULT_NETLIFY_PROMPT_PATH = "/var/task/phishingdetection_prompt.txt";
const IMAP_ACCOUNTS_CONFIG_KEY = "config:imap_accounts";
const RUNTIME_CONFIG_KEY = "config:runtime";

type StoredImapAccount = {
  id: string;
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
  failedAccounts?: number;
  results?: Array<{
    accountId: string;
    processed: number;
    flagged: number;
    lastSeenUid: number | null;
    status?: "ok" | "error";
    message?: string;
  }>;
};

export type DashboardImapAccount = {
  id: string;
  label: string;
  server: string;
  user: string;
  folder: string;
  phishingTreatment: "flag" | "move_to_phishing_folder";
  phishingThreshold?: number;
  hasPassword: boolean;
};

export type DashboardRuntimeConfig = {
  logLevel: number;
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

function formatAccountId(n: number): string {
  return `acc-${String(Math.max(1, Math.floor(n))).padStart(2, "0")}`;
}

function nextAccountId(existingIds: string[]): string {
  let max = 0;
  for (const id of existingIds) {
    const m = /^acc-(\d+)$/i.exec(id.trim());
    if (!m) continue;
    const n = Number.parseInt(m[1] ?? "", 10);
    if (Number.isFinite(n) && n > max) {
      max = n;
    }
  }
  return formatAccountId(max + 1);
}

function normalizeLogLevel(value: unknown): number {
  const asNumber = typeof value === "number" ? value : Number.parseInt(String(value ?? "0"), 10);
  if (!Number.isFinite(asNumber)) return 0;
  return Math.max(0, Math.min(3, Math.floor(asNumber)));
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

function normalizeStoredAccounts(
  parsedUnknown: unknown,
  opts: { source: string; allowEmpty: boolean; missingIdMode: "auto_from_index" | "empty" },
): StoredImapAccount[] {
  if (!Array.isArray(parsedUnknown)) {
    throw new Error(`Invalid ${opts.source}: root value must be an array`);
  }
  if (!opts.allowEmpty && parsedUnknown.length === 0) {
    throw new Error(`Invalid ${opts.source}: at least one account is required`);
  }

  const usedIds = new Set<string>();

  return parsedUnknown.map((acc, idx) => {
    if (!acc || typeof acc !== "object") {
      throw new Error(`Invalid ${opts.source}: account[${idx}] must be an object`);
    }

    const shape = acc as Partial<StoredImapAccount>;
    const label = asNonEmptyString(shape.label, `account[${idx}].label`);
    const server = asNonEmptyString(shape.server, `account[${idx}].server`);
    const user = asNonEmptyString(shape.user, `account[${idx}].user`);
    const password = asNonEmptyString(shape.password, `account[${idx}].password`);
    const folder = asNonEmptyString(shape.folder, `account[${idx}].folder`);
    const explicitId = asOptionalString(shape.id, `account[${idx}].id`);
    const phishingTreatment = asOptionalTreatment(
      shape.phishingTreatment,
      `account[${idx}].phishingTreatment`,
    );
    const phishingThreshold = asOptionalNumber(
      shape.phishingThreshold,
      `account[${idx}].phishingThreshold`,
    );
    if (phishingThreshold !== undefined && (phishingThreshold < 0 || phishingThreshold > 1)) {
      throw new Error(`Invalid ${opts.source}: account[${idx}].phishingThreshold must be 0..1`);
    }

    const base = buildImapAccountConfigFromEnvShape({
      label,
      server,
      user,
      password,
      folder,
    });
    const id = explicitId ?? (
      opts.missingIdMode === "auto_from_index"
        ? formatAccountId(idx + 1)
        : ""
    );
    if (id && usedIds.has(id)) {
      throw new Error(`Invalid ${opts.source}: duplicate account id "${id}"`);
    }
    if (id) usedIds.add(id);

    return {
      id,
      label,
      server,
      user,
      password,
      folder,
      phishingTreatment: phishingTreatment ?? "flag",
      ...(typeof phishingThreshold === "number" ? { phishingThreshold } : {}),
    };
  });
}

function parseAccountsFromEnvVar(): StoredImapAccount[] {
  const raw = process.env.IMAP_ACCOUNTS;
  if (!raw) {
    throw new Error("Missing IMAP_ACCOUNTS environment variable");
  }

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid IMAP_ACCOUNTS: must be valid JSON (${(error as Error).message})`);
  }

  return normalizeStoredAccounts(parsedUnknown, {
    source: "IMAP_ACCOUNTS",
    allowEmpty: false,
    missingIdMode: "auto_from_index",
  });
}

function toAccountConfigs(accounts: StoredImapAccount[]): AccountConfig[] {
  return accounts.map((acc) => {
    const base = buildImapAccountConfigFromEnvShape({
      label: acc.label,
      server: acc.server,
      user: acc.user,
      password: acc.password,
      folder: acc.folder,
    });

    return {
      id: acc.id,
      label: base.label,
      host: base.host,
      port: base.port,
      secure: base.secure,
      user: base.user,
      password: base.password,
      folder: base.folder,
      phishingTreatment: acc.phishingTreatment ?? "flag",
      ...(typeof acc.phishingThreshold === "number" ? { phishingThreshold: acc.phishingThreshold } : {}),
    };
  });
}

async function loadStoredAccounts(): Promise<StoredImapAccount[]> {
  const fromStore = await readJsonRecord<unknown>(IMAP_ACCOUNTS_CONFIG_KEY);
  if (fromStore !== null) {
    return normalizeStoredAccounts(fromStore, {
      source: IMAP_ACCOUNTS_CONFIG_KEY,
      allowEmpty: true,
      missingIdMode: "auto_from_index",
    });
  }

  const envAccounts = parseAccountsFromEnvVar();
  await writeJsonRecord(IMAP_ACCOUNTS_CONFIG_KEY, envAccounts);
  return envAccounts;
}

async function writeStoredAccounts(accounts: StoredImapAccount[]): Promise<void> {
  await writeJsonRecord(IMAP_ACCOUNTS_CONFIG_KEY, accounts);
}

async function loadRuntimeConfig(): Promise<DashboardRuntimeConfig> {
  const fromStore = await readJsonRecord<{ logLevel?: unknown }>(RUNTIME_CONFIG_KEY);
  if (fromStore && Object.prototype.hasOwnProperty.call(fromStore, "logLevel")) {
    return { logLevel: normalizeLogLevel(fromStore.logLevel) };
  }
  return { logLevel: normalizeLogLevel(process.env.LOG_LEVEL ?? "0") };
}

async function writeRuntimeConfig(config: DashboardRuntimeConfig): Promise<void> {
  await writeJsonRecord(RUNTIME_CONFIG_KEY, { logLevel: normalizeLogLevel(config.logLevel) });
}

async function createRuntime() {
  const store = getStore();
  const lease = new AtomicLeaseProvider(store);
  const mailbox = new ImapflowMailboxProvider();
  const promptPath = process.env.PHISHING_PROMPT_PATH?.trim() || DEFAULT_NETLIFY_PROMPT_PATH;
  const ai = new OpenAiPhishingProvider({ promptPath });
  const state = new KvStateProvider(store, "state:lastSeen");
  const storedAccounts = await loadStoredAccounts();
  const accounts = toAccountConfigs(storedAccounts);
  const maxMessagesPerTick = Math.max(
    1,
    Number.parseInt(process.env.SCAN_MAX_MESSAGES_PER_TICK ?? "25", 10) || 25,
  );
  const leaseTtlSeconds = Math.max(
    60,
    Number.parseInt(process.env.SCAN_LEASE_TTL_SECONDS ?? "900", 10) || 900,
  );
  const runtimeConfig = await loadRuntimeConfig();
  const logLevel = runtimeConfig.logLevel;

  return {
    lease,
    mailbox,
    ai,
    state,
    accounts,
    storedAccounts,
    maxMessagesPerTick,
    leaseTtlSeconds,
    logLevel,
    runtimeConfig,
  };
}

function createLogger(logLevel: number, accountLabel: string): ScanLogger {
  const isMailSummaryLine = (message: string): boolean => message.trimStart().startsWith("from=");
  const isPhishingWarnLine = (message: string): boolean => message.includes("PHISHING:");

  return {
    info: (message, extra) => {
      // LOG_LEVEL=0: only per-mail summary lines.
      if (logLevel === 0 && !isMailSummaryLine(message)) {
        return;
      }
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
      // LOG_LEVEL=0: keep only phishing warnings.
      if (logLevel === 0 && !isPhishingWarnLine(message)) {
        return;
      }
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
  | {
    status: "ok";
    processedAccounts: number;
    failedAccounts: number;
    results: Array<
      | { accountId: string; status: "ok"; result: ScanResult }
      | { accountId: string; status: "error"; message: string; lastSeenUid: number | null }
    >;
  }
> {
  const runtime = await createRuntime();
  const leaseKey = "netlify:phishing-scan:global";
  const owner = `run_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  if (runtime.logLevel >= 2) {
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
      const results: Array<
        | { accountId: string; status: "ok"; result: ScanResult }
        | { accountId: string; status: "error"; message: string; lastSeenUid: number | null }
      > = [];
      for (const account of runtime.accounts) {
        const renewed = await runtime.lease.renewLease(leaseKey, owner, runtime.leaseTtlSeconds);
        if (!renewed && runtime.logLevel >= 3) {
          // eslint-disable-next-line no-console
          console.warn(`[bg] lease renew failed owner=${owner} account=${account.id}`);
        }
        if (runtime.logLevel >= 2) {
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
        if (runtime.logLevel >= 3) {
          deps.observer = {
            onProgress: (progress) => {
              // eslint-disable-next-line no-console
              console.log(`[scan][${account.label}] progress lastSeenUid=${progress.lastSeenUid}`);
            },
          };
        }

        try {
          const result = await runScan(request, deps);
          results.push({ accountId: account.id, status: "ok", result });
          if (runtime.logLevel >= 2) {
            // eslint-disable-next-line no-console
            console.log(
              `[bg] done account=${account.id} processed=${result.processed} flagged=${result.flagged} lastSeenUid=${result.lastSeenUid}`,
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const lastSeenUid = await runtime.state.getLastSeenUid(account.id);
          results.push({
            accountId: account.id,
            status: "error",
            message,
            lastSeenUid,
          });
          // Always log hard account failures, regardless of LOG_LEVEL.
          // eslint-disable-next-line no-console
          console.error(`[bg] account_error account=${account.id} message=${message}`);
        }
      }
      const failedAccounts = results.filter((r) => r.status === "error").length;
      return {
        status: "ok" as const,
        processedAccounts: runtime.accounts.length,
        failedAccounts,
        results,
      };
    },
    }).then(async (res) => {
      if (res.status === "busy") {
        if (runtime.logLevel >= 2) {
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
      if (runtime.logLevel >= 2) {
        // eslint-disable-next-line no-console
        console.log(`[bg] finished owner=${owner} processedAccounts=${res.value.processedAccounts}`);
      }
      if (res.value.failedAccounts > 0) {
        // eslint-disable-next-line no-console
        console.error(
          `[bg] finished_with_errors owner=${owner} failedAccounts=${res.value.failedAccounts}`,
        );
      }
      await writeJsonRecord("scan:status", {
        updatedAtUnixMs: Date.now(),
        status: "ok",
        owner,
        ...(res.value.failedAccounts > 0
          ? { message: `${res.value.failedAccounts} account(s) failed in last run` }
          : {}),
        processedAccounts: res.value.processedAccounts,
        failedAccounts: res.value.failedAccounts,
        results: res.value.results.map((r) => ({
          accountId: r.accountId,
          processed: r.status === "ok" ? r.result.processed : 0,
          flagged: r.status === "ok" ? r.result.flagged : 0,
          lastSeenUid: r.status === "ok" ? r.result.lastSeenUid : r.lastSeenUid,
          status: r.status,
          ...(r.status === "error" ? { message: r.message } : {}),
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
  const runtime = await createRuntime();
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
  const runtime = await createRuntime();
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

export async function getDashboardRuntimeConfig(): Promise<DashboardRuntimeConfig> {
  return loadRuntimeConfig();
}

export async function setDashboardRuntimeConfig(input: Partial<DashboardRuntimeConfig>): Promise<DashboardRuntimeConfig> {
  const next = {
    logLevel: normalizeLogLevel(input.logLevel ?? 0),
  };
  await writeRuntimeConfig(next);
  return next;
}

export async function listDashboardAccounts(): Promise<DashboardImapAccount[]> {
  const accounts = await loadStoredAccounts();
  return accounts.map((acc) => ({
    id: acc.id,
    label: acc.label,
    server: acc.server,
    user: acc.user,
    folder: acc.folder,
    phishingTreatment: acc.phishingTreatment ?? "flag",
    ...(typeof acc.phishingThreshold === "number" ? { phishingThreshold: acc.phishingThreshold } : {}),
    hasPassword: Boolean(acc.password),
  }));
}

export async function createDashboardAccount(input: unknown): Promise<DashboardImapAccount> {
  const current = await loadStoredAccounts();
  const normalized = normalizeStoredAccounts([input], {
    source: "dashboard.create",
    allowEmpty: false,
    missingIdMode: "empty",
  })[0];
  if (!normalized) throw new Error("Invalid account payload");
  const account: StoredImapAccount = normalized.id.trim().length > 0
    ? normalized
    : { ...normalized, id: nextAccountId(current.map((acc) => acc.id)) };

  if (current.some((acc) => acc.id === account.id)) {
    throw new Error(`Account id already exists: ${account.id}`);
  }
  current.push(account);
  await writeStoredAccounts(current);

  return {
    id: account.id,
    label: account.label,
    server: account.server,
    user: account.user,
    folder: account.folder,
    phishingTreatment: account.phishingTreatment ?? "flag",
    ...(typeof account.phishingThreshold === "number" ? { phishingThreshold: account.phishingThreshold } : {}),
    hasPassword: Boolean(account.password),
  };
}

export async function updateDashboardAccount(accountId: string, input: unknown): Promise<DashboardImapAccount> {
  const id = asNonEmptyString(accountId, "accountId");
  const normalized = normalizeStoredAccounts([input], {
    source: "dashboard.update",
    allowEmpty: false,
    missingIdMode: "empty",
  })[0];
  if (!normalized) throw new Error("Invalid account payload");
  const updated: StoredImapAccount = { ...normalized, id };

  const current = await loadStoredAccounts();
  const index = current.findIndex((acc) => acc.id === id);
  if (index < 0) {
    throw new Error(`Account not found: ${id}`);
  }
  current[index] = updated;
  await writeStoredAccounts(current);

  return {
    id: updated.id,
    label: updated.label,
    server: updated.server,
    user: updated.user,
    folder: updated.folder,
    phishingTreatment: updated.phishingTreatment ?? "flag",
    ...(typeof updated.phishingThreshold === "number" ? { phishingThreshold: updated.phishingThreshold } : {}),
    hasPassword: Boolean(updated.password),
  };
}

export async function deleteDashboardAccount(accountId: string): Promise<void> {
  const id = asNonEmptyString(accountId, "accountId");
  const current = await loadStoredAccounts();
  const next = current.filter((acc) => acc.id !== id);
  if (next.length === current.length) {
    throw new Error(`Account not found: ${id}`);
  }
  await writeStoredAccounts(next);
}

export async function setHealthAlertArmed(armed: boolean): Promise<void> {
  await writeJsonRecord("health:alert_armed", {
    updatedAtUnixMs: Date.now(),
    armed,
  });
}
