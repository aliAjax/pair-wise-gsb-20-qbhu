import { useSyncExternalStore } from "react";
import type {
  ConflictEntry,
  DB,
  FieldVersion,
  ObservationRecord,
  Op,
  ReviewBatch,
  Role,
  Sample,
  SyncLogEntry,
} from "./types";

export type { DB } from "./types";

const STORAGE_KEY = "hxwl06.db.v1";

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const now = () => Date.now();

/* ---------------- 种子数据 ---------------- */

function seed(): DB {
  let clock = 100;
  const t = () => ++clock;
  const wall = now();
  const ver = (value: string, author: Role, authorName: string): FieldVersion => ({
    value,
    author,
    authorName,
    at: t(),
    wall,
  });

  const samples: Sample[] = [
    { id: "s-onion", name: "洋葱表皮", type: "植物组织", stainMethod: "碘液", stainVersion: 1 },
    { id: "s-blood", name: "人血涂片", type: "血液涂片", stainMethod: "瑞氏染色", stainVersion: 1 },
    { id: "s-paramecium", name: "草履虫", type: "微生物", stainMethod: "活体观察", stainVersion: 1 },
  ];

  const batches: ReviewBatch[] = [
    {
      id: "b-w6",
      name: "第6周观察复核",
      status: "archived",
      createdBy: "管理员",
      createdAt: wall - 7 * 86400_000,
      archivedBy: "管理员",
      archivedAt: wall - 5 * 86400_000,
    },
    { id: "b-w7", name: "第7周观察复核", status: "open", createdBy: "管理员", createdAt: wall - 86400_000 },
  ];

  const mk = (
    id: string,
    sampleId: string,
    batchId: string,
    author: Role,
    authorName: string,
    fields: [string, string][]
  ): ObservationRecord => ({
    id,
    sampleId,
    batchId,
    stainVersion: 1,
    fields: Object.fromEntries(fields.map(([k, v]) => [k, ver(v, author, authorName)])),
    conflicts: [],
    status: "valid",
    createdBy: authorName,
    createdAt: wall,
  });

  const records: ObservationRecord[] = [
    mk("r-onion-w6", "s-onion", "b-w6", "admin", "管理员", [
      ["染色方式", "碘液"],
      ["放大倍数", "400x"],
      ["观察结构", "细胞壁、细胞核"],
      ["视野描述", "细胞壁清晰，细胞核可见"],
    ]),
    mk("r-onion-w7", "s-onion", "b-w7", "teacher", "王老师", [
      ["染色方式", "碘液"],
      ["放大倍数", "400x"],
      ["观察结构", "细胞壁、液泡"],
      ["视野描述", "表皮细胞排列紧密，液泡明显"],
    ]),
    mk("r-blood-w7", "s-blood", "b-w7", "teacher", "王老师", [
      ["染色方式", "瑞氏染色"],
      ["放大倍数", "1000x"],
      ["观察结构", "红细胞、白细胞"],
      ["视野描述", "红细胞分布均匀，偶见白细胞"],
    ]),
    mk("r-para-w7", "s-paramecium", "b-w7", "admin", "管理员", [
      ["染色方式", "活体观察"],
      ["放大倍数", "200x"],
      ["观察结构", "纤毛、口沟"],
      ["视野描述", "纤毛运动明显，口沟清晰"],
    ]),
  ];

  return {
    samples,
    records,
    batches,
    outbox: [],
    clock,
    online: true,
    role: "teacher",
    actorName: "王老师",
    lastSync: null,
  };
}

/* ---------------- 持久化与订阅 ---------------- */

function load(): DB {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as DB;
  } catch {
    /* 损坏则重建 */
  }
  const fresh = seed();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
  } catch {
    /* 存储不可用时仅在内存中运行 */
  }
  return fresh;
}

let db: DB = load();
const listeners = new Set<() => void>();

function commit(next: DB) {
  db = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    /* 忽略写入失败 */
  }
  listeners.forEach((l) => l());
}

/** 在草稿上修改，全部成功才落库；抛错则本次改动整体丢弃 */
function update(fn: (draft: DB) => void) {
  const draft = structuredClone(db);
  fn(draft);
  commit(draft);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
const getSnapshot = () => db;
export const getDB = (): DB => db;
export const useDB = (): DB => useSyncExternalStore(subscribe, getSnapshot);

const tick = (draft: DB) => ++draft.clock;

/* ---------------- 字段级合并 ---------------- */

function sameVersion(a: FieldVersion | null | undefined, b: FieldVersion | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.value === b.value && a.author === b.author && a.at === b.at;
}

/**
 * 把后到的字段版本合并进记录：
 * - 服务端字段没人动过（与离线方基准一致）→ 直接采用离线值
 * - 两边都改了同一字段 → 保留两版并标冲突；
 *   管理员版本优先成为生效值，后到的离线值不能盖掉管理员
 */
function mergeField(
  rec: ObservationRecord,
  field: string,
  incoming: FieldVersion,
  base: FieldVersion | null
): "applied" | "conflict" {
  const current = rec.fields[field] ?? null;

  if (!current || sameVersion(current, base)) {
    rec.fields[field] = incoming;
    return "applied";
  }
  if (current.value === incoming.value) {
    return "applied"; // 双方改到了同一个值，自然收敛
  }

  const adminSide =
    current.author === "admin" ? current : incoming.author === "admin" ? incoming : null;
  const winner = adminSide ?? (current.at >= incoming.at ? current : incoming);
  rec.fields[field] = winner;

  const conflict: ConflictEntry = {
    id: uid(),
    field,
    base,
    committed: current,
    incoming,
    resolved: false,
  };
  rec.conflicts.push(conflict);
  return "conflict";
}

/** 状态推导：未决冲突 > 染色版本失效 > 有效 */
function recomputeStatus(draft: DB, rec: ObservationRecord) {
  const sample = draft.samples.find((s) => s.id === rec.sampleId);
  if (rec.conflicts.some((c) => !c.resolved)) {
    rec.status = "conflict";
    return;
  }
  if (sample && rec.stainVersion !== sample.stainVersion) {
    rec.status = "pending";
    if (!rec.invalidReason) {
      rec.invalidReason = `染色方式已变更为「${sample.stainMethod}」，记录退回待复核`;
    }
    return;
  }
  rec.status = "valid";
  rec.invalidReason = undefined;
}

/* ---------------- 本地暂存视图（离线改动先留在本机） ---------------- */

export interface StagedView {
  records: ObservationRecord[];
  /** recordId -> 有未同步改动的字段名 */
  stagedFields: Record<string, string[]>;
  /** 尚未同步的新记录 */
  newRecordIds: string[];
  pendingCount: number;
}

export function stagedView(d: DB): StagedView {
  const pending = d.outbox.filter((o) => !o.applied);
  const map = new Map<string, ObservationRecord>();
  d.records.forEach((r) => map.set(r.id, r));
  const stagedFields: Record<string, Set<string>> = {};
  const newRecordIds: string[] = [];
  const cloned = new Set<string>();

  const ensureClone = (id: string) => {
    if (!cloned.has(id)) {
      const r = map.get(id);
      if (r) {
        map.set(id, { ...r, fields: { ...r.fields } });
        cloned.add(id);
      }
    }
    return map.get(id);
  };

  for (const op of pending) {
    if (op.kind === "record.create") {
      map.set(op.record.id, { ...op.record, fields: { ...op.record.fields } });
      cloned.add(op.record.id);
      newRecordIds.push(op.record.id);
    } else if (op.kind === "field.update") {
      const rec = ensureClone(op.recordId);
      if (rec) {
        rec.fields[op.field] = op.value;
        (stagedFields[op.recordId] ??= new Set()).add(op.field);
      }
    }
  }

  const flat: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(stagedFields)) flat[k] = [...v];
  return { records: [...map.values()], stagedFields: flat, newRecordIds, pendingCount: pending.length };
}

/* ---------------- 角色与网络 ---------------- */

export function setRole(role: Role) {
  update((draft) => {
    draft.role = role;
    draft.actorName = role === "admin" ? "管理员" : "王老师";
  });
}

export function setOnline(online: boolean) {
  update((draft) => {
    draft.online = online;
  });
  if (online) syncNow();
}

/* ---------------- 录入：教师走本机 outbox，管理员直接作用于服务端 ---------------- */

export function stageFieldUpdates(recordId: string, changes: { field: string; value: string }[]) {
  update((draft) => {
    const view = stagedView(draft);
    const rec = view.records.find((r) => r.id === recordId);
    if (!rec) throw new Error("记录不存在");
    const batch = draft.batches.find((b) => b.id === rec.batchId);
    if (batch?.status === "archived") throw new Error("该批次已归档，不能再修改");

    // 管理员在服务端操作，直接合并进已提交状态（不受本机离线开关影响）
    if (draft.role === "admin") {
      const target = draft.records.find((r) => r.id === recordId);
      if (!target) throw new Error("该记录还在本机待同步，服务端尚不存在");
      for (const c of changes) {
        const base = target.fields[c.field] ?? null;
        if (base && base.value === c.value) continue;
        const ver: FieldVersion = { value: c.value, author: "admin", authorName: draft.actorName, at: tick(draft), wall: now() };
        mergeField(target, c.field, ver, base);
      }
      recomputeStatus(draft, target);
      return;
    }

    // 教师：改动先留在本机 outbox，联网后逐字段合并
    for (const c of changes) {
      const base = rec.fields[c.field] ?? null;
      if (base && base.value === c.value) continue;
      const value: FieldVersion = {
        value: c.value,
        author: draft.role,
        authorName: draft.actorName,
        at: tick(draft),
        wall: now(),
      };
      draft.outbox.push({
        id: uid(),
        kind: "field.update",
        recordId,
        field: c.field,
        value,
        base,
        actor: draft.role,
        actorName: draft.actorName,
        applied: false,
        createdAt: now(),
      });
    }
  });
  if (db.online) syncNow();
}

export function createRecord(input: { sampleId: string; batchId: string; fields: Record<string, string> }) {
  update((draft) => {
    const sample = draft.samples.find((s) => s.id === input.sampleId);
    if (!sample) throw new Error("样本不存在");
    const batch = draft.batches.find((b) => b.id === input.batchId);
    if (!batch || batch.status !== "open") throw new Error("复核批次不存在或已归档");

    const fields: Record<string, FieldVersion> = {};
    for (const [k, v] of Object.entries(input.fields)) {
      fields[k] = { value: v, author: draft.role, authorName: draft.actorName, at: tick(draft), wall: now() };
    }
    const rec: ObservationRecord = {
      id: uid(),
      sampleId: sample.id,
      batchId: batch.id,
      stainVersion: sample.stainVersion,
      fields,
      conflicts: [],
      status: "valid",
      createdBy: draft.actorName,
      createdAt: now(),
    };
    recomputeStatus(draft, rec);
    if (draft.role === "admin") {
      draft.records.push(rec); // 管理员直接落到服务端
      return;
    }
    draft.outbox.push({
      id: uid(),
      kind: "record.create",
      record: rec,
      actor: draft.role,
      actorName: draft.actorName,
      applied: false,
      createdAt: now(),
    });
  });
  if (db.online) syncNow();
}

export function createBatch(name: string) {
  if (!name.trim()) throw new Error("请填写批次名称");
  update((draft) => {
    const batch: ReviewBatch = {
      id: uid(),
      name: name.trim(),
      status: "open",
      createdBy: draft.actorName,
      createdAt: now(),
    };
    if (draft.role === "admin") {
      draft.batches.push(batch);
      return;
    }
    draft.outbox.push({
      id: uid(),
      kind: "batch.create",
      batch,
      actor: draft.role,
      actorName: draft.actorName,
      applied: false,
      createdAt: now(),
    });
  });
  if (db.online) syncNow();
}

export function discardOp(opId: string) {
  update((draft) => {
    const i = draft.outbox.findIndex((o) => o.id === opId && !o.applied);
    if (i >= 0) draft.outbox.splice(i, 1);
  });
}

/* ---------------- 同步：网络恢复后逐字段合并 ---------------- */

function applyOp(draft: DB, op: Op): SyncLogEntry {
  const base = { opId: op.id, kind: op.kind };

  if (op.kind === "record.create") {
    const batch = draft.batches.find((b) => b.id === op.record.batchId);
    if (batch?.status === "archived") {
      return { ...base, label: `${op.actorName} 新增记录`, result: "rejected", note: "批次已归档" };
    }
    if (!draft.records.some((r) => r.id === op.record.id)) {
      draft.records.push(op.record);
      const rec = draft.records[draft.records.length - 1];
      recomputeStatus(draft, rec);
    }
    return { ...base, label: `${op.actorName} 新增记录`, result: "applied" };
  }

  if (op.kind === "batch.create") {
    if (!draft.batches.some((b) => b.id === op.batch.id)) draft.batches.push(op.batch);
    return { ...base, label: `${op.actorName} 新建批次「${op.batch.name}」`, result: "applied" };
  }

  const rec = draft.records.find((r) => r.id === op.recordId);
  const label = `${op.actorName} 修改「${op.field}」`;
  if (!rec) return { ...base, label, result: "rejected", note: "记录不存在" };
  const batch = draft.batches.find((b) => b.id === rec.batchId);
  if (batch?.status === "archived") return { ...base, label, result: "rejected", note: "批次已归档" };

  const result = mergeField(rec, op.field, op.value, op.base);
  recomputeStatus(draft, rec);
  return {
    ...base,
    label,
    result,
    note: result === "conflict" ? "双方改了同一字段，已保留两版" : undefined,
  };
}

export function syncNow() {
  if (!db.online) return;
  update((draft) => {
    const entries: SyncLogEntry[] = [];
    for (const op of draft.outbox) {
      if (op.applied) continue;
      entries.push(applyOp(draft, op));
      op.applied = true;
    }
    if (entries.length > 0 || !draft.lastSync) {
      draft.lastSync = { at: now(), entries };
    }
  });
}

/* ---------------- 管理员专属动作 ---------------- */

function requireAdmin(draft: DB) {
  // 管理员操作直接作用于服务端，不受本机离线开关影响
  if (draft.role !== "admin") throw new Error("只有管理员可以执行此操作");
}

/** 修改染色方式：关联记录全部失效，退回待复核，不再计入有效统计 */
export function changeStain(sampleId: string, next: string) {
  update((draft) => {
    requireAdmin(draft);
    const sample = draft.samples.find((s) => s.id === sampleId);
    if (!sample) throw new Error("样本不存在");
    const prev = sample.stainMethod;
    if (prev === next) throw new Error("染色方式未变化");

    sample.stainMethod = next;
    sample.stainVersion += 1;
    const ver: FieldVersion = { value: next, author: "admin", authorName: draft.actorName, at: tick(draft), wall: now() };

    for (const rec of draft.records.filter((r) => r.sampleId === sampleId)) {
      rec.fields["染色方式"] = ver; // 管理员直接改写；后到的离线旧值会撞出冲突并被拦下
      rec.invalidReason = `染色方式由「${prev}」改为「${next}」，记录退回待复核`;
      recomputeStatus(draft, rec);
    }
  });
}

/** 复核批次归档：仅管理员，且存在未决冲突时禁止 */
export function archiveBatch(batchId: string) {
  update((draft) => {
    requireAdmin(draft);
    const batch = draft.batches.find((b) => b.id === batchId);
    if (!batch) throw new Error("批次不存在");
    if (batch.status === "archived") throw new Error("批次已归档");
    const open = draft.records
      .filter((r) => r.batchId === batchId)
      .flatMap((r) => r.conflicts)
      .filter((c) => !c.resolved);
    if (open.length > 0) throw new Error(`该批次还有 ${open.length} 处未解决冲突，不能归档`);
    batch.status = "archived";
    batch.archivedBy = draft.actorName;
    batch.archivedAt = now();
  });
}

/** 冲突裁决：管理员选定保留哪一版 */
export function resolveConflict(recordId: string, conflictId: string, side: "committed" | "incoming") {
  update((draft) => {
    requireAdmin(draft);
    const rec = draft.records.find((r) => r.id === recordId);
    const c = rec?.conflicts.find((x) => x.id === conflictId);
    if (!rec || !c) throw new Error("冲突不存在");
    if (c.resolved) return;
    const chosen = side === "incoming" ? c.incoming : c.committed;
    rec.fields[c.field] = { ...chosen, at: tick(draft) };
    c.resolved = true;
    c.resolution = side;
    c.resolvedBy = draft.actorName;
    c.resolvedAt = now();
    recomputeStatus(draft, rec);
  });
}

/** 复核确认：染色变更后由管理员把记录重新置为有效 */
export function confirmRecord(recordId: string) {
  update((draft) => {
    requireAdmin(draft);
    const rec = draft.records.find((r) => r.id === recordId);
    if (!rec) throw new Error("记录不存在");
    const sample = draft.samples.find((s) => s.id === rec.sampleId);
    if (!sample) throw new Error("样本不存在");
    rec.stainVersion = sample.stainVersion;
    rec.invalidReason = undefined;
    recomputeStatus(draft, rec);
  });
}

/* ---------------- 统计与导出 ---------------- */

export function stats(d: DB) {
  const valid = d.records.filter((r) => r.status === "valid").length;
  const pending = d.records.filter((r) => r.status === "pending").length;
  const conflictRecs = d.records.filter((r) => r.status === "conflict").length;
  const openConflicts = d.records.reduce((n, r) => n + r.conflicts.filter((c) => !c.resolved).length, 0);
  const pendingOps = d.outbox.filter((o) => !o.applied).length;
  const archived = d.batches.filter((b) => b.status === "archived").length;
  return {
    samples: d.samples.length,
    valid,
    pending,
    conflictRecs,
    openConflicts,
    pendingOps,
    archived,
    batches: d.batches.length,
    total: d.records.length,
  };
}

const fmt = (wall: number) =>
  new Date(wall).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

const statusLabel: Record<ObservationRecord["status"], string> = {
  valid: "有效",
  pending: "待复核",
  conflict: "有冲突",
};

export function exportReport(d: DB): string {
  const st = stats(d);
  const lines: string[] = [];
  const sampleOf = (id: string) => d.samples.find((s) => s.id === id);
  const batchOf = (id: string) => d.batches.find((b) => b.id === id);

  lines.push("# 显微镜玻片观察导出报告", "");
  lines.push(`- 导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  lines.push(`- 导出人：${d.actorName}（${d.role === "admin" ? "管理员" : "教师"}）`, "");

  lines.push("## 有效统计（仅计入状态为「有效」的记录）", "");
  lines.push(`- 样本数：${st.samples}`);
  lines.push(`- 有效视野记录：${st.valid} / ${st.total}`);
  lines.push(`- 待复核（已失效，不计入有效统计）：${st.pending}`);
  lines.push(`- 未解决冲突：${st.openConflicts} 处（${st.conflictRecs} 条记录）`);
  lines.push(`- 复核批次：${st.archived} 已归档 / ${st.batches} 总计`, "");

  lines.push("## 样本与染色方式", "");
  for (const s of d.samples) {
    lines.push(`- ${s.name}（${s.type}）· 染色方式：${s.stainMethod} · 版本 v${s.stainVersion}`);
  }
  lines.push("");

  lines.push("## 复核批次", "");
  for (const b of d.batches) {
    const recs = d.records.filter((r) => r.batchId === b.id);
    const v = recs.filter((r) => r.status === "valid").length;
    lines.push(
      `- ${b.name}：${b.status === "archived" ? `已归档（${b.archivedBy ?? ""}）` : "复核中"} · 记录 ${recs.length} 条，其中有效 ${v} 条`
    );
  }
  lines.push("");

  lines.push("## 视野记录明细", "");
  for (const r of d.records) {
    lines.push(
      `### ${r.id.slice(0, 8)} ｜ ${sampleOf(r.sampleId)?.name ?? "?"} ｜ ${batchOf(r.batchId)?.name ?? "?"} ｜ 状态：${statusLabel[r.status]}`
    );
    for (const [field, v] of Object.entries(r.fields)) {
      lines.push(`- ${field}：${v.value}（${v.authorName} · ${fmt(v.wall)}）`);
    }
    if (r.invalidReason) lines.push(`- ⚠ 失效原因：${r.invalidReason}`);
    lines.push("");
  }

  const allConflicts = d.records.flatMap((r) => r.conflicts.map((c) => ({ r, c })));
  lines.push("## 冲突说明", "");
  if (allConflicts.length === 0) {
    lines.push("本次导出无字段冲突。", "");
  } else {
    allConflicts.forEach(({ r, c }, i) => {
      lines.push(`### 冲突 ${i + 1}：记录 ${r.id.slice(0, 8)} 字段「${c.field}」`);
      lines.push(`- 服务端版本：${c.committed.value}（${c.committed.authorName} · ${fmt(c.committed.wall)}）`);
      lines.push(`- 离线补记版本：${c.incoming.value}（${c.incoming.authorName} · ${fmt(c.incoming.wall)}）`);
      if (c.base) lines.push(`- 离线修改基于：${c.base.value}（${c.base.authorName}）`);
      const kept = rec_field(d, r.id, c.field);
      lines.push(`- 当前生效值：${kept ?? "—"}`);
      lines.push(
        c.resolved
          ? `- 处理状态：已解决，采用${c.resolution === "incoming" ? "离线补记" : "服务端"}版本（${c.resolvedBy ?? ""} · ${c.resolvedAt ? fmt(c.resolvedAt) : ""}）`
          : "- 处理状态：未解决（生效值按「管理员优先」暂定，待管理员裁决）"
      );
      lines.push("");
    });
  }

  const pendingOps = d.outbox.filter((o) => !o.applied);
  lines.push("## 本机待同步改动", "");
  if (pendingOps.length === 0) {
    lines.push("无。", "");
  } else {
    for (const o of pendingOps) {
      if (o.kind === "field.update") lines.push(`- ${o.actorName} 修改记录 ${o.recordId.slice(0, 8)} 的「${o.field}」→ ${o.value.value}`);
      else if (o.kind === "record.create") lines.push(`- ${o.actorName} 新增记录 ${o.record.id.slice(0, 8)}`);
      else lines.push(`- ${o.actorName} 新建批次「${o.batch.name}」`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function rec_field(d: DB, recordId: string, field: string): string | null {
  return d.records.find((r) => r.id === recordId)?.fields[field]?.value ?? null;
}

export function resetDemo() {
  commit(seed());
}
