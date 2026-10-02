import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import {
  AppState,
  FIELD_LABELS,
  FieldRecord,
  FieldVersion,
  MergeableField,
  RecordFieldKey,
  ReviewBatch,
  ROLE_LABELS,
  Role,
  Sample,
} from "./types";
import {
  STORAGE_KEY,
  applyServerFieldEdit,
  archiveBatch,
  batchStatusLabel,
  buildExport,
  computeStats,
  createBatch,
  entityName,
  fieldOf,
  findEntity,
  initialState,
  nowText,
  pushLog,
  requestReview,
  resolveConflict,
  reviewStatusLabel,
  runSync,
  selectView,
  uid,
} from "./engine";

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppState;
      if (parsed.server && parsed.base) return parsed;
    }
  } catch {
    /* 损坏则重建 */
  }
  return initialState("teacher");
}

/* ---------- 小组件 ---------- */

function Badge({ tone, children }: { tone: "ok" | "warn" | "danger" | "info" | "muted"; children: React.ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function EditableField({
  label,
  fv,
  pending,
  disabled,
  multiline,
  onSave,
}: {
  label: string;
  fv: FieldVersion;
  pending?: boolean;
  disabled?: boolean;
  multiline?: boolean;
  onSave: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(fv.value);
  useEffect(() => {
    if (!editing) setValue(fv.value);
  }, [fv.value, editing]);

  if (!editing) {
    return (
      <div className={`efield ${disabled ? "is-disabled" : ""}`} onClick={() => !disabled && setEditing(true)}>
        <span className="efield-label">
          {label}
          {pending && <Badge tone="warn">本机待同步</Badge>}
        </span>
        <strong className="efield-value">{fv.value || "—"}</strong>
        <span className="efield-meta">
          v{fv.rev} · {ROLE_LABELS[fv.actor]}
          {!disabled && " · 点击修改"}
        </span>
      </div>
    );
  }
  return (
    <div className="efield editing">
      <span className="efield-label">{label}</span>
      {multiline ? (
        <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={2} />
      ) : (
        <input value={value} onChange={(e) => setValue(e.target.value)} />
      )}
      <span className="efield-actions">
        <button
          className="mini primary"
          onClick={() => {
            onSave(value.trim());
            setEditing(false);
          }}
        >
          保存
        </button>
        <button
          className="mini"
          onClick={() => {
            setValue(fv.value);
            setEditing(false);
          }}
        >
          取消
        </button>
      </span>
    </div>
  );
}

/* ---------- 主应用 ---------- */

export default function App() {
  const [state, setState] = useState<AppState>(loadState);
  const [toast, setToast] = useState<string | null>(null);

  // 重开页面接着处理：任何变化都落 localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const view = useMemo(() => selectView(state), [state]);
  const stats = useMemo(() => computeStats(view), [view]);

  const flash = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(null), 3200);
  };

  const log = (text: string, kind: "info" | "warn" | "ok" = "info") =>
    setState((s) => ({ ...s, log: pushLog(s, text, kind) }));

  /* ----- 角色 / 网络 ----- */

  const switchRole = (role: Role) => {
    setState((s) => ({ ...s, role }));
    log(`当前角色切换为「${ROLE_LABELS[role]}」`);
  };

  const goOffline = () => {
    setState((s) => {
      if (!s.online) return s;
      const next = {
        ...s,
        online: false,
        base: JSON.parse(JSON.stringify(s.server)),
        log: pushLog(s, "网络已断开：改动只留在本机（快照已冻结），恢复后逐字段合并", "warn"),
      };
      return next;
    });
  };

  const goOnlineAndSync = () => {
    setState((s) => {
      if (s.online) return s;
      const { server, report } = runSync(s);
      const merged: AppState = {
        ...s,
        online: true,
        server,
        base: JSON.parse(JSON.stringify(server)),
        outbox: [],
        draftRecords: [],
        draftBatches: [],
        lastReport: report,
        log: pushLog(
          { ...s, server },
          `网络恢复，同步完成：应用 ${report.applied} 项，冲突 ${report.conflicts.length} 处，失效 ${report.invalidated.length} 条`,
          report.conflicts.length ? "warn" : "ok"
        ),
      };
      return merged;
    });
    flash("已逐字段合并本机改动，冲突双版本保留");
  };

  const resetAll = () => {
    if (!confirm("确认清空本机数据并恢复演示数据？")) return;
    const fresh = initialState(state.role);
    setState(fresh);
    flash("已重置演示数据");
  };

  /* ----- 字段编辑：在线直改服务端；离线进 outbox ----- */

  const saveField = (entityId: string, field: MergeableField, value: string) => {
    setState((s) => {
      if (s.online) {
        const server = JSON.parse(JSON.stringify(s.server));
        const before = entityName(findEntity(server, entityId)!.entity, server);
        const { invalidated } = applyServerFieldEdit(server, entityId, field, value, s.role);
        const next = { ...s, server, base: JSON.parse(JSON.stringify(server)) };
        next.log = pushLog(
          next,
          `${ROLE_LABELS[s.role]}在线修改「${before}」的${FIELD_LABELS[field]}为「${value}」` +
            (invalidated.length ? `；${invalidated.length} 条关联视野记录失效退回待复核` : ""),
          invalidated.length ? "warn" : "ok"
        );
        return next;
      }
      // 离线：记录 baseRev，改动只进本机 outbox
      const baseFv = fieldOf(s.base, entityId, field);
      const op = {
        id: uid("op"),
        type: "editField" as const,
        entityId,
        field,
        value,
        baseRev: baseFv?.rev ?? 1,
        actor: s.role,
        at: Date.now(),
      };
      return {
        ...s,
        outbox: [...s.outbox.filter((o) => !(o.type === "editField" && o.entityId === entityId && o.field === field)), op],
        log: pushLog(
          s,
          `离线补记「${FIELD_LABELS[field]}」已留在本机，恢复网络后合并（基于 v${op.baseRev}）`,
          "warn"
        ),
      };
    });
  };

  /* ----- 视野记录：新建 / 重新复核 ----- */

  const addRecord = (sampleId: string, values: Record<RecordFieldKey, string>) => {
    setState((s) => {
      const sample = (s.online ? s.server : s.base).samples.find((x) => x.id === sampleId)!;
      const stainingRev = sample.stainingRev;
      const stainingSnapshot = sample.fields.staining.value;
      if (s.online) {
        const server = JSON.parse(JSON.stringify(s.server));
        const t = Date.now();
        const rec: FieldRecord = {
          id: uid("f"),
          kind: "field",
          sampleId,
          confirmedStainingRev: stainingRev,
          status: "pending",
          batchIds: [],
          createdAt: t,
          fields: {
            structure: { value: values.structure, rev: 1, actor: s.role, updatedAt: t },
            magnification: { value: values.magnification, rev: 1, actor: s.role, updatedAt: t },
            description: { value: values.description, rev: 1, actor: s.role, updatedAt: t },
            staining: { ...sample.fields.staining },
          },
        };
        server.records.push(rec);
        return {
          ...s,
          server,
          base: JSON.parse(JSON.stringify(server)),
          log: pushLog(s, `新视野记录已提交（${sample.fields.name.value}），状态待复核`, "ok"),
        };
      }
      const recordId = uid("f");
      const t = Date.now();
      const draft: FieldRecord = {
        id: recordId,
        kind: "field",
        sampleId,
        confirmedStainingRev: stainingRev,
        status: "pending",
        batchIds: [],
        createdAt: t,
        fields: {
          structure: { value: values.structure, rev: 1, actor: s.role, updatedAt: t },
          magnification: { value: values.magnification, rev: 1, actor: s.role, updatedAt: t },
          description: { value: values.description, rev: 1, actor: s.role, updatedAt: t },
          staining: { ...sample.fields.staining },
        },
      };
      const op = {
        id: uid("op"),
        type: "createRecord" as const,
        recordId,
        sampleId,
        values,
        stainingSnapshot,
        stainingRev,
        at: t,
      };
      return {
        ...s,
        draftRecords: [...s.draftRecords, draft],
        outbox: [...s.outbox, op],
        log: pushLog(s, `离线补记的视野记录已存在本机，恢复网络后上传`, "warn"),
      };
    });
  };

  const rereview = (recordId: string) => {
    setState((s) => {
      if (s.online) {
        const server = JSON.parse(JSON.stringify(s.server));
        const res = requestReview(server, recordId);
        if (!res.ok) return { ...s, log: pushLog(s, res.reason ?? "无法重新复核", "danger") };
        return {
          ...s,
          server,
          base: JSON.parse(JSON.stringify(server)),
          log: pushLog(s, "已按当前染色方式重新提交复核", "ok"),
        };
      }
      const rec = s.base.records.find((r) => r.id === recordId);
      const sample = rec ? s.base.samples.find((x) => x.id === rec.sampleId) : null;
      if (!rec || !sample) return s;
      const op = {
        id: uid("op"),
        type: "requestReview" as const,
        recordId,
        stainingSnapshot: sample.fields.staining.value,
        stainingRev: sample.stainingRev,
        at: Date.now(),
      };
      return {
        ...s,
        outbox: [...s.outbox.filter((o) => o.type !== "requestReview" || o.recordId !== recordId), op],
        log: pushLog(s, "重新复核请求已留在本机，恢复网络后生效", "warn"),
      };
    });
  };

  /* ----- 批次 ----- */

  const submitBatch = (name: string, entryIds: string[]) => {
    setState((s) => {
      if (entryIds.length === 0) return s;
      if (s.online) {
        const server = JSON.parse(JSON.stringify(s.server));
        const batch = createBatch(server, name, entryIds, s.role);
        return {
          ...s,
          server,
          base: JSON.parse(JSON.stringify(server)),
          log: pushLog(s, `复核批次「${batch.name}」已提交（${batch.entryIds.length} 条），等待管理员归档`),
        };
      }
      const batchId = uid("rb");
      const op = { id: uid("op"), type: "createBatch" as const, batchId, name, entryIds, at: Date.now() };
      const draftBatch: ReviewBatch = {
        id: batchId,
        name,
        createdAt: op.at,
        createdBy: "teacher",
        status: "pending",
        entryIds,
        draft: true,
      };
      return {
        ...s,
        draftBatches: [...s.draftBatches, draftBatch],
        outbox: [...s.outbox, op],
        log: pushLog(s, `离线提交的复核批次「${name}」已留在本机`, "warn"),
      };
    });
  };

  const doArchive = (batchId: string) => {
    setState((s) => {
      if (s.role !== "admin") return { ...s, log: pushLog(s, "只有管理员能确认归档复核批次", "danger") };
      if (!s.online) return { ...s, log: pushLog(s, "当前离线，归档需在线由管理员确认", "danger") };
      const server = JSON.parse(JSON.stringify(s.server));
      const res = archiveBatch(server, batchId);
      if (!res.ok) return { ...s, log: pushLog(s, `归档失败：${res.reason}`, "danger") };
      const notes = res.dropped.length
        ? `；${res.dropped.length} 条已失效条目被摘除（染色方式已变更，不计入有效统计）`
        : "";
      return {
        ...s,
        server,
        base: JSON.parse(JSON.stringify(server)),
        log: pushLog(s, `管理员已确认归档 ${res.archived} 条视野记录${notes}`, res.dropped.length ? "warn" : "ok"),
      };
    });
  };

  /* ----- 冲突裁决 ----- */

  const decideConflict = (conflictId: string, winner: "server" | "offline") => {
    setState((s) => {
      if (s.role !== "admin") return { ...s, log: pushLog(s, "只有管理员能裁决冲突", "danger") };
      const server: import("./types").ServerState = JSON.parse(JSON.stringify(s.server));
      const res = resolveConflict(server, conflictId, winner, s.role);
      if (!res.ok) return s;
      const c = server.conflicts.find((x) => x.id === conflictId)!;
      return {
        ...s,
        server,
        base: JSON.parse(JSON.stringify(server)),
        log: pushLog(
          s,
          `冲突已裁决：保留${winner === "server" ? "管理员" : "离线"}版本「${c.resolvedValue}」` +
            (res.invalidated.length ? `；染色变更导致 ${res.invalidated.length} 条记录失效` : ""),
          "ok"
        ),
      };
    });
  };

  /* ----- 导出 ----- */

  const doExport = () => {
    const blob = new Blob([buildExport(state, view)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `玻片观察导出_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
    log("已导出 JSON（含样本、视野记录、复核批次与冲突说明）", "ok");
  };

  /* ----- 断网期间模拟管理员在云端并发修改 ----- */

  const cloudAdminEdit = (entityId: string, field: MergeableField, value: string) => {
    setState((s) => {
      const server = JSON.parse(JSON.stringify(s.server));
      const { invalidated } = applyServerFieldEdit(server, entityId, field, value, "admin");
      return {
        ...s,
        server,
        log: pushLog(
          s,
          `☁ 云端模拟：管理员在你离线期间修改了${FIELD_LABELS[field]}为「${value}」` +
            (invalidated.length ? `，并使 ${invalidated.length} 条记录失效` : ""),
          "warn"
        ),
      };
    });
  };

  /* ================= 渲染 ================= */

  const isAdmin = state.role === "admin";
  const openConflicts = state.server.conflicts.filter((c) => c.status === "open");

  return (
    <main className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      {/* 顶栏 */}
      <section className="topbar panel">
        <div>
          <p className="eyebrow">hxwl-06 · 离线优先协同</p>
          <h1>显微镜玻片观察 · 样本 / 视野记录 / 复核批次</h1>
        </div>
        <div className="top-controls">
          <div className="seg">
            {(["teacher", "admin"] as Role[]).map((r) => (
              <button key={r} className={state.role === r ? "seg-on" : ""} onClick={() => switchRole(r)}>
                {ROLE_LABELS[r]}
              </button>
            ))}
          </div>
          <div className="seg">
            <button className={state.online ? "seg-on net-on" : ""} disabled={state.online} onClick={() => {}}>
              ● 在线
            </button>
            <button className={!state.online ? "seg-on net-off" : ""} disabled={!state.online} onClick={goOffline}>
              ✕ 离线
            </button>
          </div>
          {state.online ? (
            <button onClick={goOffline}>模拟断网</button>
          ) : (
            <button className="primary-action" onClick={goOnlineAndSync}>
              恢复网络并同步（{state.outbox.length} 项待传）
            </button>
          )}
          <button onClick={doExport}>导出（含冲突说明）</button>
          <button onClick={resetAll}>重置数据</button>
        </div>
      </section>

      {/* 指标 */}
      <section className="metrics-grid">
        <MetricCard label="样本数" value={stats.sampleCount} tone="info" />
        <MetricCard label="有效视野记录" value={stats.validCount} tone="ok" note="仅统计已归档有效" />
        <MetricCard label="待复核" value={stats.pendingCount} tone="info" />
        <MetricCard label="染色变更退回" value={stats.invalidatedCount} tone="danger" note="不计入有效统计" />
        <MetricCard label="未决冲突" value={stats.openConflictCount} tone="warn" note="双版本待管理员裁决" />
        <MetricCard label="待归档批次" value={stats.pendingBatchCount} tone="info" />
      </section>

      {!state.online && (
        <section className="panel offline-banner">
          <strong>当前离线：改动只保存在本机浏览器（localStorage + outbox 快照）</strong>
          <p>
            恢复网络后将逐字段合并：管理员没动过的字段直接快进；管理员改过的字段保留管理员值，你的离线值另存为冲突，两边同改一字段会保留双版本。
          </p>
          <CloudSimulator view={view} serverRecords={state.server.records} onAdminEdit={cloudAdminEdit} />
        </section>
      )}

      <section className="workspace">
        {/* 左：日志 + 批次 */}
        <aside className="panel narrow side">
          <BatchPanel
            state={state}
            view={view}
            isAdmin={isAdmin}
            onSubmit={submitBatch}
            onArchive={doArchive}
          />
          <div>
            <h2>操作日志</h2>
            <ul className="log-list">
              {state.log.map((l) => (
                <li key={l.id} className={`log-${l.kind}`}>
                  <span>{nowText(l.at)}</span>
                  {l.text}
                </li>
              ))}
            </ul>
          </div>
        </aside>

        {/* 右：实体 */}
        <section className="panel entity-panel">
          <div className="section-heading">
            <div>
              <p>{state.online ? "在线数据（改动即时生效）" : "本机投影 = 断网快照 + 本机补记"}</p>
              <h2>样本与视野记录</h2>
            </div>
          </div>
          <div className="sample-list">
            {view.samples.map((sample) => (
              <SampleCard
                key={sample.id}
                state={state}
                sample={sample}
                records={view.records.filter((r) => r.sampleId === sample.id)}
                onSaveField={saveField}
                onAddRecord={addRecord}
                onRereview={rereview}
              />
            ))}
          </div>
        </section>
      </section>

      {/* 冲突 */}
      <section className="panel conflict-panel">
        <div className="section-heading">
          <div>
            <p>逐字段合并 · 双版本保留</p>
            <h2>字段冲突（{state.server.conflicts.length}，未决 {openConflicts.length}）</h2>
          </div>
        </div>
        {state.server.conflicts.length === 0 ? (
          <p className="muted-text">暂无冲突。可在离线时修改字段，再用顶部「☁ 云端模拟」制造管理员并发修改，然后恢复网络查看。</p>
        ) : (
          <div className="conflict-list">
            {state.server.conflicts.map((c) => (
              <article key={c.id} className={`conflict-card ${c.status}`}>
                <div className="conflict-head">
                  <strong>
                    {c.entityName} · {FIELD_LABELS[c.field]}
                  </strong>
                  {c.status === "open" ? <Badge tone="warn">待管理员裁决</Badge> : <Badge tone="ok">已裁决</Badge>}
                </div>
                <div className="conflict-versions">
                  <div className="version server-ver">
                    <span>管理员 / 服务端 v{c.serverRev}（受保护）</span>
                    <strong>{c.serverValue}</strong>
                  </div>
                  <div className="version offline-ver">
                    <span>后到离线值（基于 v{c.offlineRev}，不覆盖）</span>
                    <strong>{c.offlineValue}</strong>
                  </div>
                </div>
                {c.status === "open" ? (
                  <div className="conflict-actions">
                    <button
                      className="mini primary"
                      disabled={!isAdmin || !state.online}
                      title={!isAdmin ? "仅管理员可裁决" : !state.online ? "需在线操作" : ""}
                      onClick={() => decideConflict(c.id, "server")}
                    >
                      保留管理员值
                    </button>
                    <button
                      className="mini"
                      disabled={!isAdmin || !state.online}
                      title={!isAdmin ? "仅管理员可裁决" : !state.online ? "需在线操作" : ""}
                      onClick={() => decideConflict(c.id, "offline")}
                    >
                      采用离线值
                    </button>
                    {!isAdmin && <span className="muted-text">复核批次与冲突裁决仅管理员可操作</span>}
                  </div>
                ) : (
                  <p className="muted-text">
                    裁决结果：保留{c.winner === "server" ? "管理员" : "离线"}版本「{c.resolvedValue}」 ·{" "}
                    {c.resolvedAt && nowText(c.resolvedAt)}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {state.lastReport && (
        <section className="panel report-panel">
          <h2>上次同步报告 · {nowText(state.lastReport.at)}</h2>
          <p>
            直接应用 <strong>{state.lastReport.applied}</strong> 项 · 冲突{" "}
            <strong>{state.lastReport.conflicts.length}</strong> 处 · 染色失效{" "}
            <strong>{state.lastReport.invalidated.length}</strong> 条 · 跳过 {state.lastReport.skipped.length} 项
          </p>
          {state.lastReport.conflicts.map((c) => (
            <p key={c.id} className="report-warn">
              ⚠ 冲突：{c.entityName} 的「{FIELD_LABELS[c.field]}」两版不一致，已保留双版本
            </p>
          ))}
          {state.lastReport.invalidated.map((i) => (
            <p key={i.recordId} className="report-warn">
              ⛔ {i.reason}
            </p>
          ))}
          {state.lastReport.notes.map((n, i) => (
            <p key={i} className="muted-text">
              · {n}
            </p>
          ))}
        </section>
      )}
    </main>
  );
}

/* ---------- 指标卡 ---------- */

function MetricCard({ label, value, tone, note }: { label: string; value: number; tone: string; note?: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong className={`num tone-${tone}`}>{value}</strong>
      {note && <small>{note}</small>}
      <i className={`status-bar status-${tone}`} />
    </article>
  );
}

/* ---------- 样本卡 ---------- */

function SampleCard({
  state,
  sample,
  records,
  onSaveField,
  onAddRecord,
  onRereview,
}: {
  state: AppState;
  sample: Sample;
  records: FieldRecord[];
  onSaveField: (id: string, field: MergeableField, v: string) => void;
  onAddRecord: (sampleId: string, values: Record<RecordFieldKey, string>) => void;
  onRereview: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Record<RecordFieldKey, string>>({
    structure: "",
    magnification: "400x",
    description: "",
  });
  const pending = (f: MergeableField) =>
    state.outbox.some((o) => o.type === "editField" && o.entityId === sample.id && o.field === f);

  return (
    <article className="sample-card">
      <header>
        <h3>{sample.fields.name.value}</h3>
        <Badge tone="muted">染色版本 v{sample.stainingRev}</Badge>
      </header>
      <div className="efield-grid">
        <EditableField
          label={FIELD_LABELS.name}
          fv={sample.fields.name}
          pending={pending("name")}
          onSave={(v) => v && onSaveField(sample.id, "name", v)}
        />
        <EditableField
          label={FIELD_LABELS.specimenType}
          fv={sample.fields.specimenType}
          pending={pending("specimenType")}
          onSave={(v) => v && onSaveField(sample.id, "specimenType", v)}
        />
        <EditableField
          label={FIELD_LABELS.staining}
          fv={sample.fields.staining}
          pending={pending("staining")}
          onSave={(v) => v && onSaveField(sample.id, "staining", v)}
        />
      </div>
      {pending("staining") && (
        <p className="warn-text">本机改了染色方式：同步生效后，旧版本下的关联视野记录将全部失效退回待复核。</p>
      )}

      <div className="record-rows">
        {records.map((r) => {
          const rp = (f: MergeableField) =>
            state.outbox.some((o) => o.type === "editField" && o.entityId === r.id && o.field === f);
          return (
            <div key={r.id} className={`record-row status-${r.status}`}>
              <div className="record-row-head">
                <Badge
                  tone={r.status === "valid" ? "ok" : r.status === "pending" ? "info" : "danger"}
                >
                  {reviewStatusLabel(r.status)}
                </Badge>
                <span className="muted-text">
                  记录 {r.id.slice(-6)}
                  {r.batchIds.length > 0 && ` · 在 ${r.batchIds.length} 个批次中`}
                </span>
                {r.status === "invalidated" && (
                  <button className="mini primary" onClick={() => onRereview(r.id)}>
                    重新观察后提交复核
                  </button>
                )}
              </div>
              {r.invalidateReason && <p className="warn-text">{r.invalidateReason}</p>}
              <div className="efield-grid">
                <EditableField
                  label={FIELD_LABELS.structure}
                  fv={r.fields.structure}
                  pending={rp("structure")}
                  onSave={(v) => v && onSaveField(r.id, "structure", v)}
                />
                <EditableField
                  label={FIELD_LABELS.magnification}
                  fv={r.fields.magnification}
                  pending={rp("magnification")}
                  onSave={(v) => v && onSaveField(r.id, "magnification", v)}
                />
                <EditableField
                  label={FIELD_LABELS.description}
                  fv={r.fields.description}
                  pending={rp("description")}
                  multiline
                  onSave={(v) => onSaveField(r.id, "description", v)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {adding ? (
        <div className="add-form">
          <h4>补记视野记录（染色快照：{sample.fields.staining.value} v{sample.stainingRev}）</h4>
          <div className="field-grid">
            <label>
              <span>观察结构</span>
              <input value={form.structure} onChange={(e) => setForm({ ...form, structure: e.target.value })} />
            </label>
            <label>
              <span>放大倍数</span>
              <input
                value={form.magnification}
                onChange={(e) => setForm({ ...form, magnification: e.target.value })}
              />
            </label>
            <label className="full">
              <span>视野描述</span>
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
          </div>
          <div className="row-actions">
            <button
              className="primary"
              onClick={() => {
                if (!form.structure) return;
                onAddRecord(sample.id, form);
                setForm({ structure: "", magnification: "400x", description: "" });
                setAdding(false);
              }}
            >
              {state.online ? "提交（待复核）" : "存本机，联网后上传"}
            </button>
            <button onClick={() => setAdding(false)}>取消</button>
          </div>
        </div>
      ) : (
        <button className="mini" onClick={() => setAdding(true)}>
          ＋ 补记视野记录
        </button>
      )}
    </article>
  );
}

/* ---------- 批次面板 ---------- */

function BatchPanel({
  state,
  view,
  isAdmin,
  onSubmit,
  onArchive,
}: {
  state: AppState;
  view: ReturnType<typeof selectView>;
  isAdmin: boolean;
  onSubmit: (name: string, ids: string[]) => void;
  onArchive: (id: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const pickable = view.records.filter(
    (r) =>
      r.status === "pending" &&
      !view.batches.some((b) => b.status === "pending" && b.entryIds.includes(r.id))
  );

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  return (
    <div className="batch-panel">
      <h2>复核批次</h2>
      <p className="muted-text">教师可提交批次；只有管理员能确认归档。染色变更后条目自动从待归档批次摘除。</p>

      {picking ? (
        <div className="batch-pick">
          <input
            placeholder="批次名称，如 第 2 批 · 植物组织"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="pick-list">
            {pickable.length === 0 && <p className="muted-text">暂无可纳入的待复核记录</p>}
            {pickable.map((r) => {
              const sample = view.samples.find((s) => s.id === r.sampleId);
              return (
                <label key={r.id} className="pick-item">
                  <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
                  <span>
                    {sample?.fields.name.value} · {r.fields.structure.value}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="row-actions">
            <button
              className="primary"
              onClick={() => {
                if (!name || picked.size === 0) return;
                onSubmit(name, [...picked]);
                setName("");
                setPicked(new Set());
                setPicking(false);
              }}
            >
              {state.online ? "提交批次" : "存本机待同步"}
            </button>
            <button onClick={() => setPicking(false)}>取消</button>
          </div>
        </div>
      ) : (
        <button className="mini" onClick={() => setPicking(true)}>
          ＋ 新建复核批次
        </button>
      )}

      <div className="batch-list">
        {view.batches.map((b) => (
          <article key={b.id} className={`batch-card ${b.status}`}>
            <header>
              <strong>{b.name}</strong>
              {b.draft && <Badge tone="warn">本机草稿</Badge>}
              <Badge tone={b.status === "archived" ? "ok" : "info"}>{batchStatusLabel(b.status)}</Badge>
            </header>
            <p className="muted-text">
              {b.entryIds.length} 条 · 建 {nowText(b.createdAt)}
              {b.archivedAt && ` · 归档 ${nowText(b.archivedAt)}（${b.archivedBy === "admin" ? "管理员" : "—"}）`}
            </p>
            <ul className="batch-entries">
              {b.entryIds.map((id) => {
                const rec = view.records.find((r) => r.id === id);
                const sample = rec ? view.samples.find((s) => s.id === rec.sampleId) : null;
                const stale = b.status === "archived" && rec && rec.status !== "valid";
                return (
                  <li key={id} className={stale ? "stale" : ""}>
                    {sample?.fields.name.value ?? "?"} · {rec?.fields.structure.value ?? "（记录缺失）"}
                    {stale && <Badge tone="danger">归档后染色变更，已失效</Badge>}
                  </li>
                );
              })}
            </ul>
            {b.status === "pending" && (
              <button
                className="mini primary"
                disabled={!isAdmin || !state.online}
                title={!isAdmin ? "仅管理员可归档" : !state.online ? "需在线归档" : ""}
                onClick={() => onArchive(b.id)}
              >
                {isAdmin ? (state.online ? "管理员确认归档" : "离线不可归档") : "仅管理员可归档"}
              </button>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

/* ---------- 云端并发模拟 ---------- */

function CloudSimulator({
  view,
  serverRecords,
  onAdminEdit,
}: {
  view: ReturnType<typeof selectView>;
  serverRecords: FieldRecord[];
  onAdminEdit: (id: string, field: MergeableField, value: string) => void;
}) {
  const [sampleSel, setSampleSel] = useState(view.samples[0]?.id ?? "");
  const [stain, setStain] = useState("结晶紫染色");
  // 只模拟云端已存在的记录（本机草稿尚未上传，管理员无法改到）
  const cloudRecords = serverRecords;
  const [recSel, setRecSel] = useState(cloudRecords[0]?.id ?? "");
  const [structure, setStructure] = useState("管理员修订：细胞核与核仁");

  return (
    <div className="cloud-sim">
      <span className="cloud-title">☁ 云端并发模拟（教师本机离线时，管理员仍在线操作）</span>
      <div className="cloud-row">
        <select value={sampleSel} onChange={(e) => setSampleSel(e.target.value)}>
          {view.samples.map((s) => (
            <option key={s.id} value={s.id}>
              样本：{s.fields.name.value}（当前染色：{s.fields.staining.value}）
            </option>
          ))}
        </select>
        <input value={stain} onChange={(e) => setStain(e.target.value)} placeholder="管理员改染色方式为" />
        <button className="mini warn" onClick={() => sampleSel && stain && onAdminEdit(sampleSel, "staining", stain)}>
          管理员改染色方式
        </button>
      </div>
      <div className="cloud-row">
        <select value={recSel} onChange={(e) => setRecSel(e.target.value)}>
          {cloudRecords.map((r) => {
            const s = view.samples.find((x) => x.id === r.sampleId);
            return (
              <option key={r.id} value={r.id}>
                视野：{s?.fields.name.value} / {r.fields.structure.value}
              </option>
            );
          })}
        </select>
        <input value={structure} onChange={(e) => setStructure(e.target.value)} placeholder="管理员改观察结构为" />
        <button className="mini warn" onClick={() => recSel && structure && onAdminEdit(recSel, "structure", structure)}>
          管理员改观察结构
        </button>
      </div>
      <p className="muted-text">提示：管理员改染色后，云端关联记录立即失效；本机恢复同步时，同字段改动会产生双版本冲突。</p>
    </div>
  );
}
