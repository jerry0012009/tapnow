import type { BackupCheckpoint, BackupRunStatus, BackupScope } from "./types";

export function createCheckpoint(
  backupId: string,
  runId: string,
  scope: BackupScope
): BackupCheckpoint {
  return {
    version: 1,
    backupId,
    runId,
    status: "preflight",
    scope,
    nextAssetIndex: 0,
    committedBytes: 0,
    pendingAssetIds: [],
    failedAssetIds: [],
    budget: null,
    updatedAt: new Date().toISOString()
  };
}

export function transitionCheckpoint(
  checkpoint: BackupCheckpoint,
  status: BackupRunStatus,
  patch: Partial<BackupCheckpoint> = {}
): BackupCheckpoint {
  return {
    ...checkpoint,
    ...patch,
    status,
    updatedAt: new Date().toISOString()
  };
}
