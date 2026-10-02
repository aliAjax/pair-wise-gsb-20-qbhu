// 领域类型：样本、视野记录、复核批次、离线合并与冲突

export type Role = "teacher" | "admin";

/** 样本上可被离线合并的字段 */
export type SampleFieldKey = "name" | "specimenType" | "staining";
/** 视野记录上可被离线合并的字段 */
export type RecordFieldKey = "structure" | "magnification" | "description";
export type MergeableField = SampleFieldKey | RecordFieldKey;

export const FIELD_LABELS: Record<MergeableField, string> = {
  name: "样本名称",
  specimenType: "样本类型",
  staining: "染色方式",
  structure: "观察结构",
  magnification: "放大倍数",
  description: "视野描述",
};

export const ROLE_LABELS: Record<Role, string> = {
  teacher: "实验课教师",
  admin: "实验管理员",
};

/** 逐字段版本号：合并时靠 rev 判断服务端字段是否被管理员先改过 */
export interface FieldVersion {
  value: string;
  rev: number;
  actor: Role;
  updatedAt: number;
}

export type FieldMap<K extends string> = Record<K, FieldVersion>;

export interface FieldConflict {
  id: string;
  entityId: string;
  entityName: string;
  field: MergeableField;
  /** 管理员/服务端版本（受保护，默认保留） */
  serverValue: string;
  serverRev: number;
  serverActor: Role;
  /** 后到的离线版本（不覆盖服务端，另存） */
  offlineValue: string;
  offlineRev: number;
  offlineActor: Role;
  status: "open" | "resolved";
  winner?: "server" | "offline";
  resolvedValue?: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface Sample {
  id: string;
  kind: "sample";
  fields: FieldMap<SampleFieldKey>;
  /** 染色方式版本：每次修改 +1，关联视野记录据此判定失效 */
  stainingRev: number;
  createdAt: number;
}

/** 复核状态：pending 待复核 / valid 已归档有效 / invalidated 染色变更退回待复核 */
export type ReviewStatus = "pending" | "valid" | "invalidated";

export interface FieldRecord {
  id: string;
  kind: "field";
  sampleId: string;
  /** staining 为建记录时的染色快照；染色方式改了就与样本对不上 */
  fields: FieldMap<RecordFieldKey> & { staining: FieldVersion };
  /** 建记录/重新复核时确认过的染色版本 */
  confirmedStainingRev: number;
  status: ReviewStatus;
  invalidateReason?: string;
  batchIds: string[];
  createdAt: number;
}

export type BatchStatus = "pending" | "archived";

export interface ReviewBatch {
  id: string;
  name: string;
  createdAt: number;
  createdBy: Role;
  status: BatchStatus;
  archivedAt?: number;
  archivedBy?: Role;
  /** 建批次时纳入的视野记录（归档后冻结） */
  entryIds: string[];
  draft?: boolean;
}

export interface ServerState {
  samples: Sample[];
  records: FieldRecord[];
  batches: ReviewBatch[];
  conflicts: FieldConflict[];
}

export type OutboxOp =
  | {
      id: string;
      type: "editField";
      entityId: string;
      field: MergeableField;
      value: string;
      /** 离线编辑所基于的字段版本 */
      baseRev: number;
      actor: Role;
      at: number;
    }
  | {
      id: string;
      type: "createRecord";
      recordId: string;
      sampleId: string;
      values: Record<RecordFieldKey, string>;
      stainingSnapshot: string;
      stainingRev: number;
      at: number;
    }
  | {
      id: string;
      type: "createBatch";
      batchId: string;
      name: string;
      entryIds: string[];
      at: number;
    }
  | {
      id: string;
      type: "requestReview";
      recordId: string;
      stainingSnapshot: string;
      stainingRev: number;
      at: number;
    };

export interface SyncReport {
  at: number;
  applied: number;
  conflicts: { id: string; entityName: string; field: MergeableField }[];
  skipped: string[];
  invalidated: { recordId: string; reason: string }[];
  notes: string[];
}

export interface LogEntry {
  id: string;
  at: number;
  text: string;
  kind: "info" | "warn" | "ok" | "danger";
}

export interface AppState {
  role: Role;
  online: boolean;
  server: ServerState;
  /** 断网时所基于的服务端快照，离线界面展示 快照+本地改动 */
  base: ServerState;
  outbox: OutboxOp[];
  draftRecords: FieldRecord[];
  draftBatches: ReviewBatch[];
  lastReport: SyncReport | null;
  log: LogEntry[];
}
