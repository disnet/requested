<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import { auth } from '$lib/atproto/auth.svelte';
	import { getDocument, saveNewVersion, type LoadedDocument } from '$lib/atproto/documents';

	let loaded = $state<LoadedDocument | null>(null);
	let body = $state('');
	let originalBody = $state('');
	let error = $state<string | null>(null);
	let saving = $state(false);

	$effect(() => {
		const { did, rkey } = page.params as { did: string; rkey: string };
		loaded = null;
		body = '';
		originalBody = '';
		error = null;
		void (async () => {
			try {
				const doc = await getDocument(did, rkey);
				if (!doc.version) {
					error = 'This document has no current version to edit.';
					return;
				}
				loaded = doc;
				body = doc.version.value.body;
				originalBody = doc.version.value.body;
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}
		})();
	});

	const isOwner = $derived(loaded != null && auth.did === loaded.did);
	const dirty = $derived(loaded != null && body !== originalBody);

	async function save() {
		const agent = auth.agent;
		const did = auth.did;
		if (!agent || !did || !loaded) return;
		saving = true;
		error = null;
		try {
			await saveNewVersion(agent, did, loaded, body);
			await goto(`/d/${page.params.did}/${page.params.rkey}`);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			saving = false;
		}
	}

	const authorHandle = $derived(auth.profile?.handle ?? auth.did ?? '');
</script>

<svelte:head>
	{#if loaded?.value.title}
		<title>Editing {loaded.value.title} — AT-RFC</title>
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
{:else if auth.status !== 'signed-in'}
	<div class="column">
		<p class="muted">Sign in to edit documents.</p>
	</div>
{:else if !isOwner}
	<div class="column">
		<p class="error">You can only edit your own documents.</p>
	</div>
{:else}
	<div class="stripe-banner author-banner">
		<span>Status: Draft · Editing — saving creates a new version</span>
		<span class="author-banner-meta">
			Author: <strong>{authorHandle}</strong>
		</span>
	</div>

	<form
		class="composer"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<header class="doc-header">
			<div class="doc-header-meta">
				<span class="meta-key">Editing</span>
				<span class="muted mono-tight">{loaded.rkey}</span>
				{#if dirty}
					<span class="dirty">* unsaved</span>
				{/if}
			</div>
			<h1 class="doc-header-title">{loaded.value.title}</h1>
			<p class="doc-header-hint muted">Title is fixed for this version. Edit the body below.</p>
		</header>

		<div class="editor-frame">
			<div class="editor-rail">
				<span class="rail-label">Body</span>
				<span class="rail-hint muted">markdown · 72ch guide on the right</span>
			</div>
			<MarkdownEditor bind:value={body} />
		</div>

		<div class="actions">
			<a href={`/d/${page.params.did}/${page.params.rkey}`} class="action">[ cancel ]</a>
			<button type="submit" class="bracket-btn bracket-btn-primary" disabled={saving || !dirty}>
				{saving ? '[ saving… ]' : dirty ? '[ save new version ]' : '[ no changes ]'}
			</button>
		</div>
	</form>
{/if}

<style>
	.author-banner {
		max-width: var(--col-wide);
		margin: 0 auto var(--space-5);
		display: flex;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--space-3);
	}
	.author-banner strong {
		font-weight: 500;
		color: var(--ink);
	}
	.author-banner-meta {
		text-transform: none;
		letter-spacing: 0;
		color: var(--ink-3);
	}

	.composer {
		max-width: var(--col-wide);
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}

	.doc-header {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding-bottom: var(--space-4);
		border-bottom: var(--border-thin) solid var(--rule);
	}
	.doc-header-meta {
		display: flex;
		gap: var(--space-3);
		align-items: baseline;
		font-size: var(--text-xs);
	}
	.meta-key {
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--ink-3);
	}
	.mono-tight {
		font-size: var(--text-xs);
		color: var(--ink-3);
		letter-spacing: var(--track-tight);
	}
	.dirty {
		color: var(--accent);
		font-weight: 500;
	}
	.doc-header-title {
		font-size: var(--text-2xl);
		font-weight: 700;
		letter-spacing: var(--track-tight);
		line-height: var(--leading-tight);
		margin: 0;
	}
	.doc-header-hint {
		margin: 0;
		font-size: var(--text-sm);
	}

	.editor-frame {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.editor-rail {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-size: var(--text-2xs);
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--ink-3);
	}
	.rail-label {
		color: var(--ink-2);
	}

	.actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-4);
	}
</style>
