<script lang="ts">
	import { page } from '$app/state';
	import {
		getDocument,
		getVersion,
		resolveHandleToDid,
		type LoadedDocument,
		type LoadedVersion
	} from '$lib/atproto/documents';
	import { fetchProfile, type Profile } from '$lib/atproto/profile';
	import { renderMarkdown } from '$lib/markdown';

	let loaded = $state<LoadedDocument | null>(null);
	let version = $state<LoadedVersion | null>(null);
	let author = $state<Profile | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		const { handle, rkey, vrkey } = page.params as {
			handle: string;
			rkey: string;
			vrkey: string;
		};
		loaded = null;
		version = null;
		author = null;
		error = null;
		void (async () => {
			try {
				const did = await resolveHandleToDid(handle);
				const [doc, v, profile] = await Promise.all([
					getDocument(did, rkey),
					getVersion(did, vrkey),
					fetchProfile(did).catch(() => null)
				]);
				loaded = doc;
				version = v;
				author = profile;
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}
		})();
	});

	const docPath = $derived(`/d/${page.params.handle}/${page.params.rkey}`);
	const isCurrent = $derived(
		loaded?.version != null && version != null && loaded.version.cid === version.cid
	);
	const renderedHtml = $derived(version ? renderMarkdown(version.value.body) : '');
</script>

{#if error}
	<p class="error">{error}</p>
{:else if loaded === null || version === null}
	<p class="muted">Loading…</p>
{:else}
	{#if !isCurrent}
		<aside class="banner">
			<span>
				You're viewing an older version from
				<time datetime={version.value.createdAt}>
					{new Date(version.value.createdAt).toLocaleString()}
				</time>.
			</span>
			<span class="banner-actions">
				<a href={docPath}>Jump to current</a>
				{#if loaded.version}
					<a href={`${docPath}/diff?from=${version.rkey}&to=${loaded.version.uri.split('/').pop()}`}>
						Diff vs current
					</a>
				{/if}
				<a href={`${docPath}/history`}>All versions</a>
			</span>
		</aside>
	{/if}

	<article>
		<header class="doc-header">
			<h1>{loaded.value.title}</h1>
			<div class="meta">
				<span class="author">
					{#if author?.avatar}
						<img class="avatar" src={author.avatar} alt="" />
					{/if}
					<span>{author?.handle ?? loaded.did}</span>
				</span>
				<span class="sep">·</span>
				<time datetime={version.value.createdAt}>
					{new Date(version.value.createdAt).toLocaleString()}
				</time>
				<span class="sep">·</span>
				<a href={`${docPath}/history`}>History</a>
			</div>
		</header>

		<div class="prose">{@html renderedHtml}</div>
	</article>
{/if}

<style>
	.banner {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
		padding: 0.6rem 1rem;
		margin-bottom: 1.5rem;
		background: #fff3cd;
		border: 1px solid #ffeeba;
		color: #856404;
		border-radius: 6px;
		font-size: 0.9rem;
	}
	.banner-actions {
		display: flex;
		gap: 1rem;
	}
	.banner-actions a {
		color: #856404;
		text-decoration: underline;
	}
	.doc-header {
		margin-bottom: 2rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid #e5e5e5;
	}
	.doc-header h1 {
		margin: 0 0 0.5rem;
		font-size: 2rem;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9rem;
		color: #555;
	}
	.author {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}
	.avatar {
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 999px;
		object-fit: cover;
	}
	.sep {
		color: #ccc;
	}
	.meta a {
		color: #226;
		text-decoration: none;
	}
	.meta a:hover {
		text-decoration: underline;
	}
	.prose {
		line-height: 1.65;
	}
	.prose :global(h1),
	.prose :global(h2),
	.prose :global(h3) {
		margin-top: 2rem;
	}
	.prose :global(pre) {
		background: #f6f8fa;
		padding: 0.75rem 1rem;
		border-radius: 6px;
		overflow-x: auto;
		font-size: 0.9em;
	}
	.prose :global(code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.prose :global(:not(pre) > code) {
		background: #f6f8fa;
		padding: 0.1rem 0.3rem;
		border-radius: 3px;
		font-size: 0.9em;
	}
	.prose :global(blockquote) {
		border-left: 3px solid #ddd;
		margin: 1rem 0;
		padding: 0.25rem 0 0.25rem 1rem;
		color: #555;
	}
	.error {
		color: #b00;
	}
	.muted {
		color: #888;
	}
</style>
