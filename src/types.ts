// 领域模型：样本 — 视野记录 — 复核批次，以及离线同步所需的版本与冲突结构

export type Role = "teacher" | "admin";
export type RecordStatus = "valid" | "pending" | "conflict";
export type BatchStatus = "open" | "archived";

/** 单个字段的一次版本。at 为逻辑时钟，wall 为墙上时间（仅展示用） */
export interface FieldVersion {
  value: string;
  author: Role;
  authorName: string;
  at: number;
  wall: number;
}

/** 同一字段被两边修改时保留的两版 */
export interface ConflictEntry {
  id: string;
  field: string;
  base: FieldVersion | null; // 离线方修改时基于的版本
  committed: FieldVersion; // 服务端（已合并）版本
  incoming: FieldVersion; // 后到的离线版本
  resolved: boolean;
  resolution?: "committed" | "incoming";
  resolvedBy?: string;
  resolvedAt?: number;
}

export interface ObservationRecord {
  id: string;
  sampleId: string;
  batchId: string;
  /** 记录生效时对应的样本染色版本；与样本当前版本不一致即退回待复核 */
  stainVersion: number;
  fields: Record<string, FieldVersion>;
  conflicts: ConflictEntry[];
  status: RecordStatus;
  invalidReason?: string;
  createdBy: string;
  createdAt: number;
}

export interface Sample {
  id: string;
  name: string;
  type: string;
  stainMethod: string;
  /** 染色方式每改一次 +1，用于让关联记录失效 */
  stainVersion: number;
}

export interface ReviewBatch {
  id: string;
  name: string;
  status: BatchStatus;
  createdBy: string;
  createdAt: number;
  archivedBy?: string;
  archivedAt?: number;
}

/** 离线期间积压在本地 outbox 的操作 */
export type Op =
  | {
      id: string;
      kind: "field.update";
      recordId: string;
      field: string;
      value: FieldVersion;
      base: FieldVersion | null;
      actor: Role;
      actorName: string;
      applied: boolean;
      createdAt: number;
    }
  | {
      id: string;
      kind: "record.create";
      record: ObservationRecord;
      actor: Role;
      actorName: string;
      applied: boolean;
      createdAt: number;
    }
  | {
      id: string;
      kind: "batch.create";
      batch: ReviewBatch;
      actor: Role;
      actorName: string;
      applied: boolean;
      createdAt: number;
    };

export interface SyncLogEntry {
  opId: string;
  kind: Op["kind"];
  label: string;
  result: "applied" | "conflict" | "rejected";
  note?: string;
}

export interface DB {
  samples: Sample[];
  records: ObservationRecord[];
  batches: ReviewBatch[];
  outbox: Op[];
  clock: number;
  online: boolean;
  role: Role;
  actorName: string;
  lastSync: { at: number; entries: SyncLogEntry[] } | null;
}

export const RECORD_FIELDS = ["染色方式", "放大倍数", "观察结构", "视野描述"] as const;

export const STAIN_OPTIONS = [
  "碘液",
  "瑞氏染色",
  "革兰氏染色",
  "亚甲基蓝",
  "苏木精-伊红",
  "活体观察",
] as const;
