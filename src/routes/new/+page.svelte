<script lang="ts">
	import { goto } from '$app/navigation';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import { auth } from '$lib/atproto/auth.svelte';
	import { createDocument } from '$lib/atproto/documents';

	let title = $state('');
	let body = $state(
		'# Untitled RFC\n\nStart writing your proposal here. Use markdown for structure.\n'
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
</script>

{#if auth.status !== 'signed-in'}
	<p class="muted">
		You need to be signed in to create a document. <a href="/">Go back</a> and sign in.
	</p>
{:else}
	<form
		class="composer"
		onsubmit={(e) => {
			e.preventDefault();
			void publish();
		}}
	>
		<input
			type="text"
			class="title"
			placeholder="RFC title"
			bind:value={title}
			required
			maxlength="300"
		/>
		<MarkdownEditor bind:value={body} />
		<div class="actions">
			{#if error}<span class="error">{error}</span>{/if}
			<a href="/" class="cancel">Cancel</a>
			<button type="submit" disabled={saving || !title.trim()}>
				{saving ? 'Publishing…' : 'Publish'}
			</button>
		</div>
	</form>
{/if}

<style>
	.composer {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.title {
		font: inherit;
		font-size: 1.75rem;
		font-weight: 600;
		padding: 0.5rem 0;
		border: none;
		border-bottom: 1px solid #e5e5e5;
		outline: none;
	}
	.title:focus {
		border-bottom-color: #226;
	}
	.actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 1rem;
	}
	.error {
		color: #b00;
		margin-right: auto;
	}
	.cancel {
		color: #555;
		text-decoration: none;
	}
	.cancel:hover {
		color: #000;
	}
	button {
		padding: 0.5rem 1rem;
		font: inherit;
		border: 1px solid #222;
		background: #222;
		color: white;
		border-radius: 6px;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.muted {
		color: #888;
	}
</style>
