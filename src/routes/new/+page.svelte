<script lang="ts">
	import { goto } from '$app/navigation';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import { auth } from '$lib/atproto/auth.svelte';
	import { createDocument } from '$lib/atproto/documents';

	let title = $state('');
	let body = $state(
		'# Introduction\n\nDescribe the problem this proposal addresses.\n\n# Motivation\n\n...\n\n# Proposal\n\n...\n'
	);
	let saving = $state(false);
	let error = $state<string | null>(null);

	async function publish() {
		const agent = auth.agent;
		const did = auth.did;
		if (!agent || !did) {
			error = 'You must be signed in to publish.';
			return;
		}
		if (!title.trim()) {
			error = 'Title is required.';
			return;
		}
		saving = true;
		error = null;
		try {
			const { docRkey } = await createDocument(agent, did, title.trim(), body);
			const slug = auth.profile?.handle ?? did;
			await goto(`/d/${slug}/${docRkey}`);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			saving = false;
		}
	}

	const authorHandle = $derived(auth.profile?.handle ?? auth.did ?? '');
</script>

<svelte:head>
	<title>New document — AT-RFC</title>
</svelte:head>

{#if auth.status !== 'signed-in'}
	<div class="column">
		<p class="muted">
			You need to be signed in to create a document. <a href="/">Go back</a> and sign in.
		</p>
	</div>
{:else}
	<div class="stripe-banner author-banner">
		<span>Status: Draft · Authoring</span>
		<span class="author-banner-meta">
			Author: <strong>{authorHandle}</strong>
		</span>
	</div>

	<form
		class="composer"
		onsubmit={(e) => {
			e.preventDefault();
			void publish();
		}}
	>
		<div class="composer-meta">
			<label class="field">
				<span class="field-label">Title</span>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					class="field-control title-input"
					type="text"
					placeholder="The title of your RFC"
					bind:value={title}
					required
					maxlength="300"
					autofocus
				/>
			</label>
		</div>

		<div class="editor-frame">
			<div class="editor-rail">
				<span class="rail-label">Body</span>
				<span class="rail-hint muted">markdown · 72ch guide on the right</span>
			</div>
			<MarkdownEditor bind:value={body} />
		</div>

		<div class="actions">
			{#if error}<p class="error actions-error">{error}</p>{/if}
			<a href="/" class="action">[ cancel ]</a>
			<button
				type="submit"
				class="bracket-btn bracket-btn-primary"
				disabled={saving || !title.trim()}
			>
				{saving ? '[ publishing… ]' : '[ publish ]'}
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
	.composer-meta {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.title-input {
		font-size: var(--text-2xl);
		font-weight: 700;
		letter-spacing: var(--track-tight);
		padding: var(--space-3) 0;
	}
	.title-input::placeholder {
		font-weight: 400;
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
	.actions-error {
		margin-right: auto;
	}
</style>
