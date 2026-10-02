import { useMemo, useState } from "react";
import "./styles.css";
import type { ConflictEntry, ObservationRecord, Role } from "./types";
import { RECORD_FIELDS, STAIN_OPTIONS } from "./types";
import {
  archiveBatch,
  changeStain,
  confirmRecord,
  createBatch,
  createRecord,
  discardOp,
  exportReport,
  resetDemo,
  resolveConflict,
  setOnline,
  setRole,
  stageFieldUpdates,
  stagedView,
  stats,
  syncNow,
  useDB,
  type DB,
} from "./store";

const fmtTime = (wall: number) =>
  new Date(wall).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

const STATUS_LABEL = { valid: "有效", pending: "待复核", conflict: "有冲突" } as const;

type Attempt = (fn: () => void, okMsg?: string) => void;

function App() {
  const db = useDB();
  const [toast, setToast] = useState<string | null>(null);

  const attempt: Attempt = (fn, okMsg) => {
    try {
      fn();
      if (okMsg) showToast(okMsg);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };

  const showToast = (msg: string) => {
    setToast(msg);
    window.clearTimeout((showToast as { t?: number }).t);
    (showToast as { t?: number }).t = window.setTimeout(() => setToast(null), 3600);
  };

  const view = useMemo(() => stagedView(db), [db]);
  const st = useMemo(() => stats(db), [db]);

  const doExport = () => {
    const text = exportReport(db);
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `显微镜观察导出-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("已导出报告（含冲突说明）");
  };

  return (
    <main className="app-shell">
      <header className="topbar panel">
        <div>
          <p className="eyebrow">hxwl-06 · 显微镜玻片观察</p>
          <h1>离线补记与复核协同台</h1>
          <p className="subtitle">
            样本 → 视野记录 → 复核批次 已串联。教师离线补记先留在本机，网络恢复后逐字段合并；管理员改过的字段不会被后到的离线值覆盖，同字段双改保留两版并标冲突。
          </p>
        </div>
        <div className="topbar-controls">
          <div className="seg">
            <span className="seg-label">当前身份</span>
            {(["teacher", "admin"] as Role[]).map((r) => (
              <button key={r} className={db.role === r ? "active" : ""} onClick={() => setRole(r)}>
                {r === "admin" ? "管理员" : "教师"}
              </button>
            ))}
          </div>
          <div className="seg">
            <span className="seg-label">网络</span>
            <button className={db.online ? "active" : ""} onClick={() => setOnline(true)}>
              在线
            </button>
            <button className={!db.online ? "active danger" : ""} onClick={() => setOnline(false)}>
              离线
            </button>
          </div>
          <button className="primary-action" disabled={!db.online || st.pendingOps === 0} onClick={() => attempt(syncNow, "同步完成")}>
            立即同步{st.pendingOps > 0 ? `（${st.pendingOps}）` : ""}
          </button>
          <button onClick={doExport}>导出报告</button>
          <button className="ghost" onClick={() => attempt(resetDemo, "已重置演示数据")}>
            重置演示
          </button>
        </div>
      </header>

      <section className="metrics-grid">
        <Metric label="样本数" value={st.samples} tone="ok" />
        <Metric label="有效视野记录" value={st.valid} tone="ok" hint={`共 ${st.total} 条，仅统计有效`} />
        <Metric label="待复核（已失效）" value={st.pending} tone="warn" hint="不计入有效统计" />
        <Metric label="未解决冲突" value={st.openConflicts} tone={st.openConflicts > 0 ? "danger" : "ok"} />
        <Metric label="本机待同步" value={st.pendingOps} tone={st.pendingOps > 0 ? "warn" : "ok"} hint={db.online ? "联网中" : "离线，留在本机"} />
        <Metric label="已归档批次" value={`${st.archived}/${st.batches}`} tone="ok" />
      </section>

      <details className="panel guide">
        <summary>演示流程：复现「教师离线补记 × 管理员同时改染色/结构」</summary>
        <ol>
          <li>切到 <b>离线</b>，以教师身份在某条记录上点「补记/修改」，改「观察结构」等字段并保存 —— 改动只留在本机（右侧待同步列表可见），刷新页面也不会丢。</li>
          <li>保持离线，切到 <b>管理员</b>（管理员在服务端，不受离线开关影响），修改该样本的「染色方式」或同一条记录的「观察结构」。</li>
          <li>切回教师并恢复 <b>在线</b>：待同步改动逐字段合并 —— 管理员改过的字段不被覆盖，同字段双改会保留两版并标出冲突。</li>
          <li>染色方式变更后，该样本所有记录退回「待复核」并退出有效统计；由管理员逐条「复核确认」恢复。</li>
          <li>管理员裁决冲突后，才能在批次卡片上「确认归档」；最后点「导出报告」查看带冲突说明的 Markdown。</li>
        </ol>
      </details>

      <div className="layout">
        <aside className="side">
          <SamplesPanel db={db} attempt={attempt} />
          <BatchesPanel db={db} attempt={attempt} />
          <OutboxPanel db={db} attempt={attempt} />
        </aside>
        <RecordsPanel db={db} view={view} attempt={attempt} showToast={showToast} />
      </div>

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

function Metric({ label, value, tone, hint }: { label: string; value: number | string; tone: "ok" | "warn" | "danger"; hint?: string }) {
  return (
    <article className={`metric-card tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <em>{hint}</em>}
      <i />
    </article>
  );
}

/* ---------------- 样本与染色 ---------------- */

function SamplesPanel({ db, attempt }: { db: DB; attempt: Attempt }) {
  const [stainPick, setStainPick] = useState<Record<string, string>>({});
  return (
    <section className="panel">
      <h2 className="panel-title">样本与染色方式</h2>
      <div className="stack">
        {db.samples.map((s) => {
          const affected = db.records.filter((r) => r.sampleId === s.id).length;
          const pick = stainPick[s.id] ?? s.stainMethod;
          return (
            <article key={s.id} className="sample-card">
              <div className="sample-head">
                <strong>{s.name}</strong>
                <span className="tag">{s.type}</span>
              </div>
              <p className="muted">
                染色方式：<b>{s.stainMethod}</b>（v{s.stainVersion}） · 关联记录 {affected} 条
              </p>
              {db.role === "admin" && (
                <div className="row">
                  <select value={pick} onChange={(e) => setStainPick({ ...stainPick, [s.id]: e.target.value })}>
                    {STAIN_OPTIONS.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={pick === s.stainMethod}
                    title="管理员在服务端直接修改；关联记录退回待复核"
                    onClick={() =>
                      attempt(() => {
                        if (
                          window.confirm(
                            `将「${s.name}」的染色方式由「${s.stainMethod}」改为「${pick}」？\n关联的 ${affected} 条记录将失效并退回待复核，不再计入有效统计。`
                          )
                        ) {
                          changeStain(s.id, pick);
                        }
                      }, "染色方式已修改，关联记录已退回待复核")
                    }
                  >
                    修改染色
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

/* ---------------- 复核批次 ---------------- */

function BatchesPanel({ db, attempt }: { db: DB; attempt: Attempt }) {
  const [name, setName] = useState("");
  return (
    <section className="panel">
      <h2 className="panel-title">复核批次</h2>
      <div className="stack">
        {db.batches.map((b) => {
          const recs = db.records.filter((r) => r.batchId === b.id);
          const valid = recs.filter((r) => r.status === "valid").length;
          const openConflicts = recs.flatMap((r) => r.conflicts).filter((c) => !c.resolved).length;
          return (
            <article key={b.id} className={`batch-card ${b.status}`}>
              <div className="sample-head">
                <strong>{b.name}</strong>
                <span className={`tag ${b.status === "archived" ? "tag-gray" : "tag-teal"}`}>
                  {b.status === "archived" ? "已归档" : "复核中"}
                </span>
              </div>
              <p className="muted">
                记录 {recs.length} 条 · 有效 {valid} 条{openConflicts > 0 ? ` · ${openConflicts} 处未决冲突` : ""}
              </p>
              {b.status === "archived" ? (
                <p className="muted">由 {b.archivedBy} 于 {b.archivedAt ? fmtTime(b.archivedAt) : "—"} 归档，记录已锁定</p>
              ) : (
                db.role === "admin" && (
                  <button
                    disabled={openConflicts > 0}
                    title={openConflicts > 0 ? "存在未解决冲突，不能归档" : "仅管理员可确认归档"}
                    onClick={() =>
                      attempt(() => {
                        if (window.confirm(`确认归档「${b.name}」？归档后记录锁定，不能再修改。`)) archiveBatch(b.id);
                      }, "批次已归档")
                    }
                  >
                    确认归档（仅管理员）
                  </button>
                )
              )}
            </article>
          );
        })}
      </div>
      <div className="row new-batch">
        <input placeholder="新批次名称，如：第8周观察复核" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          onClick={() =>
            attempt(() => {
              createBatch(name);
              setName("");
            }, db.online ? "批次已创建" : "批次已暂存本机，联网后同步")
          }
        >
          新建
        </button>
      </div>
      <p className="muted small">仅管理员可确认归档；存在未解决冲突的批次不能归档。</p>
    </section>
  );
}

/* ---------------- 本机待同步 ---------------- */

function OutboxPanel({ db, attempt }: { db: DB; attempt: Attempt }) {
  const pending = db.outbox.filter((o) => !o.applied);
  return (
    <section className="panel">
      <h2 className="panel-title">本机待同步（{pending.length}）</h2>
      {!db.online && <p className="banner warn">当前离线：改动只保存在本机，网络恢复后逐字段合并；重开页面可继续处理。</p>}
      {pending.length === 0 ? (
        <p className="muted">没有待同步的改动。</p>
      ) : (
        <ul className="outbox">
          {pending.map((o) => (
            <li key={o.id}>
              <div>
                {o.kind === "field.update" && (
                  <span>
                    改「{o.field}」→ <b>{o.value.value}</b>
                  </span>
                )}
                {o.kind === "record.create" && <span>新增记录 {o.record.id.slice(0, 6)}</span>}
                {o.kind === "batch.create" && <span>新建批次「{o.batch.name}」</span>}
                <em className="muted small">
                  {o.actorName} · {fmtTime(o.createdAt)}
                </em>
              </div>
              <button className="ghost small-btn" onClick={() => attempt(() => discardOp(o.id), "已撤销该改动")}>
                撤销
              </button>
            </li>
          ))}
        </ul>
      )}
      {db.lastSync && (
        <div className="sync-log">
          <p className="muted small">上次同步：{fmtTime(db.lastSync.at)}</p>
          {db.lastSync.entries.length === 0 ? (
            <p className="muted small">无待合并内容</p>
          ) : (
            <ul>
              {db.lastSync.entries.map((e) => (
                <li key={e.opId} className={`sync-${e.result}`}>
                  {e.result === "applied" ? "✓" : e.result === "conflict" ? "⚠" : "✕"} {e.label}
                  {e.note ? `（${e.note}）` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------------- 视野记录 ---------------- */

function RecordsPanel({
  db,
  view,
  attempt,
  showToast,
}: {
  db: DB;
  view: ReturnType<typeof stagedView>;
  attempt: Attempt;
  showToast: (m: string) => void;
}) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [batchFilter, setBatchFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);

  const committed = useMemo(() => new Map(db.records.map((r) => [r.id, r])), [db.records]);
  const sampleOf = (id: string) => db.samples.find((s) => s.id === id);
  const batchOf = (id: string) => db.batches.find((b) => b.id === id);

  const list = view.records
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((r) => {
      if (batchFilter !== "all" && r.batchId !== batchFilter) return false;
      if (statusFilter === "staged") return view.newRecordIds.includes(r.id) || (view.stagedFields[r.id]?.length ?? 0) > 0;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      return true;
    });

  return (
    <section className="panel records-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">样本 → 视野记录 → 复核批次</p>
          <h2>视野记录</h2>
        </div>
        <div className="row">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">全部状态</option>
            <option value="valid">有效</option>
            <option value="pending">待复核</option>
            <option value="conflict">有冲突</option>
            <option value="staged">本机未同步</option>
          </select>
          <select value={batchFilter} onChange={(e) => setBatchFilter(e.target.value)}>
            <option value="all">全部批次</option>
            {db.batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button className="primary-action" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "收起" : "新增记录"}
          </button>
        </div>
      </div>

      {showForm && <NewRecordForm db={db} attempt={attempt} onDone={() => setShowForm(false)} />}

      <div className="record-list">
        {list.length === 0 && <p className="muted">没有符合条件的记录。</p>}
        {list.map((r) => (
          <RecordCard
            key={r.id}
            rec={r}
            committed={committed.get(r.id)}
            staged={view.stagedFields[r.id] ?? []}
            isNew={view.newRecordIds.includes(r.id)}
            sampleName={sampleOf(r.sampleId)?.name ?? "?"}
            batch={batchOf(r.batchId)}
            db={db}
            attempt={attempt}
            showToast={showToast}
          />
        ))}
      </div>
    </section>
  );
}

function NewRecordForm({ db, attempt, onDone }: { db: DB; attempt: Attempt; onDone: () => void }) {
  const openBatches = db.batches.filter((b) => b.status === "open");
  const [sampleId, setSampleId] = useState(db.samples[0]?.id ?? "");
  const [batchId, setBatchId] = useState(openBatches[0]?.id ?? "");
  const sample = db.samples.find((s) => s.id === sampleId);
  const [fields, setFields] = useState<Record<string, string>>({
    染色方式: sample?.stainMethod ?? "",
    放大倍数: "400x",
    观察结构: "",
    视野描述: "",
  });

  const submit = () =>
    attempt(() => {
      createRecord({ sampleId, batchId, fields });
      onDone();
    }, db.online ? "记录已保存并同步" : "记录已暂存本机，联网后自动合并");

  return (
    <div className="new-record">
      <div className="field-grid">
        <label>
          <span>样本</span>
          <select
            value={sampleId}
            onChange={(e) => {
              setSampleId(e.target.value);
              const s = db.samples.find((x) => x.id === e.target.value);
              if (s) setFields((f) => ({ ...f, 染色方式: s.stainMethod }));
            }}
          >
            {db.samples.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>复核批次</span>
          <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
            {openBatches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        {RECORD_FIELDS.map((f) => (
          <label key={f}>
            <span>{f}</span>
            <input value={fields[f] ?? ""} placeholder={`填写${f}`} onChange={(e) => setFields({ ...fields, [f]: e.target.value })} />
          </label>
        ))}
      </div>
      <div className="row end">
        <button className="primary-action" disabled={openBatches.length === 0} onClick={submit}>
          保存{db.online ? "" : "到本机"}
        </button>
      </div>
    </div>
  );
}

function RecordCard({
  rec,
  committed,
  staged,
  isNew,
  sampleName,
  batch,
  db,
  attempt,
  showToast,
}: {
  rec: ObservationRecord;
  committed?: ObservationRecord;
  staged: string[];
  isNew: boolean;
  sampleName: string;
  batch?: { id: string; name: string; status: string };
  db: DB;
  attempt: Attempt;
  showToast: (m: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const archived = batch?.status === "archived";
  const openConflicts = rec.conflicts.filter((c) => !c.resolved);

  const startEdit = () => {
    setDraft(Object.fromEntries(RECORD_FIELDS.map((f) => [f, rec.fields[f]?.value ?? ""])));
    setEditing(true);
  };

  const save = () =>
    attempt(() => {
      const changes = RECORD_FIELDS.filter((f) => (draft[f] ?? "") !== (rec.fields[f]?.value ?? "")).map((f) => ({
        field: f,
        value: draft[f] ?? "",
      }));
      if (changes.length === 0) {
        setEditing(false);
        return;
      }
      stageFieldUpdates(rec.id, changes);
      setEditing(false);
      showToast(db.online ? "已保存并合并" : "已保存到本机，联网后逐字段合并");
    });

  return (
    <article className={`record-card status-${rec.status}`}>
      <header className="record-head">
        <div>
          <strong>{sampleName}</strong>
          <span className="muted"> · {batch?.name ?? "?"}</span>
          <span className="muted small"> · #{rec.id.slice(0, 6)} · {rec.createdBy}</span>
        </div>
        <div className="tags">
          {isNew && <span className="tag tag-amber">本机新增·待同步</span>}
          <span className={`tag tag-${rec.status}`}>{STATUS_LABEL[rec.status]}</span>
        </div>
      </header>

      {rec.invalidReason && rec.status === "pending" && <p className="banner warn">⚠ {rec.invalidReason}</p>}

      <div className="fields">
        {RECORD_FIELDS.map((f) => {
          const v = rec.fields[f];
          const isStaged = staged.includes(f);
          const committedVal = committed?.fields[f]?.value;
          const hasConflict = openConflicts.some((c) => c.field === f);
          return (
            <div key={f} className={`field ${isStaged ? "staged" : ""} ${hasConflict ? "conflicted" : ""}`}>
              <span className="field-label">
                {f}
                {isStaged && <em className="tag tag-amber">待同步</em>}
                {hasConflict && <em className="tag tag-danger">冲突</em>}
              </span>
              {editing ? (
                <input value={draft[f] ?? ""} onChange={(e) => setDraft({ ...draft, [f]: e.target.value })} />
              ) : (
                <>
                  <b>{v?.value ?? "—"}</b>
                  {v && (
                    <span className="muted small">
                      {v.authorName} · {fmtTime(v.wall)}
                    </span>
                  )}
                  {isStaged && committedVal !== undefined && committedVal !== v?.value && (
                    <span className="muted small">已同步值：{committedVal}</span>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {rec.conflicts.length > 0 && (
        <div className="conflicts">
          {rec.conflicts.map((c) => (
            <ConflictBox key={c.id} rec={rec} c={c} db={db} attempt={attempt} />
          ))}
        </div>
      )}

      <footer className="record-foot">
        {!archived && !editing && (
          <button onClick={startEdit}>补记/修改</button>
        )}
        {editing && (
          <>
            <button className="primary-action" onClick={save}>
              保存{db.online ? "" : "到本机"}
            </button>
            <button className="ghost" onClick={() => setEditing(false)}>
              取消
            </button>
          </>
        )}
        {rec.status === "pending" && db.role === "admin" && (
          <button
            title="确认记录与新染色方式一致，恢复为有效"
            onClick={() => attempt(() => confirmRecord(rec.id), "已复核确认，记录恢复有效")}
          >
            复核确认（仅管理员）
          </button>
        )}
        {archived && <span className="muted small">批次已归档，记录锁定</span>}
      </footer>
    </article>
  );
}

function ConflictBox({ rec, c, db, attempt }: { rec: ObservationRecord; c: ConflictEntry; db: DB; attempt: Attempt }) {
  const current = rec.fields[c.field]?.value;
  return (
    <div className={`conflict-box ${c.resolved ? "resolved" : ""}`}>
      <p className="conflict-title">
        ⚠ 字段「{c.field}」存在两个版本{c.resolved ? `（已解决：采用${c.resolution === "incoming" ? "离线补记" : "服务端"}版）` : "（待管理员裁决）"}
      </p>
      <div className="conflict-versions">
        <div className={!c.resolved && current === c.committed.value ? "version kept" : "version"}>
          <span className="tag tag-blue">服务端 · {c.committed.authorName}</span>
          <b>{c.committed.value}</b>
          <span className="muted small">{fmtTime(c.committed.wall)}</span>
        </div>
        <div className={!c.resolved && current === c.incoming.value ? "version kept" : "version"}>
          <span className="tag tag-amber">离线补记 · {c.incoming.authorName}</span>
          <b>{c.incoming.value}</b>
          <span className="muted small">{fmtTime(c.incoming.wall)}</span>
        </div>
      </div>
      {!c.resolved && (
        <p className="muted small">当前生效值按「管理员优先」暂定；管理员裁决前该记录不计入有效统计。</p>
      )}
      {!c.resolved && db.role === "admin" && (
        <div className="row">
          <button onClick={() => attempt(() => resolveConflict(rec.id, c.id, "committed"), "已保留服务端版本")}>
            保留服务端版
          </button>
          <button onClick={() => attempt(() => resolveConflict(rec.id, c.id, "incoming"), "已采用离线补记版")}>
            采用离线补记版
          </button>
        </div>
      )}
      {c.resolved && (
        <p className="muted small">
          由 {c.resolvedBy} 于 {c.resolvedAt ? fmtTime(c.resolvedAt) : "—"} 处理
        </p>
      )}
    </div>
  );
}

export default App;
