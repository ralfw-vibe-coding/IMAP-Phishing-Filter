import type { AtomicKeyValueStore, AtomicRecord } from "./atomic-store.js";

type UpstashResponse<T> = {
  result?: T;
  error?: string;
};

const NULL_REV_SENTINEL = "__NULL__";

const CAS_LUA = `
local current = redis.call("GET", KEYS[1])
if (not current) then
  if ARGV[1] ~= "__NULL__" then
    return 0
  end
  redis.call("SET", KEYS[1], ARGV[2])
  return 1
end

local ok, decoded = pcall(cjson.decode, current)
if (not ok) then
  return -1
end

local currentRevision = decoded["revision"]
if (not currentRevision) then
  currentRevision = "__NULL__"
end

if currentRevision ~= ARGV[1] then
  return 0
end

redis.call("SET", KEYS[1], ARGV[2])
return 1
`;

export class UpstashAtomicStore implements AtomicKeyValueStore {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(args: { baseUrl: string; token: string }) {
    this.baseUrl = args.baseUrl.replace(/\/+$/, "");
    this.token = args.token;
  }

  private async command<T>(parts: Array<string | number>): Promise<T> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(parts),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Upstash command failed (${response.status}): ${text}`);
    }

    const payload = (await response.json()) as UpstashResponse<T>;
    if (typeof payload?.error === "string" && payload.error.length > 0) {
      throw new Error(`Upstash command error: ${payload.error}`);
    }
    return payload.result as T;
  }

  async get(key: string): Promise<AtomicRecord | null> {
    const raw = await this.command<string | null>(["GET", key]);
    if (raw === null) return null;

    try {
      const parsed = JSON.parse(raw) as AtomicRecord;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.value !== "string" ||
        typeof parsed.revision !== "string"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async compareAndSwap(
    key: string,
    expectedRevision: string | null,
    nextValue: string,
  ): Promise<{ ok: boolean; revision?: string }> {
    const revision = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const envelope: AtomicRecord = { value: nextValue, revision };
    const expected = expectedRevision ?? NULL_REV_SENTINEL;

    const result = await this.command<number>([
      "EVAL",
      CAS_LUA,
      1,
      key,
      expected,
      JSON.stringify(envelope),
    ]);

    if (result === 1) return { ok: true, revision };
    if (result === 0) return { ok: false };
    if (result === -1) {
      throw new Error(`Upstash CAS failed for key "${key}": stored payload is malformed`);
    }
    throw new Error(`Upstash CAS returned unexpected value: ${String(result)}`);
  }
}
