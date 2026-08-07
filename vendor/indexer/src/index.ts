export {
  type CursorState,
  type CursorStore,
  decideStart,
  EMPTY_CURSOR,
  MemoryCursorStore,
  type RangeCommit,
  type StartDecision,
} from "./cursor.js";
export {
  type AbiEventEntry,
  type CoverageResult,
  checkCoverage,
  checkSignatureDrift,
  type DecodedEvent,
  decodeFingerprint,
  defineDecodeSurface,
  eventSignature,
  type IgnoredEvent,
} from "./decode.js";
export {
  buildIdentity,
  decideResume,
  estimateReindexSeconds,
  normaliseSource,
  type ResumeDecision,
} from "./durability.js";
export {
  dedupe,
  type EventIdentity,
  eventKey,
  findDuplicates,
  findUnsafeIncrements,
  IDEMPOTENT_EVENT_DDL,
} from "./idempotent.js";
export {
  type BackfillPlan,
  type MigrationSummary,
  planBackfill,
  planMigration,
  rewritesExistingRows,
} from "./migrate.js";
export {
  type BlockReconciliation,
  type CoverageReport,
  checkEventCounts,
  reconcileBlock,
  reconcileRange,
} from "./reconcile.js";
export {
  type BlockRef,
  BlockWindow,
  detectReorg,
  type ReorgCheck,
  readBlockRef,
} from "./reorg.js";
