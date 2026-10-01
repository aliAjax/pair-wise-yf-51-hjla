import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { get } from "svelte/store";
import {
	SOURCE_TRACK_ID,
	confirmCue,
	currentChecks,
	cues,
	deliveryRuns,
	failOnNextAttempt,
	lockTerm,
	recomputeTrack,
	requestDelivery,
	retryDelivery,
	reviewer,
	terms,
	tracks
} from "$lib/stores/subtitles.ts";
import type { TargetCue } from "./engine.ts";

const trackIds = () => get(tracks).map((t) => t.id).filter((id) => id !== SOURCE_TRACK_ID);

function targetList() {
	return get(cues).filter((c): c is TargetCue => c.trackId !== SOURCE_TRACK_ID);
}

describe("store 端到端：失效 → 重算 → 双人审校 → 交付包", () => {
	it("种子数据一开始不可交付（存在未译 / 未审校）", () => {
		const check = currentChecks();
		assert.equal(check.ready, false);
		assert.ok(check.tracks.some((t) => t.unapproved > 0 || t.untranslated > 0), "未译 / 未通过审校的字幕应当阻塞交付");
	});

	it("锁定新术语立即制造术语阻塞，重算后阻塞消失但需重新审校", () => {
		// c3 原本未关联任何原片段，先重算两条轨道让所有字幕同步
		for (const id of trackIds()) recomputeTrack(id);
		const before = currentChecks();
		assert.equal(before.blockers.length, 0, "重算后不应再有失效项");

		const g3 = get(terms).find((t) => t.source === "加固")!;
		lockTerm(g3.id);
		const stale = currentChecks();
		assert.ok(stale.blockers.every((b) => b.kind === "术语锁定变更"));
		assert.ok(stale.blockers.length >= 2, "en / ja 均应失效");

		for (const id of trackIds()) recomputeTrack(id);
		assert.equal(currentChecks().blockers.length, 0);
	});

	it("双人确认同一字幕：第二人冲突，第一人结论生效", () => {
		const cue = targetList().find((c) => c.trackId === "en")!;
		reviewer.set("审校-顾宁");
		const first = confirmCue(cue.id, true, "");
		assert.equal(first.result.ok, true);

		reviewer.set("审校-秦言");
		const second = confirmCue(cue.id, true, "");
		assert.equal(second.result.ok, false);
		if (!second.result.ok) assert.equal(second.result.reason, "版本冲突");

		reviewer.set("审校-秦言");
		const other = targetList().find((c) => c.trackId === "ja");
		if (other) {
			const ja = confirmCue(other.id, true, "");
			assert.equal(ja.result.ok, true);
		}
	});

	it("所有字幕由一方确认通过后才放行", () => {
		// 其余 en 字幕由顾宁确认；ja 已由秦言确认一条，其余用顾宁补齐
		reviewer.set("审校-顾宁");
		for (const cue of targetList()) {
			const check = currentChecks([cue.trackId]);
			const approved = check.tracks[0]?.unapproved === 0;
			if (!approved) {
				const outcome = confirmCue(cue.id, true, "");
				if (!outcome.result.ok && outcome.result.reason !== "版本冲突") {
					assert.fail(`未预期的确认失败：${JSON.stringify(outcome.result)}`);
				}
			}
		}
		assert.equal(currentChecks().ready, true);
	});

	it("重复 requestId 沿用首次结果，不新建任务", async () => {
		const id = "fixed-request-id";
		const first = await requestDelivery(id);
		assert.equal(first.status, "完成");
		const countAfterFirst = get(deliveryRuns).length;
		const again = await requestDelivery(id);
		assert.equal(again, first, "同一 requestId 必须返回同一 run 对象");
		assert.equal(get(deliveryRuns).length, countAfterFirst);
	});

	it("某语言失败时保留已完成语言，重试只补失败语言", async () => {
		failOnNextAttempt.set(["en"]);
		const run = await requestDelivery("partial-failure-run");
		assert.equal(run.status, "部分完成");
		assert.equal(run.languages.en.status, "失败");
		assert.equal(run.languages.ja.status, "完成");
		const jaArtifact = run.languages.ja.artifact;
		assert.ok(jaArtifact);

		const retried = await retryDelivery("partial-failure-run");
		assert.equal(retried.status, "完成");
		assert.equal(retried.languages.en.status, "完成");
		assert.equal(retried.languages.ja.artifact, jaArtifact, "ja 结果必须原样保留");
		assert.equal(retried.languages.ja.attempts, 1, "ja 不应被重新尝试");
		assert.equal(retried.languages.en.attempts, 2);
	});

	it("术语再次变化后，已完成的 run 保持不变，新请求被阻塞且不生成", async () => {
		const oldRun = get(deliveryRuns)[0];
		const g = get(terms).find((t) => t.source === "潮汐");
		// 直接改锁定译文，模拟术语调整
		terms.update((items) => items.map((t) => (t.id === g!.id ? { ...t, target: "tide (n.)" } : t)));
		assert.equal(currentChecks().ready, false);

		const blocked = await requestDelivery("blocked-after-term-change");
		assert.equal(blocked.status, "已阻塞");
		assert.equal(Object.values(blocked.languages).every((l) => l.status === "等待"), true);
		assert.ok(blocked.blockers.length > 0, "阻塞项快照必须随 run 保留");

		const untouched = get(deliveryRuns).find((r) => r.requestId === oldRun.requestId);
		assert.equal(untouched, oldRun, "历史交付结果不受后续数据变化影响");
	});

	after(() => {
		// 让挂起的定时器尽快释放
		setTimeout(() => undefined, 10);
	});
});
