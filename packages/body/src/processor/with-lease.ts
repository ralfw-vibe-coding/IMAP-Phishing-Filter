import type { LeaseProvider } from "../contracts/lease.js";

type LeaseRunResult<T> =
  | { status: "busy" }
  | { status: "acquired"; value: T };

export async function runWithLease<T>(
  lease: LeaseProvider,
  args: {
    key: string;
    owner: string;
    ttlSeconds: number;
    task: () => Promise<T>;
  },
): Promise<LeaseRunResult<T>> {
  const acquired = await lease.tryAcquireLease(args.key, args.owner, args.ttlSeconds);
  if (!acquired) return { status: "busy" };

  try {
    const value = await args.task();
    return { status: "acquired", value };
  } finally {
    await lease.releaseLease(args.key, args.owner);
  }
}
