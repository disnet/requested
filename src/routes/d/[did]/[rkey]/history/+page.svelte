<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import {
		getDocument,
		listVersionChain,
		type LoadedDocument,
		type LoadedVersion
	} from '$lib/atproto/documents';

	let loaded = $state<LoadedDocument | null>(null);
	let versions = $state<LoadedVersion[]>([]);
	let error = $state<string | null>(null);

	$effect(() => {
		const { did, rkey } = page.params as { did: string; rkey: string };
		loaded = null;
		versions = [];
		error = null;
		void (async () => {
			try {
				const [doc, chain] = await Promise.all([
					getDocument(did, rkey),
					listVersionChain(did, rkey)
				]);
				loaded = doc;
				versions = chain;
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}
		})();
	});

	const did = $derived(page.params.did as string);
	const rkey = $derived(page.params.rkey as string);
	const docPath = $derived(resolve('/d/[did]/[rkey]', { did, rkey }));
	const versionPath = (vrkey: string) => resolve('/d/[did]/[rkey]/v/[vrkey]', { did, rkey, vrkey });
	const diffPath = (fromRkey: string, toRkey: string) =>
		`${resolve('/d/[did]/[rkey]/diff', { did, rkey })}?from=${fromRkey}&to=${toRkey}` as ResolvedPathname;

	function formatDate(iso: string): string {
		const d = new Date(iso);
		const y = d.getUTCFullYear();
		const m = String(d.getUTCMonth() + 1).padStart(2, '0');
		const day = String(d.getUTCDate()).padStart(2, '0');
		const hh = String(d.getUTCHours()).padStart(2, '0');
		const mm = String(d.getUTCMinutes()).padStart(2, '0');
		return `${y}-${m}-${day} ${hh}:${mm} UTC`;
	}
</script>

<svelte:head>
	{#if loaded?.value.title}
		<title>History · {loaded.value.title} — Requested</title>
	{/if}
</svelte:head>

{#if error}
	<div class="column">
		<p class="error">{error}</p>
	</div>
{:else if loaded === null}
	<div class="column">
		<p class="muted">Loading…</p>
	</div>
{:else}
	<div class="column">
		<nav class="crumb">
			<a href={docPath} class="action">[ ← {loaded.value.title} ]</a>
		</nav>

		<header class="page-header">
			<h1>Version history</h1>
			<p class="muted">
				{versions.length}
				{versions.length === 1 ? 'version' : 'versions'} · newest first
			</p>
		</header>

		{#if versions.length === 0}
			<p class="muted">No versions found.</p>
		{:else}
			<ol class="versions">
				{#each versions as v, i (v.uri)}
					{@const isCurrent = i === 0}
					{@const prev = versions[i + 1]}
					{@const n = versions.length - i}
					<li class="version" class:current={isCurrent}>
						<div class="version-row">
							<span class="version-num">v{n}</span>
							{#if isCurrent}
								<span class="status status-current">Current</span>
							{:else}
								<span class="status status-superseded">Superseded</span>
							{/if}
							<time class="version-date" datetime={v.value.createdAt}>
								{formatDate(v.value.createdAt)}
							</time>
							<span class="version-rkey muted" title="Version rkey">{v.rkey}</span>
							<nav class="version-actions">
								{#if isCurrent}
									<a class="action" href={docPath}>[ view ]</a>
								{:else}
									<a class="action" href={versionPath(v.rkey)}>[ view ]</a>
								{/if}
								{#if !isCurrent}
									<a class="action" href={diffPath(v.rkey, versions[0].rkey)}>
										[ diff&nbsp;vs&nbsp;current ]
									</a>
								{/if}
								{#if prev}
									<a class="action" href={diffPath(prev.rkey, v.rkey)}>
										[ diff&nbsp;vs&nbsp;previous ]
									</a>
								{/if}
							</nav>
						</div>
					</li>
				{/each}
			</ol>
		{/if}
	</div>
{/if}

<style>
	.crumb {
		margin-bottom: var(--space-4);
		font-size: var(--text-sm);
	}

	.page-header {
		margin-bottom: var(--space-6);
		padding-bottom: var(--space-4);
		border-bottom: var(--border-thin) solid var(--rule);
	}
	.page-header h1 {
		font-size: var(--text-2xl);
		font-weight: 700;
		letter-spacing: var(--track-tight);
		margin: 0 0 var(--space-1);
	}
	.muted {
		font-size: var(--text-sm);
	}

	.versions {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.version + .version {
		border-top: var(--border-thin) solid var(--rule);
	}
	.version {
		padding: var(--space-4) 0;
	}
	.version-row {
		display: grid;
		grid-template-columns: auto auto 1fr auto;
		grid-template-areas:
			'num status date rkey'
			'actions actions actions actions';
		row-gap: var(--space-2);
		column-gap: var(--space-3);
		align-items: baseline;
	}
	.version-num {
		grid-area: num;
		font-size: var(--text-md);
		font-weight: 700;
		letter-spacing: var(--track-tight);
		color: var(--ink);
		min-width: 4ch;
	}
	.version.current .version-num {
		color: var(--accent);
	}
	.status {
		grid-area: status;
	}
	.version-date {
		grid-area: date;
		font-size: var(--text-sm);
		color: var(--ink-2);
		font-variant-numeric: tabular-nums;
	}
	.version-rkey {
		grid-area: rkey;
		font-size: var(--text-xs);
		letter-spacing: var(--track-tight);
		justify-self: end;
		word-break: break-all;
	}
	.version-actions {
		grid-area: actions;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
		font-size: var(--text-sm);
	}

	@media (max-width: 640px) {
		.version-row {
			grid-template-columns: auto 1fr;
			grid-template-areas:
				'num status'
				'date date'
				'rkey rkey'
				'actions actions';
		}
		.version-rkey {
			justify-self: start;
		}
	}
</style>
