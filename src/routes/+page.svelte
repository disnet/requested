<script lang="ts">
	import { auth } from '$lib/atproto/auth.svelte';
	import { listMyDocuments, type DocumentSummary } from '$lib/atproto/documents';

	let handle = $state('');
	let submitting = $state(false);
	let docs = $state<DocumentSummary[] | null>(null);
	let docsError = $state<string | null>(null);

	async function onSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!handle.trim()) return;
		submitting = true;
		try {
			await auth.signIn(handle);
		} catch (err) {
			auth.error = err instanceof Error ? err.message : String(err);
			submitting = false;
		}
	}

	// When signed in, load this user's documents.
	$effect(() => {
		const agent = auth.agent;
		const did = auth.did;
		if (!agent || !did) {
			docs = null;
			docsError = null;
			return;
		}
		void (async () => {
			try {
				docs = await listMyDocuments(agent, did);
				docsError = null;
			} catch (err) {
				docsError = err instanceof Error ? err.message : String(err);
				docs = [];
			}
		})();
	});

	// `handle` for URL is the profile handle when known, else the DID.
	const authorSlug = $derived(auth.profile?.handle ?? auth.did ?? '');
</script>

{#if auth.status === 'loading'}
	<p class="muted">Loading…</p>
{:else if auth.status === 'signed-out'}
	<section class="hero">
		<h1>AT-RFC</h1>
		<p>Publish markdown RFCs to your atproto PDS and collect threaded line-comments.</p>
		<form onsubmit={onSubmit}>
			<label>
				<span>Handle</span>
				<input
					type="text"
					placeholder="alice.bsky.social"
					bind:value={handle}
					autocomplete="username"
					required
				/>
			</label>
			<button type="submit" disabled={submitting}>
				{submitting ? 'Redirecting…' : 'Sign in with atproto'}
			</button>
		</form>
		{#if auth.error}
			<p class="error">{auth.error}</p>
		{/if}
	</section>
{:else}
	<section class="docs">
		<header class="docs-header">
			<h1>Your documents</h1>
			<a class="cta" href="/new">+ New document</a>
		</header>
		{#if docs === null}
			<p class="muted">Loading documents…</p>
		{:else if docsError}
			<p class="error">{docsError}</p>
		{:else if docs.length === 0}
			<p class="muted">
				No documents yet. <a href="/new">Write your first RFC</a> to publish it to your PDS.
			</p>
		{:else}
			<ul class="doc-list">
				{#each docs as doc (doc.uri)}
					<li>
						<a href={`/d/${authorSlug}/${doc.rkey}`}>
							<span class="title">{doc.value.title}</span>
							<time datetime={doc.value.createdAt}>
								{new Date(doc.value.createdAt).toLocaleDateString()}
							</time>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}

<style>
	.hero {
		text-align: center;
		padding: 3rem 1rem 1rem;
	}
	.hero h1 {
		font-size: 2.5rem;
		margin: 0 0 0.5rem;
	}
	.hero p {
		color: #555;
		max-width: 36rem;
		margin: 0 auto 2rem;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-width: 22rem;
		margin: 0 auto;
		text-align: left;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	label span {
		font-size: 0.8rem;
		color: #555;
	}
	input {
		padding: 0.5rem 0.75rem;
		font: inherit;
		border: 1px solid #ccc;
		border-radius: 6px;
	}
	button {
		padding: 0.5rem 0.75rem;
		font: inherit;
		border: 1px solid #222;
		background: #222;
		color: white;
		border-radius: 6px;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.6;
		cursor: progress;
	}
	.error {
		color: #b00;
		margin-top: 1rem;
		text-align: center;
	}
	.muted {
		color: #888;
	}
	.docs-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}
	.docs-header h1 {
		margin: 0;
		font-size: 1.5rem;
	}
	.cta {
		padding: 0.4rem 0.75rem;
		background: #222;
		color: white;
		text-decoration: none;
		border-radius: 6px;
		font-size: 0.9rem;
	}
	.cta:hover {
		background: #000;
	}
	.doc-list {
		list-style: none;
		padding: 0;
		margin: 0;
		border: 1px solid #e5e5e5;
		border-radius: 8px;
		overflow: hidden;
	}
	.doc-list li + li {
		border-top: 1px solid #f0f0f0;
	}
	.doc-list a {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
		padding: 0.75rem 1rem;
		text-decoration: none;
		color: inherit;
	}
	.doc-list a:hover {
		background: #fafafa;
	}
	.doc-list .title {
		font-weight: 500;
	}
	.doc-list time {
		font-size: 0.85rem;
		color: #888;
	}
</style>
