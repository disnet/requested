<script lang="ts">
	import { page } from '$app/state';
	import { auth } from '$lib/atproto/auth.svelte';
	import {
		getDocument,
		resolveHandleToDid,
		type LoadedDocument
	} from '$lib/atproto/documents';
	import { fetchProfile, type Profile } from '$lib/atproto/profile';
	import { renderMarkdown } from '$lib/markdown';

	let loaded = $state<LoadedDocument | null>(null);
	let author = $state<Profile | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		const { handle, rkey } = page.params as { handle: string; rkey: string };
		loaded = null;
		author = null;
		error = null;
		void (async () => {
			try {
				const did = await resolveHandleToDid(handle);
				const [doc, profile] = await Promise.all([
					getDocument(did, rkey),
					fetchProfile(did).catch(() => null)
				]);
				loaded = doc;
				author = profile;
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}
		})();
	});

	const isOwner = $derived(loaded != null && auth.did === loaded.did);
	const renderedHtml = $derived(loaded?.version ? renderMarkdown(loaded.version.value.body) : '');
</script>

{#if error}
	<p class="error">{error}</p>
{:else if loaded === null}
	<p class="muted">Loading…</p>
{:else if !loaded.version}
	<p class="error">This document has no published version yet.</p>
{:else}
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
				<time datetime={loaded.version.value.createdAt}>
					{new Date(loaded.version.value.createdAt).toLocaleString()}
				</time>
				{#if isOwner}
					<span class="sep">·</span>
					<a href={`/d/${page.params.handle}/${page.params.rkey}/edit`}>Edit</a>
				{/if}
			</div>
		</header>

		<div class="prose">{@html renderedHtml}</div>
	</article>
{/if}

<style>
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
	.prose :global(table) {
		border-collapse: collapse;
		margin: 1rem 0;
	}
	.prose :global(th),
	.prose :global(td) {
		border: 1px solid #e5e5e5;
		padding: 0.4rem 0.75rem;
	}
	.error {
		color: #b00;
	}
	.muted {
		color: #888;
	}
</style>
