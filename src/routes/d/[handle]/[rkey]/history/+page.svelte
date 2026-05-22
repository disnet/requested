<script lang="ts">
	import { page } from '$app/state';
	import {
		getDocument,
		listVersionChain,
		resolveHandleToDid,
		type LoadedDocument,
		type LoadedVersion
	} from '$lib/atproto/documents';

	let loaded = $state<LoadedDocument | null>(null);
	let versions = $state<LoadedVersion[]>([]);
	let error = $state<string | null>(null);

	$effect(() => {
		const { handle, rkey } = page.params as { handle: string; rkey: string };
		loaded = null;
		versions = [];
		error = null;
		void (async () => {
			try {
				const did = await resolveHandleToDid(handle);
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

	const docPath = $derived(`/d/${page.params.handle}/${page.params.rkey}`);
</script>

{#if error}
	<p class="error">{error}</p>
{:else if loaded === null}
	<p class="muted">Loading…</p>
{:else}
	<header class="page-header">
		<p class="crumb"><a href={docPath}>← {loaded.value.title}</a></p>
		<h1>Version history</h1>
		<p class="muted">{versions.length} {versions.length === 1 ? 'version' : 'versions'}</p>
	</header>

	{#if versions.length === 0}
		<p class="muted">No versions found.</p>
	{:else}
		<ol class="versions">
			{#each versions as v, i (v.uri)}
				{@const isCurrent = i === 0}
				{@const prev = versions[i + 1]}
				<li class="version" class:current={isCurrent}>
					<div class="row">
						<div class="when">
							<time datetime={v.value.createdAt}>
								{new Date(v.value.createdAt).toLocaleString()}
							</time>
							{#if isCurrent}
								<span class="badge current-badge">current</span>
							{/if}
						</div>
						<div class="actions">
							{#if isCurrent}
								<a href={docPath}>View</a>
							{:else}
								<a href={`${docPath}/v/${v.rkey}`}>View</a>
							{/if}
							{#if !isCurrent}
								<a href={`${docPath}/diff?from=${v.rkey}&to=${versions[0].rkey}`}>
									Diff vs current
								</a>
							{/if}
							{#if prev}
								<a href={`${docPath}/diff?from=${prev.rkey}&to=${v.rkey}`}>
									Diff vs previous
								</a>
							{/if}
						</div>
					</div>
					<p class="rkey">
						<code>{v.rkey}</code>
					</p>
				</li>
			{/each}
		</ol>
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
		margin: 0;
		font-size: 1.75rem;
	}
	.muted {
		color: #888;
		margin: 0.25rem 0 0;
		font-size: 0.9rem;
	}
	.versions {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.version {
		padding: 0.75rem 1rem;
		border: 1px solid #e5e5e5;
		border-radius: 6px;
		margin-bottom: 0.75rem;
		background: #fff;
	}
	.version.current {
		border-color: #b6d4b6;
		background: #f4faf4;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.when {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.when time {
		font-size: 0.95rem;
	}
	.badge {
		display: inline-block;
		padding: 0.1rem 0.45rem;
		font-size: 0.75rem;
		border-radius: 999px;
		background: #e5f0e5;
		color: #2d662d;
		border: 1px solid #b6d4b6;
	}
	.actions {
		display: flex;
		gap: 1rem;
		font-size: 0.9rem;
	}
	.actions a {
		color: #226;
		text-decoration: none;
	}
	.actions a:hover {
		text-decoration: underline;
	}
	.rkey {
		margin: 0.4rem 0 0;
		font-size: 0.75rem;
		color: #999;
	}
	.rkey code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.error {
		color: #b00;
	}
</style>
