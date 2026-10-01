import { browser } from "$app/environment";
import { derived, get, writable } from "svelte/store";
import {
	artifactChecksum,
	buildContext,
	confirmVerdict,
	createRun,
	cueStaleness,
	evaluateTracks,
	isVerdictActive,
	overallStatus,
	recomputeFields,
	requeueFailed,
	type Blocker,
	type Cue as EngineCue,
	type ConfirmResult,
	type DeliveryContext,
	type DeliveryRun,
	type GlossaryTerm,
	type LanguageDelivery,
	type ReviewVerdict,
	type TargetCue,
	type TrackCheck
} from "$lib/delivery/engine";

export type TrackStatus = "草稿" | "审校中" | "已通过" | "需修改";
export type CueStatus = "待译" | "翻译中" | "待审" | "已通过" | "退回" | "已失效";
export type TermStatus = "建议" | "已锁定";

export interface Track {
	id: string;
	name: string;
	locale: "zh" | "en" | "ja";
	status: TrackStatus;
}

export type Cue = EngineCue;

export type { DeliveryRun };

export type { GlossaryTerm, ReviewVerdict };

export interface ReviewEvent {
	id: string;
	cueId: string;
	action: "提交审校" | "审校通过" | "退回修改" | "术语锁定" | "重算字幕";
	detail: string;
	actor: string;
	time: string;
}

export interface Snapshot {
	id: string;
	name: string;
	time: string;
	cues: Cue[];
}

export interface TimelineConflict {
	id: string;
	cueId: string;
	message: string;
	remoteStart: number;
	remoteEnd: number;
	status: "待处理" | "采用本地" | "采用协作版本";
}

export const SOURCE_TRACK_ID = "zh";

const KEY = "pair-wise-yf-51/subtitles-v2";

function termsFingerprintOf(terms: GlossaryTerm[]) {
	const locked = terms.filter((term) => term.status === "已锁定").map((term) => `${term.source}=>${term.target}`).sort().join("|");
	return locked;
}

const seedTracks: Track[] = [
	{ id: "zh", name: "中文原字幕", locale: "zh", status: "已通过" },
	{ id: "en", name: "English 翻译", locale: "en", status: "审校中" },
	{ id: "ja", name: "日本語訳", locale: "ja", status: "草稿" }
];

function seedCues(): Cue[] {
	const terms = seedTerms();
	const fp = termsFingerprintOf(terms);
	return [
		{ id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", rev: 1 },
		{ id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide recedes, the pier emerges again.", status: "待审", translator: "林岚", reviewerNote: "", rev: 1, sourceIds: ["c1"], sourceSnapshot: `c1@0-2.8:潮汐退去后，码头重新露出水面。`, termSnapshot: fp },
		{ id: "c3", trackId: "en", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "The repair team must reinforce it before the next tide.", status: "翻译中", translator: "林岚", reviewerNote: "", rev: 1, sourceIds: [], sourceSnapshot: "", termSnapshot: fp },
		{ id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮が引くと、桟橋が再び姿を現す。", status: "待译", translator: "周野", reviewerNote: "", rev: 1, sourceIds: ["c1"], sourceSnapshot: `c1@0-2.8:潮汐退去后，码头重新露出水面。`, termSnapshot: fp }
	];
}

function seedTerms(): GlossaryTerm[] {
	return [
		{ id: "g1", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员" },
		{ id: "g2", source: "码头", target: "pier", status: "已锁定", owner: "术语管理员" },
		{ id: "g3", source: "加固", target: "reinforce", status: "建议", owner: "林岚" }
	];
}

const saved = browser && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;

export const tracks = writable<Track[]>(saved?.tracks ?? seedTracks);
export const cues = writable<Cue[]>(saved?.cues ?? seedCues());
export const terms = writable<GlossaryTerm[]>(saved?.terms ?? seedTerms());
export const reviewEvents = writable<ReviewEvent[]>(saved?.events ?? []);
export const snapshots = writable<Snapshot[]>(saved?.snapshots ?? []);
export const verdicts = writable<ReviewVerdict[]>(saved?.verdicts ?? []);
export const deliveryRuns = writable<DeliveryRun[]>([]);
/** 下一次语言生成尝试时注入失败的语言（演示“部分失败 → 重试补齐”） */
export const failOnNextAttempt = writable<string[]>([]);
export const conflicts = writable<TimelineConflict[]>([{ id: "x1", cueId: "c2", message: "协作者将结束时间调整为3.0秒，与本机存在0.2秒差异。", remoteStart: 0, remoteEnd: 3, status: "待处理" }]);
export const activeTrackId = writable("en");
export const selectedCueId = writable("c2");
export const reviewer = writable("审校-顾宁");
export const reviewers = ["审校-顾宁", "审校-秦言"];

/** 崩溃恢复：上次会话中未完成的语言标记为失败，可直接重试补齐。 */
if (saved?.runs) {
	const recovered: DeliveryRun[] = saved.runs.map((run: DeliveryRun) => {
		if (run.status === "已阻塞") return run;
		let touched = false;
		const languages: Record<string, LanguageDelivery> = {};
		for (const [trackId, language] of Object.entries(run.languages)) {
			if (language.status === "进行中" || language.status === "等待") {
				languages[trackId] = { ...language, status: "失败", attempts: language.attempts + 1, error: "生成进程中断，已保留已完成语言" };
				touched = true;
			} else {
				languages[trackId] = language;
			}
		}
		return touched ? { ...run, status: "部分完成", languages } : run;
	});
	deliveryRuns.set(recovered);
}

function persist() {
	if (!browser) return;
	localStorage.setItem(
		KEY,
		JSON.stringify({
			tracks: get(tracks),
			cues: get(cues),
			terms: get(terms),
			events: get(reviewEvents),
			snapshots: get(snapshots),
			verdicts: get(verdicts),
			runs: get(deliveryRuns)
		})
	);
}
[tracks, cues, terms, reviewEvents, snapshots, verdicts, deliveryRuns].forEach((store) => store.subscribe(persist));

function logEvent(cue: Cue | undefined, action: ReviewEvent["action"], detail: string, actor = get(reviewer)) {
	reviewEvents.update((items) => [{ id: crypto.randomUUID(), cueId: cue?.id ?? "", action, detail, actor, time: new Date().toISOString() }, ...items]);
}

export function deliveryContext(): DeliveryContext {
	return buildContext(get(cues), get(terms), SOURCE_TRACK_ID);
}

function asTarget(cue: Cue | undefined): TargetCue | undefined {
	return cue && cue.trackId !== SOURCE_TRACK_ID ? (cue as TargetCue) : undefined;
}

/* ------------------------------- 字幕编辑 -------------------------------- */

/**
 * 原片段编辑（原文 / 时间码）会提升原片段版本，关联语言立即失效；
 * 译文编辑只提升目标字幕自身版本，旧审校结论随之过期。
 */
export function updateCue(id: string, patch: Partial<TargetCue>, log = false) {
	const cue = get(cues).find((item) => item.id === id);
	if (!cue) return;
	if (cue.trackId === SOURCE_TRACK_ID) {
		const structural =
			("source" in patch && patch.source !== cue.source) ||
			("start" in patch && patch.start !== cue.start) ||
			("end" in patch && patch.end !== cue.end);
		cues.update((items) => items.map((item) => (item.id === id ? { ...item, ...patch, rev: structural ? item.rev + 1 : item.rev } : item)));
	} else {
		const target = cue as TargetCue;
		const contentChange = ("translated" in patch && patch.translated !== target.translated);
		cues.update((items) =>
			items.map((item) =>
				item.id === id
					? ({
							...item,
							...patch,
							status: contentChange && (item as TargetCue).status === "退回" ? "翻译中" : (item as TargetCue).status,
							rev: contentChange ? (item as TargetCue).rev + 1 : (item as TargetCue).rev
						} as Cue)
					: item
			)
		);
	}
	if (log) logEvent(cue, "退回修改", "编辑字幕内容或时间码");
}

export function nudgeCue(id: string, delta: number) {
	const cue = get(cues).find((item) => item.id === id);
	if (!cue) return;
	const start = Math.max(0, Number((cue.start + delta).toFixed(1)));
	const end = Math.max(start + 0.5, Number((cue.end + delta).toFixed(1)));
	updateCue(id, { start, end } as Partial<TargetCue>);
	if (cue.trackId === SOURCE_TRACK_ID) logEvent(cue, "重算字幕", `原片段时间码整体移动 ${delta > 0 ? "+" : ""}${delta}s，相关语言已标记失效`);
}

/** 拆分：原片段拆分会让覆盖其时间范围的译文出现「原片段拆分」阻塞。 */
export function splitCue(id: string) {
	const list = get(cues);
	const cue = list.find((item) => item.id === id);
	if (!cue || cue.end - cue.start < 1) return;
	const middle = Number(((cue.start + cue.end) / 2).toFixed(1));

	if (cue.trackId === SOURCE_TRACK_ID) {
		const first = { ...cue, end: middle, rev: cue.rev + 1 };
		const second = { ...cue, id: crypto.randomUUID(), start: middle, rev: cue.rev + 1 };
		cues.set(list.flatMap((item) => (item.id === id ? [first, second] : [item])));
		logEvent(cue, "重算字幕", "原片段已拆分，关联语言的交付检查立即失效");
		selectedCueId.set(second.id);
		return;
	}

	const target = cue as TargetCue;
	const context = deliveryContext();
	// 目标字幕拆分：两条各自重新关联原片段，快照不同但都保持同步
	const first: TargetCue = { ...target, end: middle, ...recomputeFields({ ...target, end: middle }, context) };
	const secondDraft: TargetCue = { ...target, id: crypto.randomUUID(), start: middle, translated: "" };
	const second: TargetCue = {
		...secondDraft,
		...recomputeFields(secondDraft, context),
		translated: "",
		status: "待译"
	};
	cues.set(list.flatMap((item) => (item.id === id ? [first, second] : [item])));
	selectedCueId.set(second.id);
}

/** 合并：原片段合并会让译文出现「原片段合并」阻塞，重算后恢复。 */
export function mergeNext(id: string) {
	const list = [...get(cues)].sort((a, b) => a.start - b.start).filter((item) => item.trackId === get(activeTrackId));
	const index = list.findIndex((item) => item.id === id);
	const current = list[index];
	const next = list[index + 1];
	if (!current || !next) return;

	if (current.trackId === SOURCE_TRACK_ID) {
		const merged = { ...current, end: next.end, source: `${current.source}${next.source}`, rev: current.rev + 1 };
		cues.update((items) => items.filter((item) => item.id !== next.id).map((item) => (item.id === id ? merged : item)));
		logEvent(merged, "重算字幕", "原片段已合并，关联语言的交付检查立即失效");
		return;
	}

	const context = deliveryContext();
	const merged: TargetCue = {
		...(current as TargetCue),
		end: next.end,
		translated: `${(current as TargetCue).translated} ${(next as TargetCue).translated}`.trim(),
		...recomputeFields({ ...(current as TargetCue), end: next.end }, context),
		status: "翻译中"
	};
	cues.update((items) => items.filter((item) => item.id !== next.id).map((item) => (item.id === id ? merged : item)));
}

export function setCueStatus(id: string, status: TargetCue["status"]) {
	updateCue(id, { status });
	const cue = get(cues).find((item) => item.id === id);
	logEvent(cue, status === "待审" ? "提交审校" : "退回修改", (cue as TargetCue)?.translated ?? "");
}

/** 重算单条字幕：刷新原片段关联与术语指纹，产生新版本，旧审校结论过期。 */
export function recomputeCue(id: string) {
	const cue = asTarget(get(cues).find((item) => item.id === id));
	if (!cue) return;
	if (!cueStaleness(cue, deliveryContext())) return;
	cues.update((items) => items.map((item) => (item.id === id ? ({ ...item, ...recomputeFields(item as TargetCue, deliveryContext()) } as Cue) : item)));
	logEvent(cue, "重算字幕", "已按最新原片段与锁定术语重算，待重新审校");
}

export function recomputeTrack(trackId = get(activeTrackId)) {
	const context = deliveryContext();
	let count = 0;
	cues.update((items) =>
		items.map((item) => {
			if (item.trackId !== trackId) return item;
			const target = item as TargetCue;
			if (!cueStaleness(target, context)) return item;
			count += 1;
			return { ...item, ...recomputeFields(target, context) } as Cue;
		})
	);
	if (count > 0) logEvent(undefined, "重算字幕", `${trackId} 轨批量重算 ${count} 条失效字幕，需重新审校`);
}

/* -------------------------------- 审校 ----------------------------------- */

export interface ConfirmOutcome {
	result: ConfirmResult;
	verdict?: ReviewVerdict;
}

/**
 * 两名审校员确认同一字幕：先到者绑定 rev 生效，后到者收到版本冲突 / 阻塞项；
 * 同一审校员重复确认幂等。
 */
export function confirmCue(id: string, approved: boolean, note = ""): ConfirmOutcome {
	const result = confirmVerdict(get(cues), get(verdicts), deliveryContext(), {
		cueId: id,
		reviewer: get(reviewer),
		approved,
		note,
		now: new Date().toISOString(),
		id: crypto.randomUUID()
	});
	if (result.ok) {
		if (!result.duplicated) {
			verdicts.update((items) => [result.verdict, ...items]);
			const cue = get(cues).find((item) => item.id === id);
			updateCue(id, { status: approved ? "已通过" : "退回", reviewerNote: note || (result.verdict.approved ? "审校通过" : "") });
			logEvent(cue, approved ? "审校通过" : "退回修改", note || (cue as TargetCue)?.translated || "", result.verdict.reviewer);
		}
		return { result, verdict: result.verdict };
	}
	return { result };
}

export function activeVerdictsFor(cueId: string) {
	const cue = asTarget(get(cues).find((item) => item.id === cueId));
	const context = deliveryContext();
	return get(verdicts)
		.filter((verdict) => verdict.cueId === cueId)
		.map((verdict) => ({ verdict, active: cue ? isVerdictActive(verdict, cue, context) : false }));
}

/* -------------------------------- 术语 ----------------------------------- */

export function lockTerm(id: string) {
	terms.update((items) => items.map((term) => (term.id === id ? { ...term, status: "已锁定", owner: "术语管理员" } : term)));
	const term = get(terms).find((item) => item.id === id);
	const cue = get(cues).find((item) => item.id === get(selectedCueId));
	logEvent(cue, "术语锁定", `${term?.source} → ${term?.target}，全部语言的交付检查立即失效`);
}

/* -------------------------------- 快照 ----------------------------------- */

export function createSnapshot(name = `时间轴快照 ${get(snapshots).length + 1}`) {
	snapshots.update((items) => [{ id: crypto.randomUUID(), name, time: new Date().toISOString(), cues: structuredClone(get(cues)) }, ...items].slice(0, 12));
}

export function restoreSnapshot(id: string) {
	const snapshot = get(snapshots).find((item) => item.id === id);
	if (snapshot) cues.set(structuredClone(snapshot.cues));
}

export function resolveConflict(id: string, resolution: TimelineConflict["status"]) {
	conflicts.update((items) => items.map((item) => (item.id === id ? { ...item, status: resolution } : item)));
	if (resolution === "采用协作版本") {
		const conflict = get(conflicts).find((item) => item.id === id);
		if (conflict) updateCue(conflict.cueId, { start: conflict.remoteStart, end: conflict.remoteEnd } as Partial<TargetCue>);
	}
}

/* ------------------------------ 交付门与交付包 ----------------------------- */

export function currentChecks(trackIds?: string[]): { tracks: TrackCheck[]; blockers: Blocker[]; ready: boolean } {
	return evaluateTracks(get(cues), get(verdicts), deliveryContext(), trackIds);
}

function targetTrackIds() {
	return get(tracks).filter((track) => track.id !== SOURCE_TRACK_ID).map((track) => track.id);
}

/**
 * 请求生成交付包：
 * - 未重算（有阻塞项）时只建“已阻塞”记录，不生成任何包；
 * - 相同 requestId 的重复请求原样返回首次结果；
 * - 语言级失败互不影响，重试只补失败语言。
 */
export async function requestDelivery(requestId: string = crypto.randomUUID() as string): Promise<DeliveryRun> {
	const existing = get(deliveryRuns).find((run) => run.requestId === requestId);
	if (existing) return existing;

	const evaluation = currentChecks();
	const run = createRun({ requestId, now: new Date().toISOString(), trackIds: targetTrackIds(), evaluation });
	deliveryRuns.update((items) => [run, ...items]);

	if (run.status !== "已阻塞") {
		await driveRun(requestId, targetTrackIds());
	}
	return get(deliveryRuns).find((item) => item.requestId === requestId)!;
}

export function retryDelivery(requestId: string) {
	const run = get(deliveryRuns).find((item) => item.requestId === requestId);
	if (!run || run.status === "已阻塞") return Promise.resolve(run);
	const pending = requeueFailed(run);
	// requeueFailed 原地修改，需触发 store 更新
	deliveryRuns.update((items) => items.map((item) => (item.requestId === requestId ? { ...run } : item)));
	return driveRun(requestId, pending);
}

async function driveRun(requestId: string, trackIds: string[]): Promise<DeliveryRun | undefined> {
	for (const trackId of trackIds) {
		patchLanguage(requestId, trackId, (language) => ({ ...language, status: "进行中" }));
		// 模拟逐语言导出耗时
		await new Promise((resolve) => setTimeout(resolve, 450));

		const willFail = get(failOnNextAttempt).includes(trackId);
		failOnNextAttempt.update((items) => items.filter((id) => id !== trackId));
		if (willFail) {
			patchLanguage(requestId, trackId, (language) => ({ ...language, status: "失败", attempts: language.attempts + 1, error: "导出服务暂时不可用（模拟故障）" }));
			continue;
		}

		const context = deliveryContext();
		const runCues = get(cues).filter((cue): cue is TargetCue => cue.trackId === trackId);
		const now = new Date().toISOString();
		const checksum = runCues.map((cue) => artifactChecksum(cue, context, requestId, now)).join("|");
		patchLanguage(requestId, trackId, (language) => ({
			...language,
			status: "完成",
			attempts: language.attempts + 1,
			error: undefined,
			artifact: { requestId, trackId, cueCount: runCues.length, checksum: checksum.slice(0, 24), generatedAt: now }
		}));
	}

	let finished: DeliveryRun | undefined;
	deliveryRuns.update((items) =>
		items.map((item) => {
			if (item.requestId !== requestId || item.status === "已阻塞") return item;
			const next = { ...item, status: overallStatus(item) };
			if (next.status === "完成") finished = next;
			return next;
		})
	);
	return finished ?? get(deliveryRuns).find((item) => item.requestId === requestId);
}

function patchLanguage(requestId: string, trackId: string, patch: (language: LanguageDelivery) => LanguageDelivery) {
	deliveryRuns.update((items) =>
		items.map((item) =>
			item.requestId === requestId
				? { ...item, languages: { ...item.languages, [trackId]: patch(item.languages[trackId]) } }
				: item
		)
	);
}

/* ------------------------------ 视图用派生状态 ----------------------------- */

/** 新增字幕：原片段走结构 rev，目标字幕立即按当前原片段 / 术语建立指纹。 */
export function createCue(input: { trackId: string; start: number; end: number; source: string; translated: string }): Cue {
	const id = crypto.randomUUID();
	if (input.trackId === SOURCE_TRACK_ID) {
		return { id, trackId: input.trackId, start: input.start, end: input.end, source: input.source, rev: 1 };
	}
	const context = deliveryContext();
	const draft: TargetCue = {
		id,
		trackId: input.trackId,
		start: input.start,
		end: input.end,
		source: input.source,
		translated: input.translated,
		status: "翻译中",
		translator: "当前译者",
		reviewerNote: "",
		rev: 1,
		sourceIds: [],
		sourceSnapshot: "",
		termSnapshot: context.termsFingerprint
	};
	return { ...draft, ...recomputeFields(draft, context) };
}

export function cueDisplayStatus(cue: Cue): CueStatus {
	if (cue.trackId === SOURCE_TRACK_ID) return "已通过";
	const target = cue as TargetCue;
	return cueStaleness(target, deliveryContext()) ? "已失效" : target.status;
}

export const activeCues = derived([cues, activeTrackId, selectedCueId], ([$cues, $activeTrackId, $selectedCueId]) =>
	$cues
		.filter((cue) => cue.trackId === $activeTrackId)
		.sort((a, b) => a.start - b.start)
		.map((cue) => ({ ...cue, selected: cue.id === $selectedCueId }))
);

export const blockerByCue = derived([cues, terms], (): Map<string, Blocker> => {
	const context = deliveryContext();
	const map = new Map<string, Blocker>();
	for (const cue of get(cues)) {
		if (cue.trackId === SOURCE_TRACK_ID) continue;
		const blocker = cueStaleness(cue as TargetCue, context);
		if (blocker) map.set(cue.id, blocker);
	}
	return map;
});

/** 当前选中字幕的审校结论及其是否仍对当前版本有效。 */
export const selectedVerdictRows = derived([verdicts, cues, terms, selectedCueId], ([$verdicts, $cues, $terms, $selectedCueId]) => {
	const context = buildContext($cues, $terms, SOURCE_TRACK_ID);
	return $verdicts
		.filter((verdict) => verdict.cueId === $selectedCueId)
		.map((verdict) => {
			const cue = $cues.find((item) => item.id === $selectedCueId);
			const active = cue && cue.trackId !== SOURCE_TRACK_ID ? isVerdictActive(verdict, cue as TargetCue, context) : false;
			return { verdict, active };
		});
});

export const deliveryChecks = derived([cues, terms, verdicts], () => currentChecks());
