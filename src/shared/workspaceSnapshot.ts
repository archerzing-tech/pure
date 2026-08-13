export type WorkspaceSnapshotEntryKind = 'file' | 'directory';

export interface WorkspaceSnapshotEntry {
  path: string;
  existed: boolean;
  kind: WorkspaceSnapshotEntryKind;
  content?: string;
  afterContent?: string;
}

export interface WorkspaceSnapshotBatch {
  id: string;
  sessionId: string;
  workspace: string;
  toolName: string;
  createdAt: number;
  entries: WorkspaceSnapshotEntry[];
}

export interface WorkspaceRestoreResult {
  restored: boolean;
  batchId?: string;
  restoredPaths: string[];
  removedPaths: string[];
  conflicts: string[];
  message: string;
}

export interface WorkspaceSnapshotPort {
  getLatestWriteBatch(): WorkspaceSnapshotBatch | null;
  undoLastWriteBatch(): Promise<WorkspaceRestoreResult>;
}
