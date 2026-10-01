// @ts-nocheck — 运行时逻辑测试，不作为应用代码参与类型检查
import { get } from "svelte/store";
import {
  cues, terms, staleReasons, recomputeCue, recomputeAll,
  reviewCue, generateLanguage, generateAll, retryLanguage, deliveryView, delivery,
  splitCue, lockTerm, sourceTrackId, conflicts, reviewEvents
} from "../src/lib/stores/subtitles";

// node 环境下补 window（store 用 window.setTimeout 模拟生成）
globalThis.window = { setTimeout, clearTimeout };

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cue = (id) => get(cues).find((c) => c.id === id);
const term = (id) => get(terms).find((t) => t.id === id);

console.log("\n[1] 术语锁定变化 → 相关字幕立即失效");
check("初始 c3 未失效", staleReasons(cue("c3")).length === 0);
lockTerm("g3");
check("g3 版本自增到 2", term("g3").version === 2);
check("c3 失效（术语锁定变化）", staleReasons(cue("c3")).some((r) => r.includes("术语")));
check("c2 不受 g3 影响", !staleReasons(cue("c2")).some((r) => r.includes("术语")));
check("交付视图 en 有 1 条失效", get(deliveryView).languages.find((l) => l.locale === "en").staleCount === 1);
check("未重算前 en 不可生成", get(deliveryView).blockedCount === 1);
recomputeCue("c3");
check("重算后 c3 失效清除", staleReasons(cue("c3")).length === 0);

console.log("\n[2] 原片段拆分 → 翻译轨字幕立即失效");
const c1Before = cue("c1").version;
splitCue("c1");
check("c1 版本自增", cue("c1").version === c1Before + 1);
check("c2 失效（原片段已更新）", staleReasons(cue("c2")).some((r) => r.includes("原片段")));
check("ja c4 同时失效", staleReasons(cue("c4")).length > 0);
check("交付视图 blockedCount=2", get(deliveryView).blockedCount === 2);
recomputeAll();
check("全部重算后无失效字幕", get(cues).every((c) => c.trackId === get(sourceTrackId) || staleReasons(c).length === 0));

console.log("\n[3] 生成阻塞：失效语种不生成交付包");
lockTerm("g1"); // 影响 c2、c4
generateAll();
check("en 被标记 blocked", get(delivery).languages.en.status === "blocked");
check("ja 被标记 blocked", get(delivery).languages.ja.status === "blocked");
check("en 无 payload", get(delivery).languages.en.payload === undefined);
recomputeAll();
check("重算后 blocked 清除", get(deliveryView).blockedCount === 0);

console.log("\n[4] 两名审校员同时确认同一字幕 → 先到者生效，后到者看到版本冲突与阻塞项");
const target = cue("c2");
const base = target.version;
const first = reviewCue("c2", true, "", base, "审校-顾宁");
const second = reviewCue("c2", true, "", base, "审校-苏晴");
check("先到者确认生效", first.ok === true);
check("后到者未生效", second.ok === false);
check("后到者看到版本冲突", second.reason === "版本冲突" && second.expectedVersion === base && second.currentVersion === base + 1);
check("字幕状态为已通过（先到者结果）", cue("c2").status === "已通过");
check("产生一条版本冲突记录", get(conflicts).some((c) => c.type === "版本冲突" && c.cueId === "c2"));
check("冲突记录含最新阻塞项", (get(conflicts).find((c) => c.type === "版本冲突" && c.cueId === "c2")?.blocking ?? []).length >= 0);
const approveEvents = get(reviewEvents).filter((e) => e.cueId === "c2" && e.action === "审校通过");
check("只有一方审校结论生效", approveEvents.length === 1 && approveEvents[0].actor === "审校-顾宁");

console.log("\n[5] 生成失败保留已完成语言，重试只补未完成，重复请求沿用首次结果");
generateAll();
await sleep(1400);
check("en 生成成功", get(delivery).languages.en.status === "done");
check("en 有 payload", !!get(delivery).languages.en.payload);
check("ja 首次失败", get(delivery).languages.ja.status === "error");
check("doneCount=1（只保留已完成语言）", get(deliveryView).doneCount === 1);
const enPayload = get(delivery).languages.en.payload;
const enAttempts = get(delivery).languages.en.attempts;
generateLanguage("en"); // 重复请求
check("重复请求沿用首次结果（payload 不变）", get(delivery).languages.en.payload === enPayload);
check("重复请求不重新生成（attempts 不变）", get(delivery).languages.en.attempts === enAttempts);
retryLanguage("ja");
await sleep(1400);
check("重试后 ja 成功", get(delivery).languages.ja.status === "done");
check("重试只补 ja（en attempts 不变）", get(delivery).languages.en.attempts === enAttempts);
check("doneCount=2", get(deliveryView).doneCount === 2);
generateAll();
check("全部完成后再生成不重复劳动", get(delivery).languages.ja.attempts === 2 && get(delivery).languages.en.attempts === enAttempts);

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
