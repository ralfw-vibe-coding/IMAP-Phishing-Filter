export type LeaseProvider = {
  isLeaseActive(key: string): Promise<boolean>;
  tryAcquireLease(key: string, owner: string, ttlSeconds: number): Promise<boolean>;
  renewLease(key: string, owner: string, ttlSeconds: number): Promise<boolean>;
  releaseLease(key: string, owner: string): Promise<void>;
};
