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
    SOURCE_TRACK_ID,
    activeCues,
    activeTrackId,
    blockerByCue,
    confirmCue,
    conflicts,
    createCue,
    createSnapshot,
    cues,
    cueDisplayStatus,
    deliveryChecks,
    deliveryRuns,
    failOnNextAttempt,
    lockTerm,
    mergeNext,
    nudgeCue,
    recomputeCue,
    recomputeTrack,
    requestDelivery,
    resolveConflict,
    restoreSnapshot,
    retryDelivery,
    reviewEvents,
    reviewer,
    reviewers,
    selectedCueId,
    selectedVerdictRows,
    setCueStatus,
    snapshots,
    splitCue,
    terms,
    tracks,
    updateCue,
    verdicts
  } from "$lib/stores/subtitles";
  import type { Cue, DeliveryRun } from "$lib/stores/subtitles";

  const cueSchema = z.object({ source: z.string().min(2), translated: z.string(), start: z.coerce.number().min(0), duration: z.coerce.number().min(0.5).max(30) });
  const defaults = { source: "", translated: "", start: 0, duration: 2.5 };
  const { form, errors, enhance } = superForm(defaults, {
    validators: zod4(cueSchema),
    onSubmit: async ({ formData }) => {
      const start = Number(formData.get("start") ?? 0);
      const duration = Number(formData.get("duration") ?? 2.5);
      const item = createCue({
        trackId: $activeTrackId,
        start,
        end: start + duration,
        source: String(formData.get("source") ?? ""),
        translated: String(formData.get("translated") ?? "")
      });
      cues.update((items) => [...items, item]);
      selectedCueId.set(item.id);
    }
  });
  const queryOptions = derived(activeTrackId, ($trackId) => ({ queryKey: ["cues", $trackId] as const, queryFn: async (): Promise<Cue[]> => get(activeCues) }));
  const query = createQuery(queryOptions);
  const activeTrack = $derived($tracks.find((track) => track.id === $activeTrackId));
  const selected = $derived($cues.find((cue) => cue.id === $selectedCueId));
  const isSourceTrack = $derived($activeTrackId === SOURCE_TRACK_ID);
  let reviewNote = $state("");

  type Notice = { tone: "ok" | "conflict" | "blocked"; text: string };
  let confirmNotice = $state<Notice | null>(null);
  let generating = $state(false);
  let lastRequestId = $state<string | null>(null);
  let failTrack = $state("en");
  let duplicateOutcome = $state<string | null>(null);

  const checks = $derived($deliveryChecks);
  const trackById = $derived(new Map($tracks.map((track) => [track.id, track])));
  const selectedBlocker = $derived((selected && $blockerByCue.get(selected.id)) ?? null);
  const selectedTarget = $derived(selected && selected.trackId !== SOURCE_TRACK_ID ? selected as Extract<Cue, { translated: string }> : null);

  function formatTime(value: number) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    const tenths = Math.floor((value % 1) * 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
  }

  function doApprove(approved: boolean) {
    if (!selected) return;
    const outcome = confirmCue(selected.id, approved, reviewNote || (approved ? "" : "请核对术语和断句"));
    if (outcome.result.ok) {
      confirmNotice = {
        tone: "ok",
        text: outcome.result.duplicated
          ? `同一审校员重复确认，已沿用首次结论（${outcome.result.verdict.time.slice(11, 19)}）。`
          : `${outcome.result.verdict.reviewer} 的结论已对版本 rev-${outcome.result.verdict.cueRev} 生效。`
      };
    } else {
      const r = outcome.result;
      if (r.reason === "版本冲突") {
        confirmNotice = {
          tone: "conflict",
          text: `版本冲突：当前为 rev-${r.currentRev}，${r.existingVerdict?.reviewer} 已先确认（${r.existingVerdict?.approved ? "通过" : "退回"}）。后到结论未写入。最新阻塞项：${r.blockers.length ? r.blockers.map((b) => b.kind).join("、") : "无"}`
        };
      } else if (r.reason === "存在阻塞项") {
        confirmNotice = { tone: "blocked", text: `确认被拒绝：字幕已失效，必须先重算。最新阻塞项：${r.blockers.map((b) => b.message).join("；")}` };
      } else {
        confirmNotice = { tone: "blocked", text: "字幕不存在，无法确认。" };
      }
    }
  }

  async function generate(duplicate = false) {
    generating = true;
    try {
      let run: DeliveryRun;
      if (duplicate && lastRequestId) {
        const before = get(deliveryRuns).find((item) => item.requestId === lastRequestId);
        run = await requestDelivery(lastRequestId);
        duplicateOutcome = before ? `请求 ${lastRequestId.slice(0, 8)} 已存在，直接沿用首次结果（${before.status}），未新建交付任务。` : null;
      } else {
        run = await requestDelivery();
        lastRequestId = run.requestId;
        duplicateOutcome = null;
      }
      if (run.status === "已阻塞") confirmNotice = { tone: "blocked", text: `交付门未通过（${run.requestId.slice(0, 8)}）：存在 ${run.blockers.length} 个失效 / 待审项，未重算前不生成交付包。` };
    } finally {
      generating = false;
    }
  }

  function armFailure() {
    failOnNextAttempt.update((items) => Array.from(new Set([...items, failTrack])));
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
    <nav><button class="active">时间轴编辑</button><button>审校队列</button><button>术语库</button><button>版本快照</button><button>交付检查</button></nav>
    <div class="keyboard"><b>键盘操作</b><span>J / K 选择字幕</span><span>S 拆分 · M 合并</span><span>⌘S 保存快照</span></div>
  </aside>
  <main>
    <header><div><small>纪录片《潮汐线》 · 第 3 集</small><h1>{m.title()}</h1><p>原片段、术语与审校结论接入可重算交付门：失效字幕未重算前不生成交付包。</p></div><div class="header-actions"><select value={$activeTrackId} onchange={(event) => { activeTrackId.set(event.currentTarget.value); confirmNotice = null; }}>{#each $tracks as track}<option value={track.id}>{track.name}</option>{/each}</select><select value={$reviewer} onchange={(event) => { reviewer.set(event.currentTarget.value); confirmNotice = null; }}>{#each reviewers as name}<option value={name}>{name}</option>{/each}</select><button onclick={() => setLocale("en")}>EN</button><button onclick={() => setLocale("zh")}>中文</button></div></header>

    <section class="metrics"><article><span>当前轨道</span><b>{activeTrack?.name}</b></article><article><span>字幕条数</span><b>{$activeCues.length}</b></article><article><span>本轨失效</span><b class:danger={checks.tracks.find((t) => t.trackId === $activeTrackId)?.stale.length}>{checks.tracks.find((t) => t.trackId === $activeTrackId)?.stale.length ?? 0}</b></article><article><span>已锁定术语</span><b>{$terms.filter((term) => term.status === "已锁定").length}</b></article></section>

    <div class="editor-grid">
      <section class="panel timeline">
        <div class="panel-head"><div><h2>时间轴</h2><small>原片段拆分 / 合并 / 时间码或术语锁定变化，相关语言立即标红失效</small></div><button class="btn variant-filled-primary" onclick={() => createSnapshot()}>保存快照</button></div>
        {#if $query.isPending}<p>正在加载字幕轨道…</p>{:else}
          <div class="cue-list">
            {#each $activeCues as cue (cue.id)}
              {@const status = cueDisplayStatus(cue)}
              {@const blocker = $blockerByCue.get(cue.id)}
              {@const targetCue = cue.trackId === SOURCE_TRACK_ID ? null : cue as Extract<Cue, { translated: string }>}
              <div role="button" tabindex="0" class:selected={cue.id === $selectedCueId} class={`cue ${status}`} onclick={() => { selectedCueId.set(cue.id); confirmNotice = null; }} onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") selectedCueId.set(cue.id); }}>
                <time>{formatTime(cue.start)}<small>{formatTime(cue.end)}</small></time>
                <div><b>{cue.source}</b><p>{targetCue ? targetCue.translated || "尚未填写译文" : "原语言片段 · rev-" + cue.rev}</p>{#if blocker}<small class="blocker-text">⚠ {blocker.kind}</small>{/if}</div>
                <span class={`chip ${status}`}>{status}</span>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, -0.2); }}>−0.2s</button>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, 0.2); }}>+0.2s</button>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <aside class="right-stack">
        <section class="panel">
          <div class="panel-head"><h2>字幕编辑</h2>{#if selected}<span class={`chip ${cueDisplayStatus(selected)}`}>{cueDisplayStatus(selected)}</span>{/if}</div>
          {#if selected}
            {#if selectedBlocker}
              <div class="notice blocked">
                <b>交付阻塞 · {selectedBlocker.kind}</b>
                <p>{selectedBlocker.message}</p>
                <div class="actions"><button class="btn btn-sm variant-filled-primary" onclick={() => recomputeCue(selected.id)}>立即重算此条</button><button class="btn btn-sm" onclick={() => recomputeTrack()}>重算整条轨道</button></div>
              </div>
            {/if}
            <label class="label"><span>{isSourceTrack ? "原文字幕（修改会使所有语言失效）" : "原文字幕（只读对照）"}</span><input class="input" value={selected.source} disabled={!isSourceTrack} oninput={(event) => updateCue(selected.id, { source: event.currentTarget.value })} /></label>
            {#if !isSourceTrack && selectedTarget}
              <label class="label"><span>译文（版本 rev-{selectedTarget.rev}）</span><textarea class="textarea" value={selectedTarget.translated} oninput={(event) => updateCue(selected.id, { translated: event.currentTarget.value })}></textarea></label>
            {/if}
            <div class="time-fields"><label class="label"><span>开始秒</span><input class="input" type="number" step="0.1" value={selected.start} oninput={(event) => updateCue(selected.id, { start: Number(event.currentTarget.value) } as never)} /></label><label class="label"><span>结束秒</span><input class="input" type="number" step="0.1" value={selected.end} oninput={(event) => updateCue(selected.id, { end: Number(event.currentTarget.value) } as never)} /></label></div>
            {#if !isSourceTrack}
              <div class="actions"><button class="btn" onclick={() => setCueStatus(selected.id, "待审")}>提交审校</button><button class="btn variant-filled-success" onclick={() => doApprove(true)}>审校通过</button><button class="btn variant-filled-error" onclick={() => doApprove(false)}>退回修改</button></div>
              <label class="label"><span>审校备注（当前身份：{$reviewer}）</span><input class="input" bind:value={reviewNote} placeholder="退回时填写具体原因" /></label>
              {#if confirmNotice}
                <div class={`notice ${confirmNotice.tone}`}><p>{confirmNotice.text}</p></div>
              {/if}
              <div class="verdicts">
                <b>审校结论</b>
                {#each $selectedVerdictRows as item (item.verdict.id)}
                  <div class={`verdict ${item.active ? "active" : "expired"}`}><span>{item.verdict.reviewer} · {item.verdict.approved ? "通过" : "退回"} · rev-{item.verdict.cueRev}</span><small>{item.active ? "当前版本有效" : "已过期（字幕已重算 / 失效）"} · {new Date(item.verdict.time).toLocaleTimeString("zh-CN")}</small>{#if item.verdict.note}<p>{item.verdict.note}</p>{/if}</div>
                {:else}<p class="muted">暂无审校结论。</p>{/each}
              </div>
            {/if}
          {:else}<p>请先选择一条字幕。</p>{/if}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>术语锁定</h2><small>锁定变化会使全部语言失效</small></div>
          {#each $terms as term}
            <div class="term"><span><b>{term.source}</b> → {term.target}</span><button class="btn btn-sm" disabled={term.status === "已锁定"} onclick={() => lockTerm(term.id)}>{term.status}</button></div>
          {/each}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>协作冲突</h2></div>
          {#each $conflicts as conflict}
            <article class="conflict"><b>{conflict.message}</b><p>协作版本：{formatTime(conflict.remoteStart)}–{formatTime(conflict.remoteEnd)}</p><div class="actions"><button class="btn btn-sm" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用本地")}>保留本机</button><button class="btn btn-sm variant-filled-primary" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用协作版本")}>采用协作版本</button><span class="chip">{conflict.status}</span></div></article>
          {/each}
        </section>
      </aside>
    </div>

    <section class="panel delivery">
      <div class="panel-head">
        <div><h2>交付检查</h2><small>任一语言存在失效 / 未译 / 未通过审校时，交付包不会生成</small></div>
        <div class="actions">
          <select bind:value={failTrack}>{#each $tracks.filter((t) => t.id !== SOURCE_TRACK_ID) as track}<option value={track.id}>{track.name}（模拟失败）</option>{/each}</select>
          <button class="btn btn-sm" onclick={armFailure}>下次生成此语言失败</button>
          <button class="btn" disabled={!lastRequestId} onclick={() => generate(true)}>重复上一请求（同 requestId）</button>
          <button class="btn variant-filled-primary" disabled={generating || !checks.ready} onclick={() => generate(false)}>{generating ? "生成中…" : checks.ready ? "生成交付包" : "存在阻塞，禁止生成"}</button>
        </div>
      </div>

      <div class="gate-grid">
        {#each checks.tracks as check}
          <article class={`gate ${check.ready ? "ready" : "blocked"}`}>
            <header><b>{trackById.get(check.trackId)?.name ?? check.trackId}</b><span class={`chip ${check.ready ? "已通过" : "退回"}`}>{check.ready ? "可交付" : "阻塞"}</span></header>
            <p>{check.totalCues} 条 · 失效 {check.stale.length} · 未译 {check.untranslated} · 待审校 {check.unapproved}</p>
            {#if check.stale.length}
              <button class="btn btn-sm variant-filled-primary" onclick={() => recomputeTrack(check.trackId)}>重算 {check.stale.length} 条失效字幕</button>
            {/if}
            <ul>{#each check.stale as blocker}<li>{blocker.kind}：{blocker.message}</li>{/each}</ul>
          </article>
        {/each}
      </div>
      {#if duplicateOutcome}<div class="notice ok"><p>{duplicateOutcome}</p></div>{/if}

      <div class="runs">
        <h3>交付请求</h3>
        {#each $deliveryRuns as run (run.requestId)}
          <article class="run">
            <div class="run-head">
              <b>{run.requestId.slice(0, 8)}</b>
              <span class={`chip ${run.status === "完成" ? "已通过" : run.status === "已阻塞" ? "退回" : "待审"}`}>{run.status}</span>
              <small>{new Date(run.createdAt).toLocaleTimeString("zh-CN")}</small>
              {#if run.status === "部分完成"}<button class="btn btn-sm variant-filled-primary" onclick={() => retryDelivery(run.requestId)}>重试，只补失败语言</button>{/if}
            </div>
            {#if run.status === "已阻塞"}
              <p class="muted">未重算前不生成交付包，阻塞项 {run.blockers.length} 个：{run.blockers.map((b) => `${trackById.get(b.trackId)?.name ?? b.trackId}·${b.kind}`).join("；")}</p>
            {:else}
              <div class="run-langs">
                {#each Object.values(run.languages) as language}
                  <div class={`lang ${language.status}`}>
                    <b>{trackById.get(language.trackId)?.name ?? language.trackId}</b>
                    <span>{language.status}{language.status === "完成" ? ` · 第 ${language.attempts} 次尝试成功` : language.attempts ? ` · 已尝试 ${language.attempts} 次` : ""}</span>
                    {#if language.artifact}<small>{language.artifact.cueCount} 条 · 校验 {language.artifact.checksum}</small>{/if}
                    {#if language.error}<small class="blocker-text">{language.error}</small>{/if}
                  </div>
                {/each}
              </div>
            {/if}
          </article>
        {:else}<p class="muted">尚无交付请求。修改原片段或锁定术语后可在此看到阻塞；全部重算并审校通过后即可生成。</p>{/each}
      </div>
    </section>

    <div class="bottom-grid">
      <section class="panel">
        <div class="panel-head"><h2>新增{isSourceTrack ? "原片段" : "字幕"}</h2></div>
        <form class="cue-form" method="POST" use:enhance>
          <label class="label"><span>原文</span><input class="input" name="source" bind:value={$form.source} /><small>{$errors.source?.[0]}</small></label>
          {#if !isSourceTrack}<label class="label"><span>译文</span><input class="input" name="translated" bind:value={$form.translated} /></label>{/if}
          <label class="label"><span>开始秒</span><input class="input" name="start" type="number" step="0.1" bind:value={$form.start} /></label>
          <label class="label"><span>持续秒</span><input class="input" name="duration" type="number" step="0.1" bind:value={$form.duration} /></label>
          <button class="btn variant-filled-primary" type="submit">新增到当前轨道</button>
        </form>
      </section>
      <section class="panel"><div class="panel-head"><h2>审校记录</h2></div><div class="events">{#each $reviewEvents as item}<article><b>{item.action}</b><p>{item.detail}</p><small>{item.actor} · {new Date(item.time).toLocaleTimeString("zh-CN")}</small></article>{/each}{#if !$reviewEvents.length}<p>暂无审校操作。</p>{/if}</div></section>
      <section class="panel"><div class="panel-head"><h2>版本快照</h2></div><div class="events">{#each $snapshots as item}<article><b>{item.name}</b><p>{item.cues.length} 条字幕 · {new Date(item.time).toLocaleString("zh-CN")}</p><button class="btn btn-sm" onclick={() => restoreSnapshot(item.id)}>恢复</button></article>{/each}{#if !$snapshots.length}<p>使用 ⌘S 或顶部按钮创建快照。</p>{/if}</div></section>
    </div>
  </main>
</div>
