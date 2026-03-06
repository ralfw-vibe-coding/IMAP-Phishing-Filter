import type { StateProvider } from "../../body/src/index.js";
import type { AtomicKeyValueStore } from "./atomic-store.js";

type LastSeenRecord = {
  lastSeenUid: number;
};

function parseLastSeen(raw: string): LastSeenRecord | null {
  try {
    const parsed = JSON.parse(raw) as LastSeenRecord;
    if (!parsed || typeof parsed !== "object") return null;
    if (!Number.isFinite(parsed.lastSeenUid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export class KvStateProvider implements StateProvider {
  constructor(
    private readonly store: AtomicKeyValueStore,
    private readonly prefix = "state:lastSeen",
  ) {}

  private key(accountId: string): string {
    return `${this.prefix}:${accountId}`;
  }

  async getLastSeenUid(accountId: string): Promise<number | null> {
    const current = await this.store.get(this.key(accountId));
    if (!current) return null;
    const parsed = parseLastSeen(current.value);
    if (!parsed) return null;
    return parsed.lastSeenUid;
  }

  async setLastSeenUid(accountId: string, uid: number): Promise<void> {
    const key = this.key(accountId);

    // CAS loop to avoid clobbering concurrent updates.
    for (let i = 0; i < 20; i += 1) {
      const current = await this.store.get(key);
      const next = JSON.stringify({ lastSeenUid: uid });
      const cas = await this.store.compareAndSwap(key, current?.revision ?? null, next);
      if (cas.ok) return;
    }

    throw new Error(`Failed to set lastSeenUid for account ${accountId}: CAS retries exhausted`);
  }
}
