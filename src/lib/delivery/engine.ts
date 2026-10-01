/**
 * 可重算的交付检查引擎（纯逻辑，不依赖 Svelte / DOM）。
 *
 * 设计要点：
 * - 每条目标字幕记录来源片段指纹（sourceSnapshot）与锁定术语指纹（termSnapshot），
 *   原片段拆分 / 合并 / 时间码 / 原文变化、术语锁定变化后，指纹对不上即判定失效，
 *   未重算前交付门一直阻塞。
 * - 审校结论绑定字幕版本号 cueRev；版本变化后旧结论立即标记为已过期。
 * - 同一版本只允许一方审校结论生效，后到确认者收到版本冲突 + 最新阻塞项。
 * - 交付按语言独立生成：失败保留已完成语言，重试只补未完成语言；
 *   相同 requestId 的重复请求永远沿用首次结果。
 */

export type Locale = "zh" | "en" | "ja";
export type TargetCueStatus = "待译" | "翻译中" | "待审" | "已通过" | "退回";
export type DisplayCueStatus = TargetCueStatus | "已失效";

export interface SourceCue {
	id: string;
	trackId: string;
	start: number;
	end: number;
	/** 原文文本 */
	source: string;
	/** 结构版本：拆分 / 合并 / 编辑 / 移动时间码都会 +1 */
	rev: number;
}

export interface TargetCue {
	id: string;
	trackId: string;
	start: number;
	end: number;
	source: string;
	translated: string;
	status: TargetCueStatus;
	translator: string;
	reviewerNote: string;
	/** 目标字幕自身版本：译文变化或重算后 +1，旧审校结论随之过期 */
	rev: number;
	/** 关联的原片段 id */
	sourceIds: string[];
	/** 上次重算 / 审校时的原片段指纹 */
	sourceSnapshot: string;
	/** 上次重算 / 审校时的锁定术语指纹 */
	termSnapshot: string;
}

export type Cue = SourceCue | TargetCue;

export interface GlossaryTerm {
	id: string;
	source: string;
	target: string;
	status: "建议" | "已锁定";
	owner: string;
}

export type BlockerKind =
	| "原片段拆分"
	| "原片段合并"
	| "时间码变更"
	| "原文变更"
	| "术语锁定变更";

export interface Blocker {
	cueId: string;
	trackId: string;
	kind: BlockerKind;
	message: string;
}

export interface ReviewVerdict {
	id: string;
	cueId: string;
	/** 结论所确认的字幕版本，版本不一致即过期 */
	cueRev: number;
	reviewer: string;
	approved: boolean;
	note: string;
	time: string;
}

export interface TrackCheck {
	trackId: string;
	totalCues: number;
	stale: Blocker[];
	untranslated: number;
	unapproved: number;
	ready: boolean;
}

export interface DeliveryContext {
	sourceTrackId: string;
	sourceMap: Map<string, SourceCue>;
	sources: SourceCue[];
	termsFingerprint: string;
}

export interface GeneratedArtifact {
	requestId: string;
	trackId: string;
	cueCount: number;
	checksum: string;
	generatedAt: string;
}

export interface LanguageDelivery {
	trackId: string;
	status: "等待" | "进行中" | "完成" | "失败";
	attempts: number;
	artifact?: GeneratedArtifact;
	error?: string;
}

export interface DeliveryRun {
	requestId: string;
	createdAt: string;
	status: "已阻塞" | "进行中" | "部分完成" | "完成";
	/** 建包时的阻塞项快照，供后到的审校确认查看“最新阻塞项” */
	blockers: Blocker[];
	languages: Record<string, LanguageDelivery>;
}

/* ---------------------------------- 指纹 ---------------------------------- */

function round(value: number) {
	return Number(value.toFixed(3));
}

function cyrb53(input: string) {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < input.length; i += 1) {
		const ch = input.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

function oneSourceFingerprint(cue: SourceCue) {
	return `${cue.id}@${round(cue.start)}-${round(cue.end)}:${cue.source}`;
}

/** 当前锁定术语集合的指纹；锁定 / 解锁 / 译文变化都会改变。 */
export function lockedTermsFingerprint(terms: GlossaryTerm[]) {
	return terms
		.filter((term) => term.status === "已锁定")
		.map((term) => `${term.source}=>${term.target}`)
		.sort()
		.join("|");
}

export function buildContext(cues: Cue[], terms: GlossaryTerm[], sourceTrackId: string): DeliveryContext {
	const sources = cues.filter((cue): cue is SourceCue => cue.trackId === sourceTrackId);
	return {
		sourceTrackId,
		sources,
		sourceMap: new Map(sources.map((cue) => [cue.id, cue])),
		termsFingerprint: lockedTermsFingerprint(terms)
	};
}

export function isSource(cue: Cue, sourceTrackId: string): cue is SourceCue {
	return cue.trackId === sourceTrackId;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }) {
	return round(a.start) < round(b.end) && round(a.end) > round(b.start);
}

/* --------------------------------- 失效判定 -------------------------------- */

/**
 * 返回字幕当前的阻塞项；null 表示与原片段、术语库保持同步。
 */
export function cueStaleness(cue: TargetCue, ctx: DeliveryContext): Blocker | null {
	const linked = cue.sourceIds.map((id) => ctx.sourceMap.get(id)).filter((s): s is SourceCue => Boolean(s));

	// 1) 关联的原片段消失（被合并 / 删除）
	const missing = cue.sourceIds.filter((id) => !ctx.sourceMap.has(id));
	if (missing.length > 0) {
		return {
			cueId: cue.id,
			trackId: cue.trackId,
			kind: "原片段合并",
			message: `关联原片段 ${missing.join("、")} 已被合并或删除，需重算来源。`
		};
	}

	// 2) 时间范围内出现未关联的新原片段（拆分）
	const newcomer = ctx.sources.find((s) => !cue.sourceIds.includes(s.id) && overlaps(s, cue));
	if (newcomer) {
		return {
			cueId: cue.id,
			trackId: cue.trackId,
			kind: "原片段拆分",
			message: `原片段在 ${formatTime(newcomer.start)} 附近被拆分，译文覆盖范围需重算。`
		};
	}

	if (linked.length > 0) {
		const currentFingerprint = linked.map(oneSourceFingerprint).join(";;");
		if (currentFingerprint !== cue.sourceSnapshot) {
			const snapshotMap = new Map(
				cue.sourceSnapshot.split(";;").map((part) => {
					const [id, body] = part.split(/@(.*)/s);
					return [id, body];
				})
			);
			let kind: BlockerKind = "原文变更";
			for (const source of linked) {
				const oldBody = snapshotMap.get(source.id);
				if (!oldBody) continue;
				const match = /^([\d.]+)-([\d.]+):([\s\S]*)$/.exec(oldBody);
				if (!match) continue;
				const [, oldStart, oldEnd, oldText] = match;
				if (round(Number(oldStart)) !== round(source.start) || round(Number(oldEnd)) !== round(source.end)) {
					kind = "时间码变更";
					break;
				}
				if (oldText !== source.source) kind = "原文变更";
			}
			return {
				cueId: cue.id,
				trackId: cue.trackId,
				kind,
				message:
					kind === "时间码变更"
						? `原片段时间码已调整（${linked.map((s) => `${formatTime(s.start)}–${formatTime(s.end)}`).join("，")}），译文时间轴需重算。`
						: "原文字幕已修改，译文需对照重算。"
			};
		}
	}

	// 3) 锁定术语集合变化
	if (cue.termSnapshot !== ctx.termsFingerprint) {
		return {
			cueId: cue.id,
			trackId: cue.trackId,
			kind: "术语锁定变更",
			message: "术语库锁定项发生变化，需按最新术语重算并重新审校。"
		};
	}

	return null;
}

/* --------------------------------- 重算 ----------------------------------- */

/** 重新关联原片段、刷新指纹。重算后旧版本审校结论全部失效，需重新审校。 */
export function recomputeFields(cue: TargetCue, ctx: DeliveryContext): Pick<TargetCue, "sourceIds" | "sourceSnapshot" | "termSnapshot" | "status" | "reviewerNote" | "rev"> {
	const linked = ctx.sources.filter((s) => cue.sourceIds.includes(s.id) || overlaps(s, cue));
	const sourceIds = linked.map((s) => s.id);
	const sourceSnapshot = linked.map(oneSourceFingerprint).join(";;");
	return {
		sourceIds,
		sourceSnapshot,
		termSnapshot: ctx.termsFingerprint,
		// 结构变化后一律回到待审 / 待译，已有的审校通过不再有效
		status: cue.translated.trim() ? "待审" : "待译",
		reviewerNote: cue.reviewerNote ? `${cue.reviewerNote}｜已按最新原片段 / 术语重算` : "已按最新原片段 / 术语重算，待重新审校",
		rev: cue.rev + 1
	};
}

/* -------------------------------- 审校结论 -------------------------------- */

export function isVerdictActive(verdict: ReviewVerdict, cue: TargetCue | undefined, ctx: DeliveryContext): boolean {
	if (!cue || verdict.cueRev !== cue.rev) return false;
	if (cueStaleness(cue, ctx)) return false;
	return true;
}

export type ConfirmResult =
	| { ok: true; verdict: ReviewVerdict; duplicated: boolean }
	| {
			ok: false;
			reason: "版本冲突" | "存在阻塞项" | "字幕不存在";
			currentRev: number;
			existingVerdict?: ReviewVerdict;
			blockers: Blocker[];
		};

/**
 * 两名审校员同时确认同一字幕：
 * - 先到者的结论绑定当前 rev 生效；
 * - 后到者拿到版本冲突，并附带该语言最新阻塞项；
 * - 同一审校员重复确认按幂等处理，沿用首次结论。
 */
export function confirmVerdict(
	cues: Cue[],
	verdicts: ReviewVerdict[],
	ctx: DeliveryContext,
	input: { cueId: string; reviewer: string; approved: boolean; note?: string; now: string; id: string }
): ConfirmResult {
	const cue = cues.find((item): item is TargetCue => item.id === input.cueId && item.trackId !== ctx.sourceTrackId);
	if (!cue) {
		return { ok: false, reason: "字幕不存在", currentRev: -1, blockers: [] };
	}

	const blockers = evaluateTracks(cues, verdicts, ctx, [cue.trackId]).blockers;
	const own = blockers.filter((blocker) => blocker.cueId === cue.id);
	if (own.length > 0) {
		return { ok: false, reason: "存在阻塞项", currentRev: cue.rev, blockers: own };
	}

	const existing = verdicts.find((verdict) => verdict.cueId === cue.id && verdict.cueRev === cue.rev && isVerdictActive(verdict, cue, ctx));
	if (existing) {
		if (existing.reviewer === input.reviewer) {
			return { ok: true, verdict: existing, duplicated: true };
		}
		return {
			ok: false,
			reason: "版本冲突",
			currentRev: cue.rev,
			existingVerdict: existing,
			blockers
		};
	}

	const verdict: ReviewVerdict = {
		id: input.id,
		cueId: cue.id,
		cueRev: cue.rev,
		reviewer: input.reviewer,
		approved: input.approved,
		note: input.note ?? "",
		time: input.now
	};
	return { ok: true, verdict, duplicated: false };
}

/* -------------------------------- 交付门 ---------------------------------- */

export function evaluateTracks(cues: Cue[], verdicts: ReviewVerdict[], ctx: DeliveryContext, trackIds?: string[]): { tracks: TrackCheck[]; blockers: Blocker[]; ready: boolean } {
	const targets = cues.filter((cue): cue is TargetCue => cue.trackId !== ctx.sourceTrackId);
	const ids = trackIds ? new Set(trackIds) : null;
	const checks: TrackCheck[] = [];
	const blockers: Blocker[] = [];

	for (const cue of targets) {
		if (ids && !ids.has(cue.trackId)) continue;
		let check = checks.find((item) => item.trackId === cue.trackId);
		if (!check) {
			check = { trackId: cue.trackId, totalCues: 0, stale: [], untranslated: 0, unapproved: 0, ready: true };
			checks.push(check);
		}
		check.totalCues += 1;
		const stale = cueStaleness(cue, ctx);
		if (stale) {
			check.stale.push(stale);
			blockers.push(stale);
		}
		if (!cue.translated.trim()) check.untranslated += 1;
		const approved = verdicts.some((v) => v.cueId === cue.id && v.approved && isVerdictActive(v, cue, ctx));
		if (!stale && (!cue.translated.trim() || !approved)) check.unapproved += 1;
	}

	for (const check of checks) {
		check.ready = check.stale.length === 0 && check.untranslated === 0 && check.unapproved === 0;
	}
	return { tracks: checks, blockers, ready: checks.length > 0 && checks.every((check) => check.ready) };
}

/* ------------------------------- 交付包生成 ------------------------------- */

export function artifactChecksum(cue: TargetCue, ctx: DeliveryContext, requestId: string, now: string): string {
	const linked = cue.sourceIds.map((id) => ctx.sourceMap.get(id)?.source ?? "").join("|");
	return cyrb53([requestId, cue.trackId, cue.id, round(cue.start), round(cue.end), linked, cue.translated, cue.termSnapshot, now].join(""));
}

export function createRun(input: {
	requestId: string;
	now: string;
	trackIds: string[];
	evaluation: { blockers: Blocker[]; ready: boolean };
}): DeliveryRun {
	const blocked = !input.evaluation.ready;
	const languages: Record<string, LanguageDelivery> = {};
	for (const trackId of input.trackIds) {
		languages[trackId] = { trackId, status: blocked ? "等待" : "等待", attempts: 0 };
	}
	return {
		requestId: input.requestId,
		createdAt: input.now,
		status: blocked ? "已阻塞" : "进行中",
		blockers: input.evaluation.blockers,
		languages
	};
}

export function overallStatus(run: DeliveryRun): DeliveryRun["status"] {
	if (run.status === "已阻塞") return "已阻塞";
	const states = Object.values(run.languages).map((language) => language.status);
	if (states.some((status) => status === "进行中" || status === "等待")) return "进行中";
	if (states.every((status) => status === "完成")) return "完成";
	return "部分完成";
}

/** 重试：只重新排队失败语言，已完成语言原样保留。 */
export function requeueFailed(run: DeliveryRun): string[] {
	const failed = Object.values(run.languages).filter((language) => language.status === "失败");
	for (const language of failed) {
		language.status = "等待";
		language.error = undefined;
	}
	run.status = "进行中";
	return failed.map((language) => language.trackId);
}

export function formatTime(value: number) {
	const minutes = Math.floor(value / 60);
	const seconds = Math.floor(value % 60);
	const tenths = Math.floor((value % 1) * 10);
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}
