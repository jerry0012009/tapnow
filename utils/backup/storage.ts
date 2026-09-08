import type { StorageBudget } from "./types";

export const STORAGE_BUDGET_FRACTION = 1 / 3;
export const STORAGE_SAFETY_RESERVE_BYTES = 512 * 1024 * 1024;

export function calculateStorageBudget(
  availableBytes: number,
  reservedBytes = STORAGE_SAFETY_RESERVE_BYTES
): StorageBudget {
  const safeAvailable = Math.max(0, Math.floor(availableBytes));
  const budgetBytes = Math.floor(safeAvailable * STORAGE_BUDGET_FRACTION);
  const usableBytes = Math.max(0, budgetBytes - Math.max(0, reservedBytes));
  return {
    availableBytes: safeAvailable,
    budgetBytes,
    reservedBytes: Math.max(0, reservedBytes),
    usableBytes,
    measuredAt: new Date().toISOString()
  };
}

export function canCommitBytes(
  budget: StorageBudget,
  committedBytes: number,
  nextBytes: number
): boolean {
  return (
    Number.isFinite(committedBytes) &&
    Number.isFinite(nextBytes) &&
    committedBytes >= 0 &&
    nextBytes >= 0 &&
    committedBytes + nextBytes <= budget.usableBytes
  );
}

export function storageBudgetError(
  budget: StorageBudget,
  committedBytes: number,
  nextBytes: number
): Error {
  return new Error(
    `storage-budget-exceeded: committed=${committedBytes} next=${nextBytes} usable=${budget.usableBytes}`
  );
}
