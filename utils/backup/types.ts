export type BackupAssetStatus =
  | "discovered"
  | "queued"
  | "downloading"
  | "verified"
  | "derivative-only"
  | "retryable"
  | "unavailable-after-recovery"
  | "skip-listed"
  | "tombstone";

export type BackupRunStatus =
  | "preflight"
  | "running"
  | "paused"
  | "storage-budget-exceeded"
  | "completed"
  | "partial"
  | "failed";

export interface BackupScope {
  kind: "canvas" | "canvases" | "project" | "workspace";
  ids: string[];
  includeChildren: boolean;
}

export interface BackupAssetReference {
  referenceId: string;
  canvasId: string;
  nodeId: string | null;
  fieldPath: string;
  role: "current" | "input" | "alternative" | "history" | "preview" | "unknown";
  ordinal: number;
  fileId: string | null;
  url: string | null;
  source: "api" | "page" | "cache" | "runtime-observation";
  status: BackupAssetStatus;
}

export interface StorageBudget {
  availableBytes: number;
  budgetBytes: number;
  reservedBytes: number;
  usableBytes: number;
  measuredAt: string;
}

export interface BackupCheckpoint {
  version: 1;
  backupId: string;
  runId: string;
  status: BackupRunStatus;
  scope: BackupScope;
  nextAssetIndex: number;
  committedBytes: number;
  pendingAssetIds: string[];
  failedAssetIds: string[];
  budget: StorageBudget | null;
  updatedAt: string;
}
