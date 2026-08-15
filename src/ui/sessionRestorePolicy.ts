export const SESSION_RESTORE_BATCH_SIZE = 8;

export function shouldYieldAfterRestoreBlock(blocksSinceYield: number): boolean {
  return blocksSinceYield >= SESSION_RESTORE_BATCH_SIZE;
}
