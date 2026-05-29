<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { diffLines, type Change } from 'diff';
	import { versionMarkdown } from '$lib/atproto/lexicons';

	const { data } = $props();

	const loaded = $derived(data.doc);
	const from = $derived(data.from);
	const to = $derived(data.to);
	const error = $derived(data.loadError);

	type DiffLine = { kind: 'add' | 'del' | 'context'; text: string; n: number };

	const chunks: DiffLine[] = $derived.by(() => {
		if (!from || !to) return [];
		const raw: Change[] = diffLines(versionMarkdown(from.value), versionMarkdown(to.value));
		const out: DiffLine[] = [];
		let n = 0;
		for (const c of raw) {
			const lines = c.value.split('\n');
			if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
			const kind: DiffLine['kind'] = c.added ? 'add' : c.removed ? 'del' : 'context';
			for (const line of lines) {
				out.push({ kind, text: line, n: ++n });
			}
		}
		return out;
	});

	const summary = $derived.by(() => {
		let added = 0;
		let removed = 0;
		for (const c of chunks) {
			if (c.kind === 'add') added++;
			else if (c.kind === 'del') removed++;
		}
		return { added, removed };
	});

	const docPath = $derived(
		resolve('/d/[did]/[rkey]', {
			did: page.params.did as string,
			rkey: page.params.rkey as string
		})
	);
	const historyPath = $derived(
		resolve('/d/[did]/[rkey]/history', {
			did: page.params.did as string,
			rkey: page.params.rkey as string
		})
	);

	function formatDate(iso: string): string {
		const d = new Date(iso);
		const y = d.getUTCFullYear();
		const m = String(d.getUTCMonth() + 1).padStart(2, '0');
		const day = String(d.getUTCDate()).padStart(2, '0');
		const hh = String(d.getUTCHours()).padStart(2, '0');
		const mm = String(d.getUTCMinutes()).padStart(2, '0');
		return `${y}-${m}-${day} ${hh}:${mm}`;
	}
</script>

<svelte:head>
	{#if loaded?.value.title}
		<title>Diff · {loaded.value.title} — Requested</title>
	{/if}
</svelte:head>

{#if error && !to}
	<div class="column">
		<p class="error">{error}</p>
	</div>
{:else if loaded === null || to === null}
	<div class="column">
		<p class="muted">Loading…</p>
	</div>
{:else}
	<div class="column-wide">
		<nav class="crumb">
			<a href={docPath} class="action">[ ← {loaded.value.title} ]</a>
		</nav>

		<header class="page-header">
			<h1>Diff</h1>
			<div class="diff-meta">
				{#if from}
					<div class="diff-meta-block">
						<span class="meta-key">From</span>
						<span class="diff-marker diff-marker-del">−</span>
						<time datetime={from.value.createdAt}>
							{formatDate(from.value.createdAt)}
						</time>
						<span class="mono-tight muted">{from.rkey}</span>
					</div>
					<div class="diff-arrow" aria-hidden="true">→</div>
				{/if}
				<div class="diff-meta-block">
					<span class="meta-key">To</span>
					<span class="diff-marker diff-marker-add">+</span>
					<time datetime={to.value.createdAt}>
						{formatDate(to.value.createdAt)}
					</time>
					<span class="mono-tight muted">{to.rkey}</span>
				</div>
				{#if from}
					<div class="diff-counts">
						<span class="add-count">+{summary.added}</span>
						<span class="del-count">−{summary.removed}</span>
					</div>
				{/if}
			</div>
			<nav class="page-actions">
				<a class="action" href={historyPath}>[ all versions ]</a>
			</nav>
		</header>

		{#if error}
			<p class="muted">{error}</p>
		{:else}
			<div class="diff" role="region" aria-label="Unified diff">
				{#each chunks as line (line.n)}
					<div class="line line-{line.kind}">
						<span class="marker" aria-hidden="true">
							{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
						</span>
						<span class="text">{line.text || ' '}</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	.crumb {
		margin-bottom: var(--space-4);
		font-size: var(--text-sm);
	}

	.page-header {
		margin-bottom: var(--space-5);
		padding-bottom: var(--space-4);
		border-bottom: var(--border-thin) solid var(--rule);
	}
	.page-header h1 {
		font-size: var(--text-2xl);
		font-weight: 700;
		letter-spacing: var(--track-tight);
		margin: 0 0 var(--space-3);
	}
	.diff-meta {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		flex-wrap: wrap;
		font-size: var(--text-sm);
	}
	.diff-meta-block {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.meta-key {
		font-size: var(--text-2xs);
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--ink-3);
	}
	.diff-marker {
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	.diff-marker-add {
		color: var(--addition);
	}
	.diff-marker-del {
		color: var(--accent);
	}
	.diff-arrow {
		color: var(--ink-3);
	}
	.mono-tight {
		font-size: var(--text-xs);
		letter-spacing: var(--track-tight);
		word-break: break-all;
	}
	.diff-counts {
		display: inline-flex;
		gap: var(--space-3);
		font-size: var(--text-sm);
		font-variant-numeric: tabular-nums;
		margin-left: auto;
	}
	.add-count {
		color: var(--addition);
	}
	.del-count {
		color: var(--accent);
	}
	.page-actions {
		margin-top: var(--space-3);
		display: flex;
		gap: var(--space-3);
		font-size: var(--text-sm);
	}

	.diff {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		line-height: 1.55;
		background: var(--surface-raised);
		border: var(--border-thin) solid var(--rule);
		padding: var(--space-3) 0;
		overflow-x: auto;
	}
	.line {
		display: flex;
		gap: var(--space-2);
		padding: 0 var(--space-4);
	}
	.line .marker {
		flex: 0 0 1ch;
		text-align: center;
		user-select: none;
		font-weight: 700;
		color: var(--ink-4);
	}
	.line .text {
		white-space: pre;
		flex: 1;
		font-variant-ligatures: none;
	}
	.line-add {
		background: var(--addition-fade);
		color: var(--ink);
	}
	.line-add .marker {
		color: var(--addition);
	}
	.line-del {
		background: var(--accent-fade);
		color: var(--ink);
	}
	.line-del .marker {
		color: var(--accent);
	}
	.line-context {
		color: var(--ink-2);
	}
</style>
