<script lang="ts">
  import { onMount } from "svelte";
  import { derived, get } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import { superForm } from "sveltekit-superforms";
  import { zod4 } from "sveltekit-superforms/adapters";
  import { z } from "zod";
  import * as m from "$lib/paraglide/messages.js";
  import { setLocale } from "$lib/paraglide/runtime.js";
  import {
    activeCues, activeTrackId, conflicts, createSnapshot, cues, deliveryView,
    generateAll, generateLanguage, lockTerm, mergeNext, nudgeCue, recomputeAll,
    recomputeCue, resolveConflict, restoreSnapshot, reviewCue, reviewEvents, reviewer,
    reviewerB, retryLanguage, selectedCueId, setCueStatus, snapshots, sourceTrackId, splitCue,
    staleReasons, terms, tracks, updateCue
  } from "$lib/stores/subtitles";
  import type { Cue, ReviewOutcome } from "$lib/stores/subtitles";

  const cueSchema = z.object({ source: z.string().min(2), translated: z.string().min(2), start: z.coerce.number().min(0), duration: z.coerce.number().min(0.5).max(30) });
  const defaults = { source: "", translated: "", start: 0, duration: 2.5 };
  const { form, errors, enhance } = superForm(defaults, {
    validators: zod4(cueSchema),
    onSubmit: async ({ formData }) => {
      const start = Number(formData.get("start") ?? 0);
      const item: Cue = { id: crypto.randomUUID(), trackId: $activeTrackId, start, end: start + Number(formData.get("duration") ?? 2.5), source: String(formData.get("source") ?? ""), translated: String(formData.get("translated") ?? ""), status: "翻译中", translator: "当前译者", reviewerNote: "", version: 1 };
      cues.update((items) => [...items, item]);
      selectedCueId.set(item.id);
    }
  });
  const queryOptions = derived(activeTrackId, ($trackId) => ({ queryKey: ["cues", $trackId] as const, queryFn: async (): Promise<Cue[]> => get(activeCues) }));
  const query = createQuery(queryOptions);
  const activeTrack = $derived($tracks.find((track) => track.id === $activeTrackId));
  const selected = $derived($cues.find((cue) => cue.id === $selectedCueId));
  const staleTotal = $derived($cues.filter((cue) => cue.trackId !== $sourceTrackId && staleReasons(cue).length > 0).length);
  let reviewNote = $state("");
  let outcomes = $state<{ actor: string; outcome: ReviewOutcome }[]>([]);

  function formatTime(value: number) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    const tenths = Math.floor((value % 1) * 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
  }

  function confirmReview(id: string, approved: boolean, note = "") {
    const outcome = reviewCue(id, approved, note, selected?.version, $reviewer);
    outcomes = [{ actor: $reviewer, outcome }, ...outcomes].slice(0, 5);
  }

  /** 模拟两名审校员基于同一版本同时确认：先到者生效，后到者看到版本冲突与最新阻塞项 */
  function simultaneousConfirm() {
    const cue = selected;
    if (!cue) return;
    const base = cue.version;
    const a = reviewCue(cue.id, true, "", base, $reviewer);
    const b = reviewCue(cue.id, true, "", base, $reviewerB);
    outcomes = [
      { actor: $reviewer, outcome: a },
      { actor: $reviewerB, outcome: b },
      ...outcomes
    ].slice(0, 6);
  }

  onMount(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.tagName === "TEXTAREA" || (event.target as HTMLElement)?.tagName === "INPUT") return;
      const list = $activeCues;
      const index = list.findIndex((cue) => cue.id === $selectedCueId);
      if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") selectedCueId.set(list[Math.min(list.length - 1, index + 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") selectedCueId.set(list[Math.max(0, index - 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "s") splitCue($selectedCueId);
      if (event.key.toLowerCase() === "m") mergeNext($selectedCueId);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); createSnapshot(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
</script>

<svelte:head><title>多语言字幕时间轴协作</title></svelte:head>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><b>SUBFLOW</b><span>字幕协作台</span></div>
    <nav><button class="active">时间轴编辑</button><button>审校队列</button><button>术语库</button><button>版本快照</button></nav>
    <div class="keyboard"><b>键盘操作</b><span>J / K 选择字幕</span><span>S 拆分 · M 合并</span><span>⌘S 保存快照</span></div>
  </aside>
  <main>
    <header><div><small>纪录片《潮汐线》 · 第 3 集</small><h1>{m.title()}</h1><p>多语种轨道、术语锁定与审校结论接成可重算的交付检查。</p></div><div class="header-actions"><select value={$activeTrackId} onchange={(event) => activeTrackId.set(event.currentTarget.value)}>{#each $tracks as track}<option value={track.id}>{track.name}</option>{/each}</select><select value={$reviewer} onchange={(event) => reviewer.set(event.currentTarget.value)}><option value="审校-顾宁">审校-顾宁</option><option value="审校-苏晴">审校-苏晴</option></select><button onclick={() => setLocale("en")}>EN</button><button onclick={() => setLocale("zh")}>中文</button></div></header>

    <section class="metrics"><article><span>当前轨道</span><b>{activeTrack?.name}</b></article><article><span>字幕条数</span><b>{$activeCues.length}</b></article><article><span>待审</span><b>{$activeCues.filter((cue) => cue.status === "待审").length}</b></article><article><span>已锁定术语</span><b>{$terms.filter((term) => term.status === "已锁定").length}</b></article><article><span>失效字幕</span><b class={staleTotal ? "stale-num" : ""}>{staleTotal}</b></article></section>

    <div class="editor-grid">
      <section class="panel timeline">
        <div class="panel-head"><div><h2>时间轴</h2><small>拆分、合并或术语锁定后，相关字幕立即失效，需重算</small></div><button class="btn variant-filled-primary" onclick={() => createSnapshot()}>保存快照</button></div>
        {#if $query.isPending}<p>正在加载字幕轨道…</p>{:else}
          <div class="cue-list">
            {#each $activeCues as cue}
              {@const reasons = staleReasons(cue)}
              <div role="button" tabindex="0" class:selected={cue.id === $selectedCueId} class={`cue ${cue.status}`} class:stale={reasons.length > 0} onclick={() => selectedCueId.set(cue.id)} onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") selectedCueId.set(cue.id); }}>
                <time>{formatTime(cue.start)}<small>{formatTime(cue.end)}</small></time>
                <div><b>{cue.source}</b><p>{cue.translated || "尚未填写译文"}</p>
                  <div class="cue-meta">
                    <span class="chip version">v{cue.version}</span>
                    {#if reasons.length}<span class="chip variant-filled-error">已失效</span>{/if}
                  </div>
                </div>
                <span class={`chip ${cue.status}`}>{cue.status}</span>
                {#if reasons.length}
                  <button class="btn btn-sm variant-filled-warning" onclick={(event) => { event.stopPropagation(); recomputeCue(cue.id); }}>重算</button>
                {/if}
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, -0.2); }}>−0.2s</button>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, 0.2); }}>+0.2s</button>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <aside class="right-stack">
        <section class="panel">
          <div class="panel-head"><h2>字幕编辑</h2>{#if selected}<span class="chip version">v{selected.version}</span>{/if}</div>
          {#if selected}
            {@const reasons = staleReasons(selected)}
            {#if reasons.length}
              <div class="stale-box"><b>该字幕已失效：</b><ul>{#each reasons as reason}<li>{reason}</li>{/each}</ul><button class="btn btn-sm variant-filled-warning" onclick={() => recomputeCue(selected.id)}>重算依赖</button></div>
            {/if}
            <label class="label"><span>原文字幕</span><input class="input" value={selected.source} oninput={(event) => updateCue(selected.id, { source: event.currentTarget.value })} /></label>
            <label class="label"><span>译文</span><textarea class="textarea" value={selected.translated} oninput={(event) => updateCue(selected.id, { translated: event.currentTarget.value })}></textarea></label>
            <div class="time-fields"><label class="label"><span>开始秒</span><input class="input" type="number" step="0.1" value={selected.start} oninput={(event) => updateCue(selected.id, { start: Number(event.currentTarget.value) })} /></label><label class="label"><span>结束秒</span><input class="input" type="number" step="0.1" value={selected.end} oninput={(event) => updateCue(selected.id, { end: Number(event.currentTarget.value) })} /></label></div>
            <div class="actions"><button class="btn" onclick={() => setCueStatus(selected.id, "待审")}>提交审校</button><button class="btn variant-filled-success" onclick={() => confirmReview(selected.id, true)}>审校通过</button><button class="btn variant-filled-error" onclick={() => confirmReview(selected.id, false, reviewNote || "请核对术语和断句")}>退回修改</button></div>
            <button class="btn variant-filled-secondary simultaneous" onclick={simultaneousConfirm}>模拟两名审校员同时确认（并发）</button>
            <label class="label"><span>审校备注</span><input class="input" bind:value={reviewNote} placeholder="退回时填写具体原因" /></label>
            {#if outcomes.length}
              <div class="outcomes">
                {#each outcomes as item}
                  <article class={`outcome ${item.outcome.ok ? "ok" : "conflict"}`}>
                    <b>{item.actor}</b>
                    {#if item.outcome.ok}<span class="chip variant-filled-success">已生效</span>{:else}<span class="chip variant-filled-error">未生效 · {item.outcome.reason}</span>{/if}
                    {#if item.outcome.blocking?.length}
                      <p>最新阻塞项：</p>
                      <ul>{#each item.outcome.blocking as reason}<li>{reason}</li>{/each}</ul>
                    {/if}
                  </article>
                {/each}
              </div>
            {/if}
          {:else}<p>请先选择一条字幕。</p>{/if}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>术语锁定</h2><small>锁定/解锁切换后，引用该术语的字幕立即失效</small></div>
          {#each $terms as term}
            <div class="term"><span><b>{term.source}</b> → {term.target}</span><button class="btn btn-sm" onclick={() => lockTerm(term.id)}>{term.status === "已锁定" ? "解锁" : "锁定"}</button></div>
          {/each}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>协作冲突</h2></div>
          {#each $conflicts as conflict}
            <article class="conflict">
              <b>{conflict.message}</b>
              {#if conflict.type === "版本冲突"}
                <p>基于 v{conflict.expectedVersion} 确认 → 当前已为 v{conflict.currentVersion}</p>
                {#if conflict.blocking?.length}
                  <p class="blocking-title">最新阻塞项：</p>
                  <ul class="blocking">{#each conflict.blocking as reason}<li>{reason}</li>{/each}</ul>
                {/if}
                <div class="actions"><button class="btn btn-sm" disabled={conflict.status === "已处理"} onclick={() => resolveConflict(conflict.id, "已处理")}>知道了</button><span class="chip">{conflict.status}</span></div>
              {:else}
                <p>协作版本：{formatTime(conflict.remoteStart ?? 0)}–{formatTime(conflict.remoteEnd ?? 0)}</p>
                <div class="actions"><button class="btn btn-sm" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用本地")}>保留本机</button><button class="btn btn-sm variant-filled-primary" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用协作版本")}>采用协作版本</button><span class="chip">{conflict.status}</span></div>
              {/if}
            </article>
          {/each}
        </section>
      </aside>
    </div>

    <div class="bottom-grid">
      <section class="panel">
        <div class="panel-head"><h2>新增字幕</h2></div>
        <form class="cue-form" method="POST" use:enhance>
          <label class="label"><span>原文</span><input class="input" name="source" bind:value={$form.source} /><small>{$errors.source?.[0]}</small></label>
          <label class="label"><span>译文</span><input class="input" name="translated" bind:value={$form.translated} /><small>{$errors.translated?.[0]}</small></label>
          <label class="label"><span>开始秒</span><input class="input" name="start" type="number" step="0.1" bind:value={$form.start} /></label>
          <label class="label"><span>持续秒</span><input class="input" name="duration" type="number" step="0.1" bind:value={$form.duration} /></label>
          <button class="btn variant-filled-primary" type="submit">新增到当前轨道</button>
        </form>
      </section>
      <section class="panel"><div class="panel-head"><h2>审校记录</h2></div><div class="events">{#each $reviewEvents as item}<article><b>{item.action}</b><p>{item.detail}</p><small>{item.actor} · {new Date(item.time).toLocaleTimeString("zh-CN")}</small></article>{/each}{#if !$reviewEvents.length}<p>暂无审校操作。</p>{/if}</div></section>
      <section class="panel"><div class="panel-head"><h2>版本快照</h2></div><div class="events">{#each $snapshots as item}<article><b>{item.name}</b><p>{item.cues.length} 条字幕 · {new Date(item.time).toLocaleString("zh-CN")}</p><button class="btn btn-sm" onclick={() => restoreSnapshot(item.id)}>恢复</button></article>{/each}{#if !$snapshots.length}<p>使用 ⌘S 或顶部按钮创建快照。</p>{/if}</div></section>
    </div>

    <section class="panel delivery">
      <div class="panel-head">
        <div><h2>交付检查</h2><small>输入指纹 <code>{$deliveryView.key}</code> · {#if $deliveryView.blockedCount}<b class="stale-num">{$deliveryView.blockedCount} 语种阻塞</b>{:else}无阻塞{/if} · 已生成 {$deliveryView.doneCount} 语种</small></div>
        <div class="actions"><button class="btn" onclick={() => recomputeAll()}>全部重算</button><button class="btn variant-filled-primary" onclick={() => generateAll()} disabled={$deliveryView.blockedCount > 0}>生成交付包</button></div>
      </div>
      <div class="delivery-langs">
        {#each $deliveryView.languages as lang}
          <article class="delivery-lang">
            <header><b>{lang.trackName}</b><span class="chip">{lang.total} 条字幕</span>{#if lang.staleCount}<span class="chip variant-filled-error">{lang.staleCount} 条失效</span>{:else}<span class="chip variant-filled-success">可交付</span>{/if}</header>
            {#if lang.staleCount}
              <ul class="blocking">
                {#each lang.blocking as item}
                  <li>{item.message}<button class="btn btn-sm" onclick={() => recomputeCue(item.cueId)}>重算</button></li>
                {/each}
              </ul>
            {/if}
            <div class="actions">
              {#if !lang.gen || lang.gen.status === "idle" || (lang.gen.status === "done" && !lang.current)}
                <button class="btn btn-sm variant-filled-primary" onclick={() => generateLanguage(lang.locale)} disabled={lang.staleCount > 0}>{lang.gen?.status === "done" && !lang.current ? "输入已变化，重新生成" : "生成"}</button>
              {:else if lang.gen.status === "generating"}<span class="chip">生成中…</span>
              {:else if lang.gen.status === "done" && lang.current}<span class="chip variant-filled-success">已生成（沿用缓存）</span>
              {:else if lang.gen.status === "blocked"}<span class="chip variant-filled-error">已阻塞</span>
              {:else if lang.gen.status === "error"}<span class="chip variant-filled-error">生成失败</span><button class="btn btn-sm" onclick={() => retryLanguage(lang.locale)}>重试（仅补本语种）</button>{/if}
            </div>
            {#if lang.gen?.status === "done" && lang.current}<pre class="payload">{lang.gen.payload}</pre>{/if}
            {#if lang.gen?.status === "error"}<p class="error">{lang.gen.error}</p>{/if}
          </article>
        {/each}
      </div>
    </section>
  </main>
</div>

<style>
  .stale-num { color: var(--color-error-500, #dc2626); font-weight: 700; }
  .cue.stale { border-color: var(--color-error-500, #dc2626); }
  .cue-meta { display: flex; gap: 0.25rem; margin-top: 0.25rem; }
  .chip.version { font-variant-numeric: tabular-nums; }
  .stale-box { background: color-mix(in srgb, var(--color-error-500, #dc2626) 12%, transparent); border: 1px solid var(--color-error-500, #dc2626); border-radius: 0.5rem; padding: 0.5rem 0.75rem; margin-bottom: 0.75rem; font-size: 0.85rem; }
  .stale-box ul { margin: 0.25rem 0; padding-left: 1.1rem; }
  .stale-box button { margin-top: 0.25rem; }
  .simultaneous { margin: 0.5rem 0; width: 100%; }
  .outcomes { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.5rem; }
  .outcome { border: 1px solid var(--color-surface-300, #d4d4d4); border-radius: 0.5rem; padding: 0.5rem 0.75rem; font-size: 0.85rem; }
  .outcome.ok { border-color: var(--color-success-500, #16a34a); }
  .outcome.conflict { border-color: var(--color-error-500, #dc2626); }
  .outcome p { margin: 0.25rem 0 0; font-weight: 600; }
  .outcome ul { margin: 0.25rem 0 0; padding-left: 1.1rem; }
  .conflict .blocking-title { font-weight: 600; margin: 0.25rem 0 0; }
  .conflict ul.blocking { margin: 0.25rem 0; padding-left: 1.1rem; font-size: 0.85rem; }
  .delivery { margin-top: 1rem; }
  .delivery-langs { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 0.75rem; }
  .delivery-lang { border: 1px solid var(--color-surface-300, #d4d4d4); border-radius: 0.75rem; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .delivery-lang header { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .delivery-lang .blocking { margin: 0; padding-left: 1.1rem; font-size: 0.85rem; }
  .delivery-lang .blocking li { margin-bottom: 0.25rem; }
  .delivery-lang .blocking button { margin-left: 0.5rem; }
  .delivery-lang .actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .payload { background: var(--color-surface-100, #f5f5f5); border-radius: 0.5rem; padding: 0.5rem; font-size: 0.75rem; white-space: pre-wrap; margin: 0; }
  .error { color: var(--color-error-500, #dc2626); font-size: 0.85rem; margin: 0; }
  code { font-family: ui-monospace, monospace; }
</style>
