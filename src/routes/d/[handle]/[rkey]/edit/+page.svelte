<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import { auth } from '$lib/atproto/auth.svelte';
	import {
		getDocument,
		resolveHandleToDid,
		saveNewVersion,
		type LoadedDocument
	} from '$lib/atproto/documents';

	let loaded = $state<LoadedDocument | null>(null);
	let body = $state('');
	let originalBody = $state('');
	let error = $state<string | null>(null);
	let saving = $state(false);

	$effect(() => {
		const { handle, rkey } = page.params as { handle: string; rkey: string };
		loaded = null;
		body = '';
		originalBody = '';
		error = null;
		void (async () => {
			try {
				const did = await resolveHandleToDid(handle);
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
			await goto(`/d/${page.params.handle}/${page.params.rkey}`);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			saving = false;
		}
	}
</script>

{#if error}
	<p class="error">{error}</p>
{:else if loaded === null}
	<p class="muted">Loading…</p>
{:else if auth.status !== 'signed-in'}
	<p class="muted">Sign in to edit documents.</p>
{:else if !isOwner}
	<p class="error">You can only edit your own documents.</p>
{:else}
	<form
		class="composer"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<header class="doc-header">
			<h1>{loaded.value.title}</h1>
			<p class="muted">
				Editing creates a new version. Title isn't editable in this slice.
			</p>
		</header>
		<MarkdownEditor bind:value={body} />
		<div class="actions">
			<a href={`/d/${page.params.handle}/${page.params.rkey}`} class="cancel">Cancel</a>
			<button type="submit" disabled={saving || !dirty}>
				{saving ? 'Saving…' : dirty ? 'Save new version' : 'No changes'}
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
	.doc-header h1 {
		margin: 0;
		font-size: 1.75rem;
	}
	.doc-header p {
		margin: 0.25rem 0 0;
		font-size: 0.9rem;
	}
	.actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 1rem;
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
	.error {
		color: #b00;
	}
</style>
