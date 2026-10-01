import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	artifactChecksum,
	buildContext,
	confirmVerdict,
	createRun,
	cueStaleness,
	evaluateTracks,
	lockedTermsFingerprint,
	overallStatus,
	recomputeFields,
	requeueFailed,
	type Cue,
	type GlossaryTerm,
	type ReviewVerdict,
	type SourceCue,
	type TargetCue
} from "./engine.ts";

const SOURCE_TRACK = "zh";

function source(id: string, start: number, end: number, text: string, rev = 1): SourceCue {
	return { id, trackId: SOURCE_TRACK, start, end, source: text, rev };
}

function target(id: string, trackId: string, sources: SourceCue[], terms: GlossaryTerm[], patch: Partial<TargetCue> = {}): TargetCue {
	const start = sources[0]?.start ?? 0;
	const end = sources[sources.length - 1]?.end ?? 2.8;
	return {
		id,
		trackId,
		start,
		end,
		source: sources.map((s) => s.source).join(" "),
		translated: `译文-${id}`,
		status: "待审",
		translator: "译者",
		reviewerNote: "",
		rev: 1,
		sourceIds: sources.map((s) => s.id),
		sourceSnapshot: sources.map((s) => `${s.id}@${s.start}-${s.end}:${s.source}`).join(";;"),
		termSnapshot: lockedTermsFingerprint(terms),
		...patch
	};
}

function ctx(cues: Cue[], terms: GlossaryTerm[]) {
	return buildContext(cues, terms, SOURCE_TRACK);
}

const baseTerms: GlossaryTerm[] = [
	{ id: "g1", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员" },
	{ id: "g2", source: "加固", target: "reinforce", status: "建议", owner: "林岚" }
];

function seedState() {
	const s1 = source("s1", 0, 2.8, "潮汐退去后，码头重新露出水面。");
	const en = target("en1", "en", [s1], baseTerms);
	const ja = target("ja1", "ja", [s1], baseTerms);
	const cues: Cue[] = [s1, en, ja];
	const terms = structuredClone(baseTerms);
	return { s1, en, ja, cues, terms };
}

function approve(cues: Cue[], verdicts: ReviewVerdict[], terms: GlossaryTerm[], cueId: string, reviewer: string) {
	const result = confirmVerdict(cues, verdicts, ctx(cues, terms), {
		cueId,
		reviewer,
		approved: true,
		now: "2026-10-01T00:00:00.000Z",
		id: `v-${reviewer}-${cueId}-${verdicts.length}`
	});
	assert.ok(result.ok, "首次确认应当生效");
	if (result.ok) verdicts.push(result.verdict);
	return result;
}

describe("原片段变化 → 字幕立即失效，重算后恢复", () => {
	it("原片段拆分产生新片段，覆盖范围的译文出现「原片段拆分」阻塞", () => {
		const { cues, terms, en } = seedState();
		const context = ctx(cues, terms);
		assert.equal(cueStaleness(en, context), null);

		// 将 s1 拆分为 s1(0-1.4) + s1b(1.4-2.8)
		cues.splice(0, 1, { ...cues[0], end: 1.4, rev: 2 } as SourceCue, source("s1b", 1.4, 2.8, "码头重新露出水面。"));
		const after = ctx(cues, terms);
		const staleEn = cues.find((c) => c.id === "en1") as TargetCue;
		const blocker = cueStaleness(staleEn, after);
		assert.ok(blocker);
		assert.equal(blocker!.kind, "原片段拆分");

		const patched = { ...staleEn, ...recomputeFields(staleEn, after) };
		assert.deepEqual(patched.sourceIds.sort(), ["s1", "s1b"]);
		assert.equal(cueStaleness(patched, after), null);
		assert.notEqual(patched.rev, staleEn.rev, "重算产生新版本，旧审校结论过期");
		assert.equal(patched.status, "待审");
	});

	it("原片段时间码移动 → 时间码变更", () => {
		const { cues, terms, en } = seedState();
		cues[0] = { ...(cues[0] as SourceCue), start: 0.2, end: 3.0, rev: 2 };
		const blocker = cueStaleness(en, ctx(cues, terms));
		assert.equal(blocker?.kind, "时间码变更");
	});

	it("原文字幕文本修改 → 原文变更", () => {
		const { cues, terms, en } = seedState();
		cues[0] = { ...(cues[0] as SourceCue), source: "潮汐退去之后，旧码头重新露出水面。", rev: 2 };
		const blocker = cueStaleness(en, ctx(cues, terms));
		assert.equal(blocker?.kind, "原文变更");
	});

	it("原片段合并（关联片段消失）→ 原片段合并", () => {
		const a = source("a", 0, 1.4, "上半句。");
		const b = source("b", 1.4, 2.8, "下半句。");
		const en = target("en2", "en", [a, b], baseTerms);
		const cues: Cue[] = [a, b, en];
		// 把 a、b 合并成一条 m
		const merged = cues.filter((c) => c.id === "en2");
		merged.unshift(source("m", 0, 2.8, "上半句。下半句。"));
		const blocker = cueStaleness(en, ctx(merged, baseTerms));
		assert.equal(blocker?.kind, "原片段合并");
		const patched = { ...en, ...recomputeFields(en, ctx(merged, baseTerms)) };
		assert.deepEqual(patched.sourceIds, ["m"]);
		assert.equal(cueStaleness(patched, ctx(merged, baseTerms)), null);
	});
});

describe("术语锁定变化", () => {
	it("新锁定一个术语 → 所有目标字幕失效", () => {
		const { cues, terms, en, ja } = seedState();
		terms[1] = { ...terms[1], status: "已锁定" };
		const context = ctx(cues, terms);
		assert.equal(cueStaleness(en, context)?.kind, "术语锁定变更");
		assert.equal(cueStaleness(ja, context)?.kind, "术语锁定变更");
		const patched = { ...en, ...recomputeFields(en, context) };
		assert.equal(cueStaleness(patched, context), null);
	});
});

describe("两名审校员同时确认同一字幕", () => {
	it("只有一方生效，后到者收到版本冲突和该语言最新阻塞项", () => {
		const state = seedState();
		const verdicts: ReviewVerdict[] = [];
		const first = confirmVerdict(state.cues, verdicts, ctx(state.cues, state.terms), {
			cueId: "en1", reviewer: "审校-顾宁", approved: true, now: "2026-10-01T00:00:00Z", id: "v1"
		});
		assert.equal(first.ok, true);
		if (first.ok) verdicts.push(first.verdict);

		// 原片段时间码在两人确认之间发生变化（模拟先到者确认后数据已变）
		state.cues[0] = { ...(state.cues[0] as SourceCue), start: 0.2, end: 3.0, rev: 2 };
		const second = confirmVerdict(state.cues, verdicts, ctx(state.cues, state.terms), {
			cueId: "en1", reviewer: "审校-秦言", approved: true, now: "2026-10-01T00:00:01Z", id: "v2"
		});
		assert.equal(second.ok, false);
		if (!second.ok) {
			assert.equal(second.reason, "存在阻塞项");
			assert.ok(second.blockers.some((b) => b.kind === "时间码变更"), "后到者必须看到最新阻塞项");
		}
	});

	it("同版本无数据变化时，第二方拿到版本冲突并看到先到结论", () => {
		const state = seedState();
		const verdicts: ReviewVerdict[] = [];
		approve(state.cues, verdicts, state.terms, "en1", "审校-顾宁");
		const second = confirmVerdict(state.cues, verdicts, ctx(state.cues, state.terms), {
			cueId: "en1", reviewer: "审校-秦言", approved: true, now: "2026-10-01T00:00:01Z", id: "v2"
		});
		assert.equal(second.ok, false);
		if (!second.ok) {
			assert.equal(second.reason, "版本冲突");
			assert.equal(second.existingVerdict?.reviewer, "审校-顾宁");
			assert.equal(verdicts.length, 1, "后到结论不得写入");
		}
	});

	it("同一审校员重复确认幂等，沿用首次结论", () => {
		const state = seedState();
		const verdicts: ReviewVerdict[] = [];
		approve(state.cues, verdicts, state.terms, "en1", "审校-顾宁");
		const again = confirmVerdict(state.cues, verdicts, ctx(state.cues, state.terms), {
			cueId: "en1", reviewer: "审校-顾宁", approved: true, now: "2026-10-01T00:05:00Z", id: "v3"
		});
		assert.equal(again.ok, true);
		if (again.ok) {
			assert.equal(again.duplicated, true);
			assert.equal(again.verdict.id, "v-审校-顾宁-en1-0");
		}
		assert.equal(verdicts.length, 1);
	});

	it("字幕重算 rev 增加后旧结论过期，必须重新审校", () => {
		const state = seedState();
		const verdicts: ReviewVerdict[] = [];
		approve(state.cues, verdicts, state.terms, "en1", "审校-顾宁");

		state.terms[1] = { ...state.terms[1], status: "已锁定" };
		const context = ctx(state.cues, state.terms);
		const index = state.cues.findIndex((c) => c.id === "en1");
		const stale = state.cues[index] as TargetCue;
		state.cues[index] = { ...stale, ...recomputeFields(stale, context) };
		const fresh = state.cues[index] as TargetCue;
		assert.equal(verdicts.every((v) => v.cueRev !== fresh.rev), true);
		const evaluation = evaluateTracks(state.cues, verdicts, ctx(state.cues, state.terms));
		assert.equal(evaluation.ready, false);
		assert.equal(evaluation.tracks.find((t) => t.trackId === "en")?.unapproved, 1);
	});
});

describe("交付门与交付包", () => {
	it("存在失效字幕时禁止生成交付包", () => {
		const state = seedState();
		const verdicts: ReviewVerdict[] = [];
		approve(state.cues, verdicts, state.terms, "en1", "审校-顾宁");
		approve(state.cues, verdicts, state.terms, "ja1", "审校-顾宁");

		state.cues[0] = { ...(state.cues[0] as SourceCue), end: 3.1, rev: 2 };
		const evaluation = evaluateTracks(state.cues, verdicts, ctx(state.cues, state.terms));
		assert.equal(evaluation.ready, false);
		const run = createRun({ requestId: "req-1", now: "t0", trackIds: ["en", "ja"], evaluation });
		assert.equal(run.status, "已阻塞");
		assert.ok(run.blockers.length >= 2, "两个语言都应被阻塞");
		assert.deepEqual(Object.values(run.languages).map((l) => l.status), ["等待", "等待"]);
	});

	it("全部语言就绪后生成；某语言失败不影响已完成语言，重试只补失败语言", () => {
		const state = seedState();
		const verdicts: ReviewVerdict[] = [];
		approve(state.cues, verdicts, state.terms, "en1", "审校-顾宁");
		approve(state.cues, verdicts, state.terms, "ja1", "审校-顾宁");
		const context = ctx(state.cues, state.terms);
		const evaluation = evaluateTracks(state.cues, verdicts, context);
		assert.equal(evaluation.ready, true);

		const run = createRun({ requestId: "req-2", now: "t0", trackIds: ["en", "ja"], evaluation });
		assert.equal(run.status, "进行中");

		// en 成功
		const enCue = state.cues.find((c) => c.id === "en1") as TargetCue;
		run.languages.en.status = "进行中";
		run.languages.en.attempts += 1;
		run.languages.en.status = "完成";
		run.languages.en.artifact = {
			requestId: "req-2",
			trackId: "en",
			cueCount: 1,
			checksum: artifactChecksum(enCue, context, "req-2", "t1"),
			generatedAt: "t1"
		};

		// ja 失败
		run.languages.ja.status = "进行中";
		run.languages.ja.attempts += 1;
		run.languages.ja.status = "失败";
		run.languages.ja.error = "导出服务超时";
		assert.equal(overallStatus(run), "部分完成");

		const enArtifactBefore = run.languages.en.artifact;
		const retryIds = requeueFailed(run);
		assert.deepEqual(retryIds, ["ja"], "重试只能补 ja");
		assert.equal(run.languages.en.artifact, enArtifactBefore, "已完成语言结果必须保留");
		assert.equal(run.languages.en.attempts, 1);

		// ja 重试成功
		const jaCue = state.cues.find((c) => c.id === "ja1") as TargetCue;
		run.languages.ja.status = "进行中";
		run.languages.ja.attempts += 1;
		run.languages.ja.status = "完成";
		run.languages.ja.artifact = {
			requestId: "req-2",
			trackId: "ja",
			cueCount: 1,
			checksum: artifactChecksum(jaCue, context, "req-2", "t2"),
			generatedAt: "t2"
		};
		assert.equal(overallStatus(run), "完成");
		assert.equal(run.languages.ja.attempts, 2);
	});

	it("重复 requestId 沿用首次结果（在仓库层保证，此处验证 createRun 不重建状态）", () => {
		const state = seedState();
		const verdicts: ReviewVerdict[] = [];
		approve(state.cues, verdicts, state.terms, "en1", "审校-顾宁");
		approve(state.cues, verdicts, state.terms, "ja1", "审校-顾宁");
		const evaluation = evaluateTracks(state.cues, verdicts, ctx(state.cues, state.terms));
		const first = createRun({ requestId: "req-3", now: "t0", trackIds: ["en", "ja"], evaluation });
		const second = createRun({ requestId: "req-3", now: "t9", trackIds: ["en", "ja"], evaluation });
		assert.notEqual(second, first, "createRun 是纯函数；去重由 requestDelivery 仓库负责");
		assert.equal(second.requestId, first.requestId);
	});
});
