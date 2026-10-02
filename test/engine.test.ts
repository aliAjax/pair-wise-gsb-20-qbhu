import assert from "node:assert";
import { initialState, runSync, applyServerFieldEdit, archiveBatch, selectView, computeStats, requestReview, uid, createBatch } from "../src/engine";
import type { AppState } from "../src/types";

let pass = 0;
const ok = (name: string, cond: boolean) => {
  assert.ok(cond, name);
  pass++;
  console.log("  ✓", name);
};

// 场景 1：教师离线改字段，管理员未动 → 快进
{
  let st = initialState("teacher");
  st.online = false;
  st.base = JSON.parse(JSON.stringify(st.server));
  const sample = st.base.samples[0];
  // 教师离线补记：样本名称 + 一条新视野记录的结构
  st.outbox.push({
    id: uid("op"), type: "editField", entityId: sample.id, field: "name",
    value: "洋葱表皮（补记）", baseRev: sample.fields.name.rev, actor: "teacher", at: Date.now(),
  });
  const rec = st.base.records.find((r) => r.id === "f_para_1")!;
  st.outbox.push({
    id: uid("op"), type: "editField", entityId: rec.id, field: "structure",
    value: "纤毛、口沟、伸缩泡", baseRev: rec.fields.structure.rev, actor: "teacher", at: Date.now(),
  });
  const { server, report } = runSync(st);
  ok("场景1: 两项改动直接应用", report.applied === 2 && report.conflicts.length === 0);
  ok("场景1: 名称快进成功", server.samples[0].fields.name.value === "洋葱表皮（补记）");
  ok("场景1: 版本号递增", server.samples[0].fields.name.rev === 2);
  const r = server.records.find((x) => x.id === "f_para_1")!;
  ok("场景1: 视野结构快进成功", r.fields.structure.value === "纤毛、口沟、伸缩泡");
}

// 场景 2：两边改同一字段 → 管理员值保留，离线值另存冲突
{
  let st = initialState("teacher");
  st.online = false;
  st.base = JSON.parse(JSON.stringify(st.server));
  const rec = st.base.records.find((r) => r.id === "f_onion_1")!;
  // 教师离线改观察结构
  st.outbox.push({
    id: uid("op"), type: "editField", entityId: rec.id, field: "structure",
    value: "教师离线版：细胞壁", baseRev: rec.fields.structure.rev, actor: "teacher", at: Date.now(),
  });
  // 管理员在云端改同一字段
  applyServerFieldEdit(st.server, rec.id, "structure", "管理员版：细胞核与核仁", "admin");
  // 管理员同时改了另一个教师没动的字段——不应产生冲突
  applyServerFieldEdit(st.server, rec.id, "magnification", "油镜1000x", "admin");

  const { server, report } = runSync(st);
  const after = server.records.find((x) => x.id === rec.id)!;
  ok("场景2: 产生 1 处冲突", report.conflicts.length === 1);
  ok("场景2: 管理员值未被覆盖", after.fields.structure.value === "管理员版：细胞核与核仁");
  ok("场景2: 管理员版本号保留", after.fields.structure.rev === 2);
  const cf = server.conflicts[0];
  ok("场景2: 冲突保留双版本", cf.serverValue === "管理员版：细胞核与核仁" && cf.offlineValue === "教师离线版：细胞壁");
  ok("场景2: 冲突未决", cf.status === "open");
  ok("场景2: 教师没动的字段不产生冲突", server.conflicts.length === 1 && after.fields.magnification.value === "油镜1000x");
}

// 场景 3：管理员改染色方式 → 关联记录失效、退出待归档批次、不算有效统计
{
  let st = initialState("teacher");
  const onion = st.server.samples.find((s) => s.id === "sp_onion")!;
  // 先建一个待归档批次，包含 pending 的 f_onion_2
  st.online = true;
  const server1 = JSON.parse(JSON.stringify(st.server));
  const batch = createBatch(server1, "测试批次", ["f_onion_2", "f_para_1"], "teacher");
  st.server = server1;
  st.base = JSON.parse(JSON.stringify(server1));
  ok("场景3: 批次纳入 2 条待复核", batch.entryIds.length === 2);

  // 管理员改染色
  const { invalidated } = applyServerFieldEdit(st.server, onion.id, "staining", "苏丹Ⅲ染色", "admin");
  const invIds = invalidated.map((r: any) => r.id);
  ok("场景3: 洋葱两条记录失效", invIds.includes("f_onion_1") && invIds.includes("f_onion_2"));
  ok("场景3: 其他样本记录不受影响", !invIds.includes("f_para_1"));

  const b = st.server.batches.find((x) => x.id === batch.id)!;
  ok("场景3: 失效记录从待归档批次摘除", !b.entryIds.includes("f_onion_2") && b.entryIds.includes("f_para_1"));

  // 归档权限在 UI 层（仅管理员+在线可点）；engine 层归档时还会把非 pending 条目摘除
  const f1 = st.server.records.find((r) => r.id === "f_onion_1")!;
  ok("场景3: 失效记录状态为 invalidated", f1.status === "invalidated");
  ok("场景3: 带失效原因", !!f1.invalidateReason && f1.invalidateReason.includes("苏丹Ⅲ染色"));
  ok("场景3: 有效统计不含失效记录", computeStats(selectView(st)).validCount === 1); // 只剩 f_blood_1
  ok("场景3: 退回数为 2", computeStats(selectView(st)).invalidatedCount === 2);

  // 重新复核 → 回到 pending；管理员再改染色 → 再次失效
  const rr = requestReview(st.server, "f_onion_2");
  ok("场景3: 重新复核成功", rr.ok);
  const f2 = st.server.records.find((r) => r.id === "f_onion_2")!;
  ok("场景3: 重新复核后状态 pending", f2.status === "pending");
  applyServerFieldEdit(st.server, onion.id, "staining", "龙胆紫", "admin");
  const f2b = st.server.records.find((r) => r.id === "f_onion_2")!;
  ok("场景3: 染色再变 → 再次退回", f2b.status === "invalidated");
}

// 场景 4：离线期间管理员改染色，教师的离线批次/重新复核同步时被挡住
{
  let st = initialState("teacher");
  st.online = false;
  st.base = JSON.parse(JSON.stringify(st.server));
  const onion = st.base.samples.find((s) => s.id === "sp_onion")!;
  // 教师在旧染色下给已失效…（初始为 pending）记录提重新复核，并建批次
  st.outbox.push({
    id: uid("op"), type: "requestReview", recordId: "f_onion_2",
    stainingSnapshot: "碘液", stainingRev: 1, at: Date.now(),
  });
  st.outbox.push({
    id: uid("op"), type: "createBatch", batchId: "rb_off", name: "离线上传批次",
    entryIds: ["f_onion_2"], at: Date.now(),
  });
  // 管理员云端改染色
  applyServerFieldEdit(st.server, onion.id, "staining", "结晶紫", "admin");
  const { server, report } = runSync(st);
  const rec = server.records.find((r) => r.id === "f_onion_2")!;
  ok("场景4: 旧染色版本的重新复核被挡", rec.status === "invalidated");
  const batch = server.batches.find((b) => b.id === "rb_off")!;
  ok("场景4: 离线批次同步后不含失效条目", batch.entryIds.length === 0);
  ok("场景4: 报告里有说明", report.notes.some((n) => n.includes("失效")));
}

// 场景 5：离线新建记录，同步时染色已变 → 直接退回待复核
{
  let st = initialState("teacher");
  st.online = false;
  st.base = JSON.parse(JSON.stringify(st.server));
  const onion = st.base.samples.find((s) => s.id === "sp_onion")!;
  const rid = uid("f");
  st.draftRecords = [];
  st.outbox.push({
    id: uid("op"), type: "createRecord", recordId: rid, sampleId: onion.id,
    values: { structure: "新结构", magnification: "400x", description: "离线补记" },
    stainingSnapshot: "碘液", stainingRev: 1, at: Date.now(),
  });
  applyServerFieldEdit(st.server, onion.id, "staining", "番红染色", "admin");
  const { server } = runSync(st);
  const rec = server.records.find((r) => r.id === rid)!;
  ok("场景5: 离线新记录已上传", !!rec);
  ok("场景5: 染色版本落后 → 直接退回待复核", rec.status === "invalidated");
}

// 场景 6：归档后染色再变——归档批次冻结，但条目标失效
{
  let st = initialState("teacher");
  // 用 pending 记录建批再归档
  const b = createBatch(st.server, "新批", ["f_para_1"], "teacher");
  const a = archiveBatch(st.server, b.id);
  ok("场景6: 管理员归档成功", a.ok && a.archived === 1);
  const para = st.server.samples.find((s) => s.id === "sp_paramecium")!;
  applyServerFieldEdit(st.server, para.id, "staining", "甲基绿", "admin");
  const frozen = st.server.batches.find((x) => x.id === b.id)!;
  ok("场景6: 归档批次不被删改", frozen.status === "archived" && frozen.entryIds.includes("f_para_1"));
  const rec = st.server.records.find((r) => r.id === "f_para_1")!;
  ok("场景6: 记录本身退回失效", rec.status === "invalidated");
  ok("场景6: 有效统计排除", computeStats(selectView(st)).validCount === 2);
}

console.log(`\n全部通过：${pass} 项断言`);
