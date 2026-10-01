import { browser } from "$app/environment";
import { derived, get, writable } from "svelte/store";

export type TrackStatus = "草稿" | "审校中" | "已通过" | "需修改";
export type CueStatus = "待译" | "翻译中" | "待审" | "已通过" | "退回";
export type TermStatus = "建议" | "已锁定";

export interface Track {
  id: string;
  name: string;
  locale: "zh" | "en" | "ja";
  status: TrackStatus;
}

export interface Cue {
  id: string;
  trackId: string;
  start: number;
  end: number;
  source: string;
  translated: string;
  status: CueStatus;
  translator: string;
  reviewerNote: string;
  /** 乐观并发版本号：每次内容/状态变更自增，审校确认时携带，先到者生效 */
  version: number;
  /** 翻译轨字幕所依赖的原片段 id */
  sourceId?: string;
  /** 翻译基于的原片段版本，原片段版本变化即失效 */
  basedOnVersion?: number;
  /** 翻译时各术语的锁定版本，术语锁定变化即失效 */
  termSnapshot?: Record<string, number>;
}

export interface GlossaryTerm {
  id: string;
  source: string;
  target: string;
  status: TermStatus;
  owner: string;
  /** 锁定版本号：锁定/解锁切换时自增，依赖它的字幕随之失效 */
  version: number;
}

export interface ReviewEvent {
  id: string;
  cueId: string;
  action: "提交审校" | "审校通过" | "退回修改" | "术语锁定";
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
  type: "时间码冲突" | "版本冲突";
  message: string;
  remoteStart?: number;
  remoteEnd?: number;
  status: "待处理" | "采用本地" | "采用协作版本" | "已处理";
  /** 版本冲突时的最新阻塞项（失效原因 + 未决冲突） */
  blocking?: string[];
  expectedVersion?: number;
  currentVersion?: number;
}

const KEY = "pair-wise-yf-51/subtitles-v2";
const seedTracks: Track[] = [
  { id: "zh", name: "中文原字幕", locale: "zh", status: "已通过" },
  { id: "en", name: "English 翻译", locale: "en", status: "审校中" },
  { id: "ja", name: "日本語訳", locale: "ja", status: "草稿" }
];
const seedCues: Cue[] = [
  { id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮汐退去后，码头重新露出水面。", status: "已通过", translator: "系统", reviewerNote: "", version: 1 },
  { id: "c5", trackId: "zh", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "修复组必须在下一场潮水到来前完成加固。", status: "已通过", translator: "系统", reviewerNote: "", version: 1 },
  { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide recedes, the pier emerges again.", status: "待审", translator: "林岚", reviewerNote: "", version: 1, sourceId: "c1", basedOnVersion: 1, termSnapshot: { g1: 1, g2: 1 } },
  { id: "c3", trackId: "en", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "The repair team must reinforce it before the next tide.", status: "翻译中", translator: "林岚", reviewerNote: "", version: 1, sourceId: "c5", basedOnVersion: 1, termSnapshot: { g3: 1 } },
  { id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮が引くと、桟橋が再び姿を現す。", status: "待译", translator: "周野", reviewerNote: "", version: 1, sourceId: "c1", basedOnVersion: 1, termSnapshot: { g1: 1, g2: 1 } }
];
const seedTerms: GlossaryTerm[] = [
  { id: "g1", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员", version: 1 },
  { id: "g2", source: "码头", target: "pier", status: "已锁定", owner: "术语管理员", version: 1 },
  { id: "g3", source: "加固", target: "reinforce", status: "建议", owner: "林岚", version: 1 }
];

const initial = browser && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;
export const tracks = writable<Track[]>(initial?.tracks ?? seedTracks);
export const cues = writable<Cue[]>(initial?.cues ?? seedCues);
export const terms = writable<GlossaryTerm[]>(initial?.terms ?? seedTerms);
export const reviewEvents = writable<ReviewEvent[]>(initial?.events ?? []);
export const snapshots = writable<Snapshot[]>(initial?.snapshots ?? []);
export const conflicts = writable<TimelineConflict[]>(initial?.conflicts ?? [{
  id: "x1", cueId: "c2", type: "时间码冲突",
  message: "协作者将结束时间调整为3.0秒，与本机存在0.2秒差异。",
  remoteStart: 0, remoteEnd: 3, status: "待处理"
}]);
export const activeTrackId = writable("en");
export const selectedCueId = writable("c2");
export const reviewer = writable("审校-顾宁");
export const reviewerB = writable("审校-苏晴");

/** 原片段轨（源语言轨）：翻译轨字幕的依赖对象 */
export const sourceTrackId = derived(tracks, ($tracks) => $tracks.find((track) => track.locale === "zh")?.id ?? "zh");

// === 交付生成状态：按语种缓存、部分完成、重试只补未完成、重复请求沿用首次结果 ===

export type GenStatus = "idle" | "generating" | "done" | "blocked" | "error";

export interface LangGen {
  status: GenStatus;
  /** 生成时的输入指纹；输入变化后旧结果视为过期 */
  requestKey: string;
  payload?: string;
  error?: string;
  attempts: number;
}

export interface DeliveryState {
  requestKey: string;
  languages: Record<string, LangGen>;
}

const initialDelivery: DeliveryState = initial?.delivery ?? { requestKey: "", languages: {} };
export const delivery = writable<DeliveryState>(initialDelivery);

function persist() {
  if (!browser) return;
  localStorage.setItem(KEY, JSON.stringify({
    tracks: get(tracks), cues: get(cues), terms: get(terms),
    events: get(reviewEvents), snapshots: get(snapshots), conflicts: get(conflicts),
    delivery: get(delivery)
  }));
}
[tracks, cues, terms, reviewEvents, snapshots, conflicts].forEach((store) => store.subscribe(persist));

function event(cue: Cue | undefined, action: ReviewEvent["action"], detail: string, actor: string = get(reviewer)) {
  reviewEvents.update((items) => [{ id: crypto.randomUUID(), cueId: cue?.id ?? "", action, detail, actor, time: new Date().toISOString() }, ...items]);
}

/** 纯函数：计算一条翻译字幕的失效原因（不依赖 store，供 derived 复用） */
function staleReasonsFor(cue: Cue, allCues: Cue[], allTerms: GlossaryTerm[], srcId: string): string[] {
  const reasons: string[] = [];
  if (cue.trackId === srcId) return reasons; // 原片段本身不失效
  if (!cue.sourceId) {
    reasons.push("未关联原片段（拆分或合并后未重算）");
    return reasons;
  }
  const source = allCues.find((item) => item.id === cue.sourceId);
  if (!source) {
    reasons.push("原片段已不存在（拆分或合并后未重算）");
  } else if (cue.basedOnVersion !== source.version) {
    reasons.push("原片段已更新（时间码或原文变化）");
  }
  for (const term of allTerms) {
    if (cue.source.includes(term.source) && cue.termSnapshot?.[term.id] !== term.version) {
      reasons.push(`术语「${term.source} → ${term.target}」锁定已变化`);
    }
  }
  return [...new Set(reasons)];
}

/** 字幕失效原因列表（空数组表示有效） */
export function staleReasons(cue: Cue): string[] {
  return staleReasonsFor(cue, get(cues), get(terms), get(sourceTrackId));
}

export function isStale(cue: Cue): boolean {
  return staleReasons(cue).length > 0;
}

/** 某语种的全部字幕（按开始时间排序） */
export function cuesForLocale(locale: string): Cue[] {
  return get(cues)
    .filter((cue) => get(tracks).find((track) => track.id === cue.trackId)?.locale === locale)
    .sort((a, b) => a.start - b.start);
}

/** 重算单条字幕：刷新原片段与术语依赖快照，清除失效标记 */
export function recomputeCue(id: string) {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue || cue.trackId === get(sourceTrackId)) return;
  let sourceId = cue.sourceId;
  let basedOnVersion = cue.basedOnVersion;
  const source = sourceId ? get(cues).find((item) => item.id === sourceId) : undefined;
  if (!source) {
    // 原片段在拆分/合并后 id 失效：就近重连到当前时间轴上的原片段
    const fallback = get(cues)
      .filter((item) => item.trackId === get(sourceTrackId))
      .sort((a, b) => Math.abs(a.start - cue.start) - Math.abs(b.start - cue.start))[0];
    if (fallback) {
      sourceId = fallback.id;
      basedOnVersion = fallback.version;
    }
  } else {
    basedOnVersion = source.version;
  }
  const termSnapshot: Record<string, number> = {};
  for (const term of get(terms)) {
    if (cue.source.includes(term.source)) termSnapshot[term.id] = term.version;
  }
  cues.update((items) => items.map((item) => item.id === id
    ? { ...item, sourceId, basedOnVersion, termSnapshot, status: "翻译中", version: item.version + 1 }
    : item));
}

/** 全部重算：清除所有翻译轨字幕的失效标记 */
export function recomputeAll() {
  for (const cue of get(cues)) {
    if (cue.trackId !== get(sourceTrackId) && staleReasons(cue).length) recomputeCue(cue.id);
  }
}

export function updateCue(id: string, patch: Partial<Cue>, log = false) {
  cues.update((items) => items.map((cue) => cue.id === id ? { ...cue, ...patch, version: cue.version + 1 } : cue));
  if (log) event(get(cues).find((cue) => cue.id === id), "退回修改", "编辑字幕内容或时间码");
}

export function nudgeCue(id: string, delta: number) {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  updateCue(id, { start: Math.max(0, Number((cue.start + delta).toFixed(1))), end: Math.max(cue.start + 0.5, Number((cue.end + delta).toFixed(1))) });
}

export function splitCue(id: string) {
  const list = get(cues);
  const cue = list.find((item) => item.id === id);
  if (!cue || cue.end - cue.start < 1) return;
  const middle = Number(((cue.start + cue.end) / 2).toFixed(1));
  // 前段保留原 id（版本自增），后段为新片段；依赖原片段的翻译轨字幕因此失效
  const first = { ...cue, end: middle, translated: `${cue.translated}`, status: "翻译中" as CueStatus, version: cue.version + 1 };
  const second: Cue = { ...cue, id: crypto.randomUUID(), start: middle, translated: "", status: "待译", version: 1, sourceId: cue.sourceId, basedOnVersion: cue.version + 1, termSnapshot: { ...(cue.termSnapshot ?? {}) } };
  cues.set(list.flatMap((item) => item.id === id ? [first, second] : [item]));
  selectedCueId.set(second.id);
}

export function mergeNext(id: string) {
  const list = [...get(cues)].sort((a, b) => a.start - b.start).filter((item) => item.trackId === get(activeTrackId));
  const index = list.findIndex((item) => item.id === id);
  const current = list[index];
  const next = list[index + 1];
  if (!current || !next) return;
  // 合并后移除后一片段（id 消失），依赖它的翻译轨字幕失效
  cues.update((items) => items
    .filter((item) => item.id !== next.id)
    .map((item) => item.id === id
      ? { ...item, end: next.end, translated: `${item.translated} ${next.translated}`.trim(), status: "翻译中", version: item.version + 1 }
      : item));
}

export function setCueStatus(id: string, status: CueStatus) {
  const before = get(cues).find((item) => item.id === id);
  if (!before) return;
  cues.update((items) => items.map((item) => item.id === id ? { ...item, status, version: item.version + 1 } : item));
  const cue = get(cues).find((item) => item.id === id);
  event(cue, status === "待审" ? "提交审校" : status === "已通过" ? "审校通过" : "退回修改", cue?.translated ?? "");
}

export interface ReviewOutcome {
  ok: boolean;
  reason?: string;
  expectedVersion?: number;
  currentVersion?: number;
  /** 最新阻塞项：失效原因 + 该字幕未决冲突 */
  blocking?: string[];
}

/**
 * 审校确认（乐观并发）：携带看到的版本号，先到者生效。
 * 版本不符时不写入，返回版本冲突与最新阻塞项。
 */
export function reviewCue(id: string, approved: boolean, note = "", expectedVersion?: number, actorOverride?: string): ReviewOutcome {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return { ok: false, reason: "字幕不存在" };
  const actor = actorOverride ?? get(reviewer);
  if (expectedVersion !== undefined && cue.version !== expectedVersion) {
    const blocking = [
      ...staleReasonsFor(cue, get(cues), get(terms), get(sourceTrackId)),
      ...get(conflicts).filter((item) => item.cueId === id && item.status === "待处理").map((item) => item.message)
    ];
    const conflict: TimelineConflict = {
      id: crypto.randomUUID(),
      cueId: id,
      type: "版本冲突",
      message: `${actor} 基于 v${expectedVersion} 确认，但字幕已更新到 v${cue.version}，本次确认未生效。`,
      status: "待处理",
      blocking,
      expectedVersion,
      currentVersion: cue.version
    };
    conflicts.update((items) => [conflict, ...items]);
    return { ok: false, reason: "版本冲突", expectedVersion, currentVersion: cue.version, blocking };
  }
  cues.update((items) => items.map((item) => item.id === id
    ? { ...item, status: approved ? "已通过" : "退回", reviewerNote: note, version: item.version + 1 }
    : item));
  event(get(cues).find((item) => item.id === id), approved ? "审校通过" : "退回修改", note || cue.translated, actor);
  return { ok: true };
}

export function lockTerm(id: string) {
  terms.update((items) => items.map((term) => term.id === id
    ? { ...term, status: term.status === "已锁定" ? "建议" : "已锁定", version: term.version + 1, owner: "术语管理员" }
    : term));
  const term = get(terms).find((item) => item.id === id);
  const cue = get(cues).find((item) => item.id === get(selectedCueId));
  event(cue, "术语锁定", `${term?.source} → ${term?.target}（${term?.status}）`);
}

export function createSnapshot(name = `时间轴快照 ${get(snapshots).length + 1}`) {
  snapshots.update((items) => [{ id: crypto.randomUUID(), name, time: new Date().toISOString(), cues: structuredClone(get(cues)) }, ...items].slice(0, 12));
}

export function restoreSnapshot(id: string) {
  const snapshot = get(snapshots).find((item) => item.id === id);
  if (snapshot) cues.set(structuredClone(snapshot.cues));
}

export function resolveConflict(id: string, resolution: TimelineConflict["status"]) {
  conflicts.update((items) => items.map((item) => item.id === id ? { ...item, status: resolution } : item));
  if (resolution === "采用协作版本") {
    const conflict = get(conflicts).find((item) => item.id === id);
    if (conflict && conflict.remoteStart !== undefined) updateCue(conflict.cueId, { start: conflict.remoteStart, end: conflict.remoteEnd });
  }
}

// === 交付生成：按语种缓存、部分完成、重试只补未完成、重复请求沿用首次结果 ===

/** 输入指纹：字幕版本/状态 + 术语版本，任一变化则旧交付结果过期 */
function requestKeyFor(cues: Cue[], terms: GlossaryTerm[]): string {
  const payload = JSON.stringify({
    cues: cues.map((cue) => [cue.id, cue.trackId, cue.version, cue.status, cue.source, cue.translated, cue.start, cue.end]),
    terms: terms.map((term) => [term.id, term.version, term.status])
  });
  let hash = 0;
  for (let i = 0; i < payload.length; i++) hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
  return `k${(hash >>> 0).toString(36)}`;
}

export const deliveryRequestKey = () => requestKeyFor(get(cues), get(terms));

function exportText(locale: string): string {
  const fmt = (value: number) => {
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    const tenths = Math.floor((value % 1) * 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
  };
  const lines = [`# ${locale.toUpperCase()} 字幕导出`, `# 生成时间 ${new Date().toLocaleString("zh-CN")}`, ""];
  for (const cue of cuesForLocale(locale)) {
    lines.push(`[${fmt(cue.start)} --> ${fmt(cue.end)}]`, cue.translated || "（未填译文）", "");
  }
  return lines.join("\n");
}

/** 生成某语种交付物：阻塞则不生成；已完成且指纹相同则沿用缓存；失败可重试 */
export function generateLanguage(locale: string) {
  const key = requestKeyFor(get(cues), get(terms));
  const state = get(delivery);
  const prev = state.languages[locale];
  if (prev?.status === "generating") return; // 生成中，忽略重复触发
  if (prev?.status === "done" && prev.requestKey === key) return; // 重复请求沿用首次结果

  const track = get(tracks).find((item) => item.locale === locale);
  const stale = track
    ? get(cues).filter((cue) => cue.trackId !== get(sourceTrackId) && cue.trackId === track.id && staleReasons(cue).length)
    : [];
  if (stale.length) {
    delivery.update((item) => ({
      ...item,
      requestKey: key,
      languages: {
        ...item.languages,
        [locale]: { status: "blocked", requestKey: key, attempts: prev?.requestKey === key ? prev.attempts : 0, error: `存在 ${stale.length} 条失效字幕，未重算前不生成交付包` }
      }
    }));
    return;
  }

  const attempts = (prev?.requestKey === key ? prev.attempts : 0) + 1;
  delivery.update((item) => ({
    ...item,
    requestKey: key,
    languages: { ...item.languages, [locale]: { status: "generating", requestKey: key, attempts } }
  }));

  // 模拟生成服务：ja 首次失败，重试成功；其余语种一次成功
  window.setTimeout(() => {
    const current = get(delivery).languages[locale];
    if (current?.status !== "generating" || current.requestKey !== key) return;
    const fail = locale === "ja" && attempts === 1;
    delivery.update((item) => ({
      ...item,
      languages: {
        ...item.languages,
        [locale]: fail
          ? { status: "error", requestKey: key, attempts, error: "生成服务暂时不可用（模拟），请重试" }
          : { status: "done", requestKey: key, attempts, payload: exportText(locale) }
      }
    }));
  }, 900);
}

/** 生成交付包：各语种独立生成，已完成语种保留，阻塞语种标记阻塞 */
export function generateAll() {
  for (const track of get(tracks)) {
    if (track.locale !== "zh") generateLanguage(track.locale);
  }
}

/** 重试：只补失败语种，已完成语种不动 */
export function retryLanguage(locale: string) {
  const lang = get(delivery).languages[locale];
  if (lang?.status === "error") generateLanguage(locale);
}

export interface LangDeliveryView {
  locale: string;
  trackName: string;
  total: number;
  staleCount: number;
  gen: LangGen | undefined;
  /** 缓存结果是否对应当前输入指纹（否则为过期结果） */
  current: boolean;
  blocking: { cueId: string; message: string }[];
}

export interface DeliveryView {
  key: string;
  languages: LangDeliveryView[];
  blockedCount: number;
  doneCount: number;
}

export const deliveryView = derived([delivery, cues, terms, tracks], ([$delivery, $cues, $terms, $tracks]) => {
  const key = requestKeyFor($cues, $terms);
  const srcId = $tracks.find((track) => track.locale === "zh")?.id ?? "zh";
  const languages: LangDeliveryView[] = $tracks
    .filter((track) => track.locale !== "zh")
    .map((track) => {
      const list = $cues.filter((cue) => cue.trackId === track.id).sort((a, b) => a.start - b.start);
      const stale = list
        .map((cue) => ({ cue, reasons: staleReasonsFor(cue, $cues, $terms, srcId) }))
        .filter((item) => item.reasons.length);
      const gen = $delivery.languages[track.locale];
      return {
        locale: track.locale,
        trackName: track.name,
        total: list.length,
        staleCount: stale.length,
        gen,
        current: gen?.requestKey === key,
        blocking: stale.map((item) => ({ cueId: item.cue.id, message: item.reasons.join("；") }))
      };
    });
  return {
    key,
    languages,
    blockedCount: languages.filter((item) => item.staleCount > 0).length,
    doneCount: languages.filter((item) => item.gen?.status === "done" && item.current).length
  };
});

export const activeCues = derived([cues, activeTrackId, selectedCueId], ([$cues, $activeTrackId, $selectedCueId]) => $cues.filter((cue) => cue.trackId === $activeTrackId).sort((a, b) => a.start - b.start).map((cue) => ({ ...cue, selected: cue.id === $selectedCueId })));
