import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AtomicKeyValueStore, AtomicRecord } from "./atomic-store.js";

type FileData = Record<string, AtomicRecord>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

async function readData(path: string): Promise<FileData> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as FileData;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

async function writeDataAtomic(path: string, data: FileData): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmp, JSON.stringify(data), "utf8");
  await rename(tmp, path);
}

export class FileAtomicStore implements AtomicKeyValueStore {
  private readonly lockPath: string;

  constructor(private readonly filePath: string) {
    this.lockPath = `${filePath}.lock`;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await ensureDir(this.filePath);

    for (let i = 0; i < 100; i += 1) {
      try {
        await writeFile(this.lockPath, String(process.pid), { flag: "wx" });
        try {
          return await fn();
        } finally {
          await rm(this.lockPath, { force: true });
        }
      } catch {
        await sleep(25);
      }
    }

    throw new Error(`Failed to acquire file lock: ${this.lockPath}`);
  }

  async get(key: string): Promise<AtomicRecord | null> {
    return this.withLock(async () => {
      const data = await readData(this.filePath);
      return data[key] ?? null;
    });
  }

  async compareAndSwap(
    key: string,
    expectedRevision: string | null,
    nextValue: string,
  ): Promise<{ ok: boolean; revision?: string }> {
    return this.withLock(async () => {
      const data = await readData(this.filePath);
      const prev = data[key] ?? null;
      const prevRevision = prev?.revision ?? null;
      if (prevRevision !== expectedRevision) {
        return { ok: false };
      }

      const revision = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      data[key] = { value: nextValue, revision };
      await writeDataAtomic(this.filePath, data);
      return { ok: true, revision };
    });
  }
}
