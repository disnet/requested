<script lang="ts">
	import { page } from '$app/state';
	import { diffLines, type Change } from 'diff';
	import {
		getDocument,
		getVersion,
		parseAtUri,
		resolveHandleToDid,
		type LoadedDocument,
		type LoadedVersion
	} from '$lib/atproto/documents';

	let loaded = $state<LoadedDocument | null>(null);
	let from = $state<LoadedVersion | null>(null);
	let to = $state<LoadedVersion | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		const { handle, rkey } = page.params as { handle: string; rkey: string };
		const fromRkey = page.url.searchParams.get('from');
		const toRkey = page.url.searchParams.get('to');
		loaded = null;
		from = null;
		to = null;
		error = null;
		void (async () => {
			try {
				const did = await resolveHandleToDid(handle);
				const doc = await getDocument(did, rkey);
				loaded = doc;
				if (!doc.version) {
					error = 'This document has no versions.';
					return;
				}

				// "to" defaults to the document's current version.
				const toV = toRkey
					? await getVersion(did, toRkey)
					: { ...doc.version, rkey: parseAtUri(doc.version.uri).rkey };

				// "from" defaults to the version chained directly before "to".
				let fromV: LoadedVersion | null = null;
				if (fromRkey) {
					fromV = await getVersion(did, fromRkey);
				} else if (toV.value.previousVersion) {
					const prevRkey = parseAtUri(toV.value.previousVersion.uri).rkey;
					fromV = await getVersion(did, prevRkey);
				}

				if (!fromV) {
					error = 'No earlier version to diff against — this is the first version.';
					to = toV;
					return;
				}
				from = fromV;
				to = toV;
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}
		})();
	});

	type DiffLine = { kind: 'add' | 'del' | 'context'; text: string };

	const chunks: DiffLine[] = $derived.by(() => {
		if (!from || !to) return [];
		const raw: Change[] = diffLines(from.value.body, to.value.body);
		const out: DiffLine[] = [];
		for (const c of raw) {
			// Each Change.value can contain multiple lines; split keeping trailing
			// newlines so an empty final entry doesn't produce a phantom line.
			const lines = c.value.split('\n');
			if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
			const kind: DiffLine['kind'] = c.added ? 'add' : c.removed ? 'del' : 'context';
			for (const line of lines) {
				out.push({ kind, text: line });
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

	const docPath = $derived(`/d/${page.params.handle}/${page.params.rkey}`);
</script>

{#if error && !to}
	<p class="error">{error}</p>
{:else if loaded === null || to === null}
	<p class="muted">Loading…</p>
{:else}
	<header class="page-header">
		<p class="crumb"><a href={docPath}>← {loaded.value.title}</a></p>
		<h1>Diff</h1>
		<div class="meta">
			{#if from}
				<span>
					<span class="del-swatch"></span>
					<time datetime={from.value.createdAt}>
						{new Date(from.value.createdAt).toLocaleString()}
					</time>
				</span>
				<span class="arrow">→</span>
			{/if}
			<span>
				<span class="add-swatch"></span>
				<time datetime={to.value.createdAt}>
					{new Date(to.value.createdAt).toLocaleString()}
				</time>
			</span>
			{#if from}
				<span class="sep">·</span>
				<span class="counts">
					<span class="add-count">+{summary.added}</span>
					<span class="del-count">−{summary.removed}</span>
				</span>
			{/if}
			<span class="sep">·</span>
			<a href={`${docPath}/history`}>All versions</a>
		</div>
	</header>

	{#if error}
		<p class="muted">{error}</p>
	{:else}
		<div class="diff">
			{#each chunks as line, i (i)}
				<div class="line {line.kind}">
					<span class="marker">
						{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
					</span><span class="text">{line.text || ' '}</span>
				</div>
			{/each}
		</div>
	{/if}
{/if}

<style>
	.page-header {
		margin-bottom: 1.5rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid #e5e5e5;
	}
	.crumb {
		margin: 0 0 0.5rem;
		font-size: 0.9rem;
	}
	.crumb a {
		color: #555;
		text-decoration: none;
	}
	.crumb a:hover {
		color: #000;
	}
	.page-header h1 {
		margin: 0 0 0.5rem;
		font-size: 1.75rem;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
		font-size: 0.9rem;
		color: #555;
	}
	.meta time {
		font-variant-numeric: tabular-nums;
	}
	.meta a {
		color: #226;
		text-decoration: none;
	}
	.meta a:hover {
		text-decoration: underline;
	}
	.sep {
		color: #ccc;
	}
	.arrow {
		color: #999;
	}
	.add-swatch,
	.del-swatch {
		display: inline-block;
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 2px;
		vertical-align: middle;
		margin-right: 0.25rem;
	}
	.add-swatch {
		background: #d4edda;
		border: 1px solid #b6d4b6;
	}
	.del-swatch {
		background: #fbd4d4;
		border: 1px solid #e4a8a8;
	}
	.counts {
		display: inline-flex;
		gap: 0.4rem;
		font-variant-numeric: tabular-nums;
	}
	.add-count {
		color: #2d662d;
	}
	.del-count {
		color: #a33;
	}
	.diff {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.85rem;
		line-height: 1.5;
		background: #fafafa;
		border: 1px solid #e5e5e5;
		border-radius: 6px;
		padding: 0.5rem 0;
		overflow-x: auto;
		margin: 0;
	}
	.line {
		display: flex;
		gap: 0.5rem;
		padding: 0 1rem;
	}
	.line .marker {
		flex: 0 0 1ch;
		text-align: center;
		opacity: 0.6;
		user-select: none;
	}
	.line .text {
		white-space: pre;
		flex: 1;
	}
	.line.add {
		background: #e6f4ea;
		color: #1e4620;
	}
	.line.del {
		background: #fbe9e9;
		color: #6b1d1d;
	}
	.line.context {
		color: #444;
	}
	.error {
		color: #b00;
	}
	.muted {
		color: #888;
	}
</style>
