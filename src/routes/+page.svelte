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
				// Stable order: newest first by createdAt.
				docs.sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt));
				docsError = null;
			} catch (err) {
				docsError = err instanceof Error ? err.message : String(err);
				docs = [];
			}
		})();
	});

	const authorDid = $derived(auth.did ?? '');

	function rfcNumber(index: number, total: number): string {
		// Reverse the index so the oldest doc is RFC-0001. `docs` is sorted
		// newest-first, so the visual index is (total - 1 - i) but for users it
		// reads more naturally to count from the bottom — older docs have lower
		// numbers, like real RFCs.
		const n = total - index;
		return `RFC-${String(n).padStart(4, '0')}`;
	}

	function formatDate(iso: string): string {
		const d = new Date(iso);
		const y = d.getUTCFullYear();
		const m = String(d.getUTCMonth() + 1).padStart(2, '0');
		const day = String(d.getUTCDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}
</script>

{#if auth.status === 'loading'}
	<div class="column">
		<p class="muted">Loading…</p>
	</div>
{:else if auth.status === 'signed-out'}
	<section class="column signin">
		<div class="signin-meta">
			<div class="meta-row">
				<span class="meta-key">Status</span>
				<span class="meta-val">Internet-Draft</span>
			</div>
			<div class="meta-row">
				<span class="meta-key">Category</span>
				<span class="meta-val">Experimental</span>
			</div>
			<div class="meta-row">
				<span class="meta-key">Protocol</span>
				<span class="meta-val">atproto</span>
			</div>
		</div>

		<h1 class="signin-title">Requested</h1>
		<p class="signin-lead">
			Publish markdown documents-of-record to your atproto PDS. Collect line-anchored, threaded
			comments from anyone with an atproto identity. The artifact lives on your server, not ours.
		</p>

		<form class="signin-form" onsubmit={onSubmit}>
			<label class="field">
				<span class="field-label">Handle</span>
				<input
					class="field-control"
					type="text"
					placeholder="alice.bsky.social"
					bind:value={handle}
					autocomplete="username"
					required
					disabled={submitting}
				/>
			</label>
			<button type="submit" class="bracket-btn bracket-btn-primary" disabled={submitting}>
				{submitting ? '[ redirecting… ]' : '[ sign in with atproto ]'}
			</button>
		</form>
		{#if auth.error}
			<p class="error signin-error">{auth.error}</p>
		{/if}

		<footer class="signin-foot">
			<p class="muted">
				Requested uses atproto OAuth. You'll be redirected to your PDS to grant scoped access.
				Requested never sees your password.
			</p>
		</footer>
	</section>
{:else}
	<section class="column docs">
		<header class="docs-header">
			<div>
				<h1 class="docs-title">Documents</h1>
				<p class="docs-sub muted">
					Documents published to <code>{auth.profile?.handle ?? auth.did}</code>
				</p>
			</div>
			<a class="bracket-btn bracket-btn-primary" href="/new">[ new&nbsp;document ]</a>
		</header>

		{#if docs === null}
			<p class="muted">Loading documents…</p>
		{:else if docsError}
			<p class="error">{docsError}</p>
		{:else if docs.length === 0}
			<div class="docs-empty">
				<p class="muted">No documents yet on this PDS.</p>
				<a href="/new" class="action">→ Write your first RFC.</a>
			</div>
		{:else}
			<ol class="ledger" aria-label="Your documents">
				{#each docs as doc, i (doc.uri)}
					<li class="ledger-row">
						<a class="ledger-link" href={`/d/${authorDid}/${doc.rkey}`}>
							<span class="ledger-num">{rfcNumber(i, docs.length)}</span>
							<span class="ledger-title">{doc.value.title}</span>
							<span class="ledger-dots" aria-hidden="true"></span>
							<time class="ledger-date" datetime={doc.value.createdAt}>
								{formatDate(doc.value.createdAt)}
							</time>
						</a>
					</li>
				{/each}
			</ol>
		{/if}
	</section>
{/if}

<style>
	/* ---------- Sign-in ---------- */
	.signin {
		padding-top: var(--space-7);
	}
	.signin-meta {
		font-size: var(--text-sm);
		color: var(--ink-2);
		margin-bottom: var(--space-6);
		padding-bottom: var(--space-5);
		border-bottom: var(--border-thin) solid var(--rule);
	}
	.signin-meta .meta-row {
		display: flex;
		gap: var(--space-3);
		padding: var(--space-1) 0;
	}
	.meta-key {
		font-size: var(--text-2xs);
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--ink-3);
		min-width: 8ch;
	}
	.meta-val {
		color: var(--ink);
	}
	.signin-title {
		font-size: var(--text-3xl);
		font-weight: 700;
		letter-spacing: var(--track-tight);
		margin: 0 0 var(--space-3);
		text-align: center;
	}
	.signin-lead {
		max-width: 60ch;
		margin: 0 auto var(--space-7);
		text-align: center;
		color: var(--ink-2);
		line-height: var(--leading-body);
	}
	.signin-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
		max-width: 28rem;
		margin: 0 auto;
	}
	.signin-form .bracket-btn {
		align-self: stretch;
	}
	.signin-error {
		text-align: center;
		margin-top: var(--space-4);
	}
	.signin-foot {
		max-width: 56ch;
		margin: var(--space-8) auto 0;
		padding-top: var(--space-5);
		border-top: var(--border-thin) solid var(--rule);
		text-align: center;
		font-size: var(--text-sm);
	}

	/* ---------- Document ledger ---------- */
	.docs-header {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--space-5);
		margin-bottom: var(--space-6);
		padding-bottom: var(--space-4);
		border-bottom: var(--border-thin) solid var(--rule);
	}
	.docs-title {
		font-size: var(--text-2xl);
		font-weight: 700;
		letter-spacing: var(--track-tight);
		margin: 0 0 var(--space-1);
	}
	.docs-sub code {
		background: var(--surface-sunken);
		padding: 1px 4px;
		border: var(--border-thin) solid var(--rule);
		color: var(--ink-2);
	}
	.docs-empty {
		text-align: center;
		padding: var(--space-8) 0;
		border: var(--border-thin) dashed var(--rule);
	}
	.docs-empty p {
		margin-bottom: var(--space-4);
	}

	.ledger {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.ledger-row + .ledger-row {
		border-top: var(--border-thin) solid var(--rule);
	}
	.ledger-link {
		display: grid;
		grid-template-columns: auto 1fr auto auto;
		align-items: baseline;
		gap: var(--space-3);
		padding: var(--space-4) var(--space-2);
		text-decoration: none;
		color: var(--ink);
		transition: background var(--dur-fast) var(--ease-out-quart);
	}
	.ledger-link:hover {
		background: var(--surface-raised);
	}
	.ledger-link:hover .ledger-num {
		color: var(--accent);
	}
	.ledger-num {
		font-size: var(--text-xs);
		color: var(--ink-3);
		letter-spacing: var(--track-caps);
		min-width: 8ch;
		transition: color var(--dur-fast) var(--ease-out-quart);
	}
	.ledger-title {
		font-size: var(--text-base);
		color: var(--ink);
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ledger-dots {
		border-bottom: var(--border-thin) dotted var(--rule-strong);
		min-width: 1ch;
		align-self: baseline;
		height: 0;
		margin-bottom: 0.4em;
	}
	.ledger-date {
		font-size: var(--text-sm);
		color: var(--ink-3);
		font-variant-numeric: tabular-nums;
	}

	@media (max-width: 640px) {
		.docs-header {
			flex-direction: column;
			align-items: flex-start;
		}
		.ledger-link {
			grid-template-columns: auto 1fr;
			grid-template-areas:
				'num date'
				'title title';
			row-gap: var(--space-1);
		}
		.ledger-num {
			grid-area: num;
		}
		.ledger-date {
			grid-area: date;
			text-align: right;
		}
		.ledger-title {
			grid-area: title;
			white-space: normal;
		}
		.ledger-dots {
			display: none;
		}
	}
</style>
