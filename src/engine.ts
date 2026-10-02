import {
  AppState,
  BatchStatus,
  FieldConflict,
  FieldRecord,
  FieldVersion,
  LogEntry,
  MergeableField,
  OutboxOp,
  ReviewBatch,
  ReviewStatus,
  Role,
  Sample,
  SampleFieldKey,
  RecordFieldKey,
  ServerState,
  SyncReport,
  FIELD_LABELS,
} from "./types";

export const STORAGE_KEY = "hxwl-06-offline-state-v1";

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

function fv(value: string, actor: Role, rev = 1, updatedAt = Date.now()): FieldVersion {
  return { value, rev, actor, updatedAt };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function nowText(t: number): string {
  return new Date(t).toLocaleString("zh-CN", { hour12: false });
}

export function fieldOf(server: ServerState, entityId: string, field: MergeableField): FieldVersion | null {
  const sample = server.samples.find((s) => s.id === entityId);
  if (sample && field in sample.fields) {
    return (sample.fields as Record<string, FieldVersion>)[field];
  }
  const record = server.records.find((r) => r.id === entityId);
  if (record && field in record.fields) {
    return (record.fields as Record<string, FieldVersion>)[field];
  }
  return null;
}

export function findEntity(
  server: ServerState,
  entityId: string
): { entity: Sample | FieldRecord; kind: "sample" | "field" } | null {
  const sample = server.samples.find((s) => s.id === entityId);
  if (sample) return { entity: sample, kind: "sample" };
  const record = server.records.find((r) => r.id === entityId);
  if (record) return { entity: record, kind: "field" };
  return null;
}

export function entityName(s: Sample | FieldRecord, server: ServerState): string {
  if (s.kind === "sample") return s.fields.name.value;
  const sample = server.samples.find((x) => x.id === s.sampleId);
  return `${sample?.fields.name.value ?? "?"} / ${s.id.slice(-5)}`;
}

// ---------- 染色方式变更的级联：关联视野记录失效、退回待复核 ----------

/**
 * 样本的染色方式被修改后：
 * - 所有确认版本落后的关联记录退回 invalidated，从有效统计与未归档批次中摘除
 * - 归档批次冻结不动，但归档时/导出时会标注其中失效条目
 */
export function invalidateRecordsForStaining(server: ServerState, sample: Sample): string[] {
  const ids: string[] = [];
  const newStaining = sample.fields.staining.value;
  const newRev = sample.stainingRev;
  for (const record of server.records) {
    if (record.sampleId !== sample.id) continue;
    if (record.confirmedStainingRev >= newRev) continue;
    record.status = "invalidated";
    record.invalidateReason = `染色方式已由「${record.fields.staining.value}」改为「${newStaining}」，关联记录退回待复核`;
    record.fields.staining = { ...sample.fields.staining };
    ids.push(record.id);
    // 未归档批次中的条目摘除；归档批次保留冻结快照
    for (const batch of server.batches) {
      if (batch.status === "pending" && batch.entryIds.includes(record.id)) {
        batch.entryIds = batch.entryIds.filter((id) => id !== record.id);
      }
    }
  }
  return ids;
}

// ---------- 种子数据 ----------

export function seedState(): ServerState {
  const t = Date.now();
  const s1: Sample = {
    id: "sp_onion",
    kind: "sample",
    stainingRev: 1,
    createdAt: t - 86400000 * 3,
    fields: {
      name: fv("洋葱表皮", "teacher", 1, t - 86400000 * 3),
      specimenType: fv("植物组织", "teacher", 1, t - 86400000 * 3),
      staining: fv("碘液", "teacher", 1, t - 86400000 * 3),
    },
  };
  const s2: Sample = {
    id: "sp_blood",
    kind: "sample",
    stainingRev: 1,
    createdAt: t - 86400000 * 2,
    fields: {
      name: fv("人血涂片", "teacher", 1, t - 86400000 * 2),
      specimenType: fv("血液涂片", "teacher", 1, t - 86400000 * 2),
      staining: fv("瑞氏染色", "teacher", 1, t - 86400000 * 2),
    },
  };
  const s3: Sample = {
    id: "sp_paramecium",
    kind: "sample",
    stainingRev: 1,
    createdAt: t - 86400000,
    fields: {
      name: fv("草履虫", "teacher", 1, t - 86400000),
      specimenType: fv("微生物", "teacher", 1, t - 86400000),
      staining: fv("活体观察", "teacher", 1, t - 86400000),
    },
  };

  const mkRecord = (
    id: string,
    sample: Sample,
    structure: string,
    magnification: string,
    description: string,
    status: ReviewStatus,
    createdAgo: number
  ): FieldRecord => ({
    id,
    kind: "field",
    sampleId: sample.id,
    confirmedStainingRev: sample.stainingRev,
    status,
    batchIds: [],
    createdAt: t - createdAgo,
    fields: {
      structure: fv(structure, "teacher", 1, t - createdAgo),
      magnification: fv(magnification, "teacher", 1, t - createdAgo),
      description: fv(description, "teacher", 1, t - createdAgo),
      staining: { ...sample.fields.staining },
    },
  });

  const r1 = mkRecord("f_onion_1", s1, "细胞壁、细胞核", "400x", "细胞壁清晰，细胞核可见", "valid", 86400000 * 2);
  const r2 = mkRecord("f_blood_1", s2, "红细胞", "1000x", "红细胞分布均匀", "valid", 86400000);
  const r3 = mkRecord("f_para_1", s3, "纤毛、口沟", "200x", "纤毛运动明显", "pending", 3600000 * 5);
  const r4 = mkRecord("f_onion_2", s1, "液泡", "100x", "视野边缘可见大液泡轮廓", "pending", 3600000 * 2);

  const archivedBatch: ReviewBatch = {
    id: "rb_seed_1",
    name: "第 1 批 · 基础结构归档",
    createdAt: t - 3600000 * 20,
    createdBy: "teacher",
    status: "archived",
    archivedAt: t - 3600000 * 18,
    archivedBy: "admin",
    entryIds: ["f_onion_1", "f_blood_1"],
  };
  r1.batchIds = [archivedBatch.id];
  r2.batchIds = [archivedBatch.id];

  return {
    samples: [s1, s2, s3],
    records: [r1, r2, r3, r4],
    batches: [archivedBatch],
    conflicts: [],
  };
}

export function initialState(role: Role = "teacher"): AppState {
  const server = seedState();
  return {
    role,
    online: true,
    server,
    base: clone(server),
    outbox: [],
    draftRecords: [],
    draftBatches: [],
    lastReport: null,
    log: [
      {
        id: uid("log"),
        at: Date.now(),
        text: "系统就绪：样本、视野记录、复核批次已接通，本地改动将持久化保存",
        kind: "info",
      },
    ],
  };
}

// ---------- 在线直接改服务端 ----------

export function applyServerFieldEdit(
  server: ServerState,
  entityId: string,
  field: MergeableField,
  value: string,
  actor: Role
): { invalidated: FieldRecord[] } {
  const found = findEntity(server, entityId);
  if (!found) return { invalidated: [] };
  const cur = (found.entity.fields as Record<string, FieldVersion>)[field];
  if (cur && cur.value === value) return { invalidated: [] };
  const nv: FieldVersion = {
    value,
    rev: cur ? cur.rev + 1 : 1,
    actor,
    updatedAt: Date.now(),
  };
  (found.entity.fields as Record<string, FieldVersion>)[field] = nv;

  let invalidated: FieldRecord[] = [];
  if (found.kind === "sample" && field === "staining") {
    const sample = found.entity as Sample;
    sample.stainingRev += 1;
    const ids = invalidateRecordsForStaining(server, sample);
    invalidated = server.records.filter((r) => ids.includes(r.id));
  }
  return { invalidated };
}

/** 管理员处理冲突：选定保留版本；若最终染色方式发生变化，照样触发级联失效 */
export function resolveConflict(
  server: ServerState,
  conflictId: string,
  winner: "server" | "offline",
  actor: Role
): { ok: boolean; invalidated: FieldRecord[] } {
  const conflict = server.conflicts.find((c) => c.id === conflictId);
  if (!conflict || actor !== "admin") return { ok: false, invalidated: [] };
  const found = findEntity(server, conflict.entityId);
  if (!found) return { ok: false, invalidated: [] };

  // 选离线值才真正改变字段（服务端值本来就在）
  let invalidated: FieldRecord[] = [];
  if (winner === "offline") {
    const res = applyServerFieldEdit(
      server,
      conflict.entityId,
      conflict.field,
      conflict.offlineValue,
      "admin"
    );
    invalidated = res.invalidated;
  }
  conflict.status = "resolved";
  conflict.winner = winner;
  conflict.resolvedAt = Date.now();
  conflict.resolvedValue = winner === "server" ? conflict.serverValue : conflict.offlineValue;
  return { ok: true, invalidated };
}

// ---------- 复核批次 ----------

export function createBatch(
  server: ServerState,
  name: string,
  entryIds: string[],
  actor: Role,
  draft = false
): ReviewBatch {
  const batch: ReviewBatch = {
    id: uid("rb"),
    name,
    createdAt: Date.now(),
    createdBy: actor,
    status: "pending",
    entryIds: [],
    draft,
  };
  for (const id of entryIds) {
    const record = server.records.find((r) => r.id === id);
    if (!record || record.status !== "pending") continue;
    if (record.batchIds.some((bid) => server.batches.find((b) => b.id === bid)?.status === "pending")) {
      continue;
    }
    batch.entryIds.push(id);
    record.batchIds.push(batch.id);
  }
  server.batches.push(batch);
  return batch;
}

/** 只有管理员能确认归档；归档时若条目已被染色变更失效则摘除并说明 */
export function archiveBatch(
  server: ServerState,
  batchId: string
): { ok: boolean; archived: number; dropped: { id: string; reason: string }[]; reason?: string } {
  const batch = server.batches.find((b) => b.id === batchId);
  if (!batch) return { ok: false, archived: 0, dropped: [], reason: "批次不存在" };
  if (batch.status !== "pending") return { ok: false, archived: 0, dropped: [], reason: "批次已归档" };
  const dropped: { id: string; reason: string }[] = [];
  const keep: string[] = [];
  for (const id of batch.entryIds) {
    const record = server.records.find((r) => r.id === id);
    if (!record) {
      dropped.push({ id, reason: "记录已不存在" });
      continue;
    }
    if (record.status !== "pending") {
      dropped.push({ id, reason: record.invalidateReason ?? `状态为 ${record.status}，不再有效` });
      record.batchIds = record.batchIds.filter((x) => x !== batchId);
      continue;
    }
    keep.push(id);
  }
  batch.entryIds = keep;
  if (keep.length === 0) {
    return { ok: false, archived: 0, dropped, reason: "没有可归档的有效待复核条目" };
  }
  for (const id of keep) {
    const record = server.records.find((r) => r.id === id);
    if (record) record.status = "valid";
  }
  batch.status = "archived";
  batch.archivedAt = Date.now();
  batch.archivedBy = "admin";
  return { ok: true, archived: keep.length, dropped };
}

/** 教师对退回待复核的记录重新提交复核（确认现染色方式下重新观察） */
export function requestReview(server: ServerState, recordId: string): { ok: boolean; reason?: string } {
  const record = server.records.find((r) => r.id === recordId);
  if (!record) return { ok: false, reason: "记录不存在" };
  if (record.status !== "invalidated") return { ok: false, reason: "仅退回待复核的记录需要重新复核" };
  const sample = server.samples.find((s) => s.id === record.sampleId);
  if (!sample) return { ok: false, reason: "样本不存在" };
  record.status = "pending";
  record.invalidateReason = undefined;
  record.confirmedStainingRev = sample.stainingRev;
  record.fields.staining = { ...sample.fields.staining };
  return { ok: true };
}

// ---------- 离线同步：逐字段三路合并 ----------

function makeConflict(op: OutboxOp & { type: "editField" }, cur: FieldVersion): FieldConflict {
  return {
    id: uid("cf"),
    entityId: op.entityId,
    entityName: "",
    field: op.field,
    serverValue: cur.value,
    serverRev: cur.rev,
    serverActor: cur.actor,
    offlineValue: op.value,
    offlineRev: op.baseRev,
    offlineActor: op.actor,
    status: "open",
    createdAt: Date.now(),
  };
}

/**
 * 网络恢复后把 outbox 逐字段合并进服务端：
 * - 同字段离线未动、服务端动了（管理员优先）→ 保留服务端值，离线值另存为冲突
 * - 离线值与服务端相同 → 直接快进，不报冲突
 * - 只有离线动 → 直接覆盖快进
 * - 字段没动过 → 跳过
 */
export function runSync(state: AppState): { server: ServerState; report: SyncReport } {
  const server = clone(state.server);
  const draftRecordIds = new Set(state.draftRecords.map((r) => r.id));
  const report: SyncReport = { at: Date.now(), applied: 0, conflicts: [], skipped: [], invalidated: [], notes: [] };

  for (const op of state.outbox) {
    if (op.type === "createRecord") {
      if (server.records.some((r) => r.id === op.recordId)) {
        report.skipped.push(`${op.recordId} 已存在`);
        continue;
      }
      const sample = server.samples.find((s) => s.id === op.sampleId);
      if (!sample) {
        report.skipped.push(`新建视野记录失败：样本 ${op.sampleId} 不存在`);
        continue;
      }
      const t = op.at;
      const stainingCurrent = sample.fields.staining.value;
      // 离线建记录时基于的染色版本已落后（管理员在期间改了染色）→ 直接退回待复核
      const stale = op.stainingRev < sample.stainingRev;
      const record: FieldRecord = {
        id: op.recordId,
        kind: "field",
        sampleId: op.sampleId,
        confirmedStainingRev: op.stainingRev,
        status: stale ? "invalidated" : "pending",
        invalidateReason: stale
          ? `建记录时染色方式为「${op.stainingSnapshot}」，现管理员已改为「${stainingCurrent}」，退回待复核`
          : undefined,
        batchIds: [],
        createdAt: t,
        fields: {
          structure: fv(op.values.structure, "teacher", 1, t),
          magnification: fv(op.values.magnification, "teacher", 1, t),
          description: fv(op.values.description, "teacher", 1, t),
          staining: fv(stainingCurrent, "teacher", op.stainingRev, t),
        },
      };
      server.records.push(record);
      report.applied += 1;
      report.notes.push(`离线新建视野记录已上传（${sample.fields.name.value}）`);
      continue;
    }

    if (op.type === "createBatch") {
      if (server.batches.some((b) => b.id === op.batchId)) {
        report.skipped.push(`${op.batchId} 已存在`);
        continue;
      }
      const validEntries = op.entryIds
        .map((id) => server.records.find((r) => r.id === id))
        .filter((r): r is FieldRecord => !!r && r.status === "pending");
      const batch: ReviewBatch = {
        id: op.batchId,
        name: op.name,
        createdAt: op.at,
        createdBy: "teacher",
        status: "pending",
        entryIds: validEntries.map((r) => r.id),
      };
      for (const r of validEntries) r.batchIds.push(batch.id);
      server.batches.push(batch);
      report.applied += 1;
      if (validEntries.length !== op.entryIds.length) {
        report.notes.push(
          `批次「${op.name}」中有 ${op.entryIds.length - validEntries.length} 条因染色变更失效未纳入`
        );
      }
      continue;
    }

    if (op.type === "requestReview") {
      const record = server.records.find((r) => r.id === op.recordId);
      const sample = record ? server.samples.find((s) => s.id === record.sampleId) : null;
      if (!record || !sample) {
        report.skipped.push(`重新复核失败：记录 ${op.recordId} 不存在`);
        continue;
      }
      // 合并时再比一次：染色方式在离线期间又被改，重新复核无效
      if (op.stainingRev < sample.stainingRev) {
        report.notes.push(`记录 ${record.id} 的重新复核基于旧染色版本，仍保持退回待复核`);
        continue;
      }
      record.status = "pending";
      record.invalidateReason = undefined;
      record.confirmedStainingRev = sample.stainingRev;
      report.applied += 1;
      continue;
    }

    // editField
    if (draftRecordIds.has(op.entityId)) {
      // 作用于离线新建记录草稿：直接写到服务端新记录的对应字段
      const record = server.records.find((r) => r.id === op.entityId);
      if (!record) {
        report.skipped.push(`草稿记录 ${op.entityId} 尚未上传，字段修改随新建一并提交`);
        continue;
      }
      const f = (record.fields as Record<string, FieldVersion>)[op.field];
      if (f) {
        (record.fields as Record<string, FieldVersion>)[op.field] = {
          ...f,
          value: op.value,
          updatedAt: op.at,
          actor: op.actor,
        };
        report.applied += 1;
      }
      continue;
    }

    const found = findEntity(server, op.entityId);
    if (!found) {
      report.skipped.push(`字段修改失败：实体 ${op.entityId} 不存在`);
      continue;
    }
    const cur = (found.entity.fields as Record<string, FieldVersion>)[op.field];
    if (!cur) {
      report.skipped.push(`字段 ${op.field} 不可合并`);
      continue;
    }
    if (cur.value === op.value) {
      continue; // 两边一致，无事发生
    }
    if (cur.rev > op.baseRev) {
      // 管理员（服务端）改过，离线值后到也不能覆盖 → 双版本冲突
      const conflict = makeConflict(op, cur);
      conflict.entityName = entityName(found.entity, server);
      const existing = server.conflicts.find(
        (c) =>
          c.entityId === conflict.entityId &&
          c.field === conflict.field &&
          c.status === "open" &&
          c.offlineValue === conflict.offlineValue
      );
      if (!existing) {
        server.conflicts.push(conflict);
        report.conflicts.push({
          id: conflict.id,
          entityName: conflict.entityName,
          field: conflict.field,
        });
      }
      continue;
    }
    // 只有离线侧改动 → 快进覆盖
    (found.entity.fields as Record<string, FieldVersion>)[op.field] = {
      value: op.value,
      rev: cur.rev + 1,
      actor: op.actor,
      updatedAt: op.at,
    };
    report.applied += 1;

    // 教师离线也可能改了染色方式：生效后同样触发级联失效
    if (found.kind === "sample" && op.field === "staining") {
      const sample = found.entity as Sample;
      sample.stainingRev += 1;
      const ids = invalidateRecordsForStaining(server, sample);
      for (const id of ids) {
        const rec = server.records.find((r) => r.id === id);
        report.invalidated.push({
          recordId: id,
          reason: rec?.invalidateReason ?? "染色方式变更，关联记录失效",
        });
      }
    }
  }

  return { server, report };
}

// ---------- 离线视图：base 快照 + outbox/draft 的本地投影 ----------

export interface View {
  samples: Sample[];
  records: FieldRecord[];
  batches: ReviewBatch[];
  conflicts: FieldConflict[];
  pendingLocalEdits: Set<string>;
}

export function selectView(state: AppState): View {
  if (state.online) {
    const pending = new Set<string>(); // 在线时 outbox 已清空
    return {
      samples: state.server.samples,
      records: state.server.records,
      batches: state.server.batches,
      conflicts: state.server.conflicts,
      pendingLocalEdits: pending,
    };
  }

  const samples = clone(state.base.samples);
  const records = clone(state.base.records);
  const batches = clone(state.base.batches);
  const draftRecords = clone(state.draftRecords);
  const draftBatches = clone(state.draftBatches);
  const pendingLocalEdits = new Set<string>();

  for (const op of state.outbox) {
    if (op.type === "editField") {
      const target =
        samples.find((s) => s.id === op.entityId) ??
        records.find((r) => r.id === op.entityId) ??
        draftRecords.find((r) => r.id === op.entityId);
      if (target) {
        (target.fields as Record<string, FieldVersion>)[op.field] = {
          value: op.value,
          rev: op.baseRev + 1,
          actor: op.actor,
          updatedAt: op.at,
        };
        pendingLocalEdits.add(`${op.entityId}.${op.field}`);
      }
    } else if (op.type === "requestReview") {
      const record = records.find((r) => r.id === op.recordId);
      if (record && record.status === "invalidated") {
        record.status = "pending";
        record.invalidateReason = "已在本机重新提交复核，等待网络恢复同步";
      }
    }
  }
  for (const op of state.outbox) {
    if (op.type === "createBatch") {
      const entryRecords = [...records, ...draftRecords].filter((r) => op.entryIds.includes(r.id));
      batches.push({
        id: op.batchId,
        name: op.name,
        createdAt: op.at,
        createdBy: "teacher",
        status: "pending",
        entryIds: entryRecords.filter((r) => r.status === "pending").map((r) => r.id),
        draft: true,
      });
    }
  }

  return {
    samples,
    records: [...records, ...draftRecords],
    batches: [...batches, ...draftBatches],
    conflicts: state.base.conflicts,
    pendingLocalEdits,
  };
}

// ---------- 统计 ----------

export interface Stats {
  sampleCount: number;
  validCount: number;
  pendingCount: number;
  invalidatedCount: number;
  openConflictCount: number;
  pendingBatchCount: number;
}

export function computeStats(view: View): Stats {
  return {
    sampleCount: view.samples.length,
    validCount: view.records.filter((r) => r.status === "valid").length,
    pendingCount: view.records.filter((r) => r.status === "pending").length,
    invalidatedCount: view.records.filter((r) => r.status === "invalidated").length,
    openConflictCount: view.conflicts.filter((c) => c.status === "open").length,
    pendingBatchCount: view.batches.filter((b) => b.status === "pending").length,
  };
}

// ---------- 导出（带冲突说明） ----------

export function buildExport(state: AppState, view: View): string {
  const payload = {
    exportedAt: new Date().toISOString(),
    role: state.role,
    online: state.online,
    pendingOfflineOps: state.outbox.length,
    stats: computeStats(view),
    samples: view.samples.map((s) => ({
      id: s.id,
      name: s.fields.name.value,
      specimenType: s.fields.specimenType.value,
      staining: s.fields.staining.value,
      stainingRev: s.stainingRev,
    })),
    fieldRecords: view.records.map((r) => ({
      id: r.id,
      sampleId: r.sampleId,
      status: r.status,
      staining: r.fields.staining.value,
      confirmedStainingRev: r.confirmedStainingRev,
      structure: r.fields.structure.value,
      magnification: r.fields.magnification.value,
      description: r.fields.description.value,
      invalidateReason: r.invalidateReason ?? null,
      batches: r.batchIds,
    })),
    reviewBatches: view.batches.map((b) => {
      const entries = b.entryIds.map((id) => {
        const rec = view.records.find((r) => r.id === id);
        return {
          recordId: id,
          validInCurrentData: rec ? rec.status === "valid" || rec.status === "pending" : false,
          status: rec?.status ?? "missing",
        };
      });
      return {
        id: b.id,
        name: b.name,
        status: b.status,
        draft: b.draft ?? false,
        createdAt: new Date(b.createdAt).toISOString(),
        archivedAt: b.archivedAt ? new Date(b.archivedAt).toISOString() : null,
        archivedBy: b.archivedBy ?? null,
        entryCount: b.entryIds.length,
        entries,
      };
    }),
    conflicts: view.conflicts.map((c) => ({
      id: c.id,
      entityId: c.entityId,
      entityName: c.entityName,
      field: c.field,
      fieldLabel: FIELD_LABELS[c.field],
      status: c.status,
      server: {
        value: c.serverValue,
        rev: c.serverRev,
        actor: c.serverActor,
        note: "管理员/服务端版本，受保护，离线值不会覆盖",
      },
      offline: {
        value: c.offlineValue,
        baseRev: c.offlineRev,
        actor: c.offlineActor,
        note: "后到的离线值，另存待裁决",
      },
      resolution:
        c.status === "resolved"
          ? { winner: c.winner, finalValue: c.resolvedValue, at: c.resolvedAt }
          : null,
    })),
    conflictSummary: view.conflicts
      .filter((c) => c.status === "open")
      .map(
        (c) =>
          `【冲突】${c.entityName} 的「${FIELD_LABELS[c.field]}」：管理员值「${c.serverValue}」 vs 离线值「${c.offlineValue}」，待管理员裁决`
      ),
  };
  return JSON.stringify(payload, null, 2);
}


export function pushLog(state: AppState, text: string, kind: LogEntry["kind"] = "info"): LogEntry[] {
  return [{ id: uid("log"), at: Date.now(), text, kind }, ...state.log].slice(0, 60);
}

export function batchStatusLabel(s: BatchStatus): string {
  return s === "archived" ? "已归档" : "待管理员归档";
}

export function reviewStatusLabel(s: ReviewStatus): string {
  if (s === "valid") return "有效（已归档）";
  if (s === "pending") return "待复核";
  return "染色变更·退回待复核";
}

export type { SampleFieldKey, RecordFieldKey };
