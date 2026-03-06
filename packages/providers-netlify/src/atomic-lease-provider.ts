import type { LeaseProvider } from "../../body/src/index.js";
import type { AtomicKeyValueStore } from "./atomic-store.js";

type LeaseValue = {
  owner: string;
  lockedUntilUnixMs: number;
};

function nowMs(): number {
  return Date.now();
}

function parseLease(raw: string): LeaseValue | null {
  try {
    const parsed = JSON.parse(raw) as LeaseValue;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.owner !== "string") return null;
    if (!Number.isFinite(parsed.lockedUntilUnixMs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export class AtomicLeaseProvider implements LeaseProvider {
  constructor(private readonly store: AtomicKeyValueStore) {}

  async isLeaseActive(key: string): Promise<boolean> {
    const current = await this.store.get(key);
    if (!current) return false;
    const lease = parseLease(current.value);
    if (!lease) return false;
    return lease.lockedUntilUnixMs > nowMs();
  }

  async tryAcquireLease(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const current = await this.store.get(key);
    const lease = current ? parseLease(current.value) : null;
    const ms = Math.max(1, ttlSeconds) * 1000;

    const lockedAndOtherOwner = lease && lease.lockedUntilUnixMs > nowMs() && lease.owner !== owner;
    if (lockedAndOtherOwner) return false;

    const next: LeaseValue = {
      owner,
      lockedUntilUnixMs: nowMs() + ms,
    };
    const cas = await this.store.compareAndSwap(
      key,
      current?.revision ?? null,
      JSON.stringify(next),
    );
    return cas.ok;
  }

  async renewLease(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const current = await this.store.get(key);
    if (!current) return false;
    const lease = parseLease(current.value);
    if (!lease) return false;
    if (lease.owner !== owner) return false;
    if (lease.lockedUntilUnixMs <= nowMs()) return false;

    const ms = Math.max(1, ttlSeconds) * 1000;
    const next: LeaseValue = {
      owner,
      lockedUntilUnixMs: nowMs() + ms,
    };

    const cas = await this.store.compareAndSwap(key, current.revision, JSON.stringify(next));
    return cas.ok;
  }

  async releaseLease(key: string, owner: string): Promise<void> {
    const current = await this.store.get(key);
    if (!current) return;
    const lease = parseLease(current.value);
    if (!lease) return;
    if (lease.owner !== owner) return;
    const released: LeaseValue = { owner, lockedUntilUnixMs: 0 };
    await this.store.compareAndSwap(key, current.revision, JSON.stringify(released));
  }
}
