export type AtomicRecord = {
  value: string;
  revision: string;
};

export type AtomicKeyValueStore = {
  get(key: string): Promise<AtomicRecord | null>;
  compareAndSwap(
    key: string,
    expectedRevision: string | null,
    nextValue: string,
  ): Promise<{ ok: boolean; revision?: string }>;
};

export class InMemoryAtomicStore implements AtomicKeyValueStore {
  private readonly data = new Map<string, AtomicRecord>();

  async get(key: string): Promise<AtomicRecord | null> {
    return this.data.get(key) ?? null;
  }

  async compareAndSwap(
    key: string,
    expectedRevision: string | null,
    nextValue: string,
  ): Promise<{ ok: boolean; revision?: string }> {
    const prev = this.data.get(key) ?? null;
    const prevRevision = prev?.revision ?? null;
    if (prevRevision !== expectedRevision) {
      return { ok: false };
    }

    const revision = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    this.data.set(key, { value: nextValue, revision });
    return { ok: true, revision };
  }
}
