<script lang="ts">
	import { resolve } from '$app/paths';
	import { auth } from '$lib/atproto/auth.svelte';
	import { listMyDocuments, type DocumentSummary } from '$lib/atproto/documents';
	import { searchActorsTypeahead, type Profile } from '$lib/atproto/profile';
	import { loadActivity, type ActivityEntry } from '$lib/activity';

	let handle = $state('');
	let submitting = $state(false);
	let docs = $state<DocumentSummary[] | null>(null);
	let docsError = $state<string | null>(null);

	// Activity ledger: documents the signed-in user has either commented on
	// (read from their PDS) or read in this browser (local-only). `null` means
	// "still loading" so the section can show a header + loading line;
	// `[]` means "loaded, nothing here" and the section hides entirely.
	let activity = $state<ActivityEntry[] | null>(null);
	let activityError = $state<string | null>(null);

	let suggestions = $state<Profile[]>([]);
	let activeIndex = $state(-1);
	let suggestionsOpen = $state(false);
	let lookupSeq = 0;
	let lookupAbort: AbortController | null = null;
	let lookupTimer: ReturnType<typeof setTimeout> | null = null;

	function onHandleInput() {
		activeIndex = -1;
		const q = handle.trim();
		if (lookupTimer) clearTimeout(lookupTimer);
		if (lookupAbort) lookupAbort.abort();
		if (q.length < 2) {
			suggestions = [];
			suggestionsOpen = false;
			return;
		}
		const mySeq = ++lookupSeq;
		lookupTimer = setTimeout(async () => {
			lookupAbort = new AbortController();
			try {
				const actors = await searchActorsTypeahead(q, 8, lookupAbort.signal);
				if (mySeq !== lookupSeq) return; // stale
				suggestions = actors;
				suggestionsOpen = actors.length > 0;
			} catch (err) {
				if (mySeq !== lookupSeq) return;
				if (err instanceof DOMException && err.name === 'AbortError') return;
				suggestions = [];
				suggestionsOpen = false;
			}
		}, 150);
	}

	function pickSuggestion(p: Profile) {
		handle = p.handle;
		suggestions = [];
		suggestionsOpen = false;
		activeIndex = -1;
	}

	function onHandleKeydown(e: KeyboardEvent) {
		if (!suggestionsOpen || suggestions.length === 0) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIndex = (activeIndex + 1) % suggestions.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIndex = activeIndex <= 0 ? suggestions.length - 1 : activeIndex - 1;
		} else if (e.key === 'Enter' && activeIndex >= 0) {
			e.preventDefault();
			pickSuggestion(suggestions[activeIndex]);
		} else if (e.key === 'Escape') {
			suggestionsOpen = false;
			activeIndex = -1;
		}
	}

	function onHandleBlur() {
		// Delay so click on a suggestion registers first.
		setTimeout(() => {
			suggestionsOpen = false;
			activeIndex = -1;
		}, 120);
	}

	function onHandleFocus() {
		if (suggestions.length > 0) suggestionsOpen = true;
	}

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
			activity = null;
			activityError = null;
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
		void (async () => {
			activity = null;
			activityError = null;
			try {
				activity = await loadActivity(agent, did);
			} catch (err) {
				activityError = err instanceof Error ? err.message : String(err);
				activity = [];
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
				<div class="combobox">
					<input
						class="field-control"
						type="text"
						placeholder="alice.bsky.social"
						bind:value={handle}
						oninput={onHandleInput}
						onkeydown={onHandleKeydown}
						onfocus={onHandleFocus}
						onblur={onHandleBlur}
						autocomplete="off"
						autocapitalize="off"
						autocorrect="off"
						spellcheck="false"
						role="combobox"
						aria-autocomplete="list"
						aria-expanded={suggestionsOpen}
						aria-controls="handle-suggestions"
						aria-activedescendant={activeIndex >= 0 ? `handle-sugg-${activeIndex}` : undefined}
						required
						disabled={submitting}
					/>
					{#if suggestionsOpen && suggestions.length > 0}
						<ul id="handle-suggestions" class="suggestions" role="listbox">
							{#each suggestions as actor, i (actor.did)}
								<li
									id="handle-sugg-{i}"
									role="option"
									aria-selected={i === activeIndex}
									class="suggestion"
									class:active={i === activeIndex}
									onmousedown={(e) => {
										e.preventDefault();
										pickSuggestion(actor);
									}}
								>
									{#if actor.avatar}
										<img class="sugg-avatar" src={actor.avatar} alt="" />
									{:else}
										<span class="sugg-avatar sugg-avatar-empty" aria-hidden="true"></span>
									{/if}
									<span class="sugg-text">
										<span class="sugg-handle">@{actor.handle}</span>
										{#if actor.displayName}
											<span class="sugg-name">{actor.displayName}</span>
										{/if}
									</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</label>
			<button type="submit" class="bracket-btn bracket-btn-primary" disabled={submitting}>
				{submitting ? '[ redirecting… ]' : '[ sign in with atmosphere account ]'}
			</button>
		</form>
		{#if auth.error}
			<p class="error signin-error">{auth.error}</p>
		{/if}

		<footer class="signin-foot">
			<p class="muted">
				Sign in with your atmosphere account — Requested redirects you to your PDS to grant scoped
				access. Requested never sees your password.
			</p>
		</footer>
	</section>
{:else}
	<section class="column docs">
		<header class="docs-header">
			<h1 class="docs-title">Documents</h1>
			<a class="bracket-btn bracket-btn-primary" href={resolve('/new')}>[ new&nbsp;document ]</a>
		</header>

		{#if docs === null}
			<p class="muted">Loading documents…</p>
		{:else if docsError}
			<p class="error">{docsError}</p>
		{:else if docs.length === 0}
			<div class="docs-empty">
				<p class="muted">No documents yet on this PDS.</p>
				<a href={resolve('/new')} class="action">→ Write your first RFC.</a>
			</div>
		{:else}
			<ol class="ledger" aria-label="Your documents">
				{#each docs as doc, i (doc.uri)}
					<li class="ledger-row">
						<a
							class="ledger-link"
							href={resolve('/d/[did]/[rkey]', { did: authorDid, rkey: doc.rkey })}
						>
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

		{#if activity === null}
			<section class="subsection" aria-label="Activity">
				<header class="subsection-head">
					<h2 class="subsection-title">Activity</h2>
				</header>
				<p class="muted activity-loading">Loading activity…</p>
			</section>
		{:else if activityError}
			<section class="subsection" aria-label="Activity">
				<header class="subsection-head">
					<h2 class="subsection-title">Activity</h2>
				</header>
				<p class="error">{activityError}</p>
			</section>
		{:else if activity.length > 0}
			<section class="subsection" aria-label="Activity">
				<header class="subsection-head">
					<h2 class="subsection-title">Activity</h2>
				</header>
				<ol class="ledger ledger-activity">
					{#each activity as a (a.uri)}
						<li class="ledger-row">
							<a
								class="ledger-link ledger-link-act"
								href={resolve('/d/[did]/[rkey]', { did: a.did, rkey: a.rkey })}
							>
								<span class="ledger-tag ledger-tag-{a.tag}">{a.tag}</span>
								<span class="ledger-byline">by @{a.authorHandle}</span>
								<span class="ledger-title">{a.title}</span>
								<span class="ledger-dots" aria-hidden="true"></span>
								<time class="ledger-date" datetime={a.interactedAt}>
									{formatDate(a.interactedAt)}
								</time>
							</a>
						</li>
					{/each}
				</ol>
			</section>
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
		align-items: baseline;
		gap: var(--space-3);
		padding: var(--space-1) 0;
	}
	.meta-key {
		font-size: var(--text-2xs);
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--ink-3);
		width: 8ch;
		flex-shrink: 0;
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
	.combobox {
		position: relative;
	}
	.suggestions {
		position: absolute;
		top: calc(100% + 2px);
		left: 0;
		right: 0;
		z-index: 10;
		list-style: none;
		margin: 0;
		padding: 0;
		background: var(--surface);
		border: var(--border-thin) solid var(--rule-strong);
		max-height: 18rem;
		overflow-y: auto;
		box-shadow: 0 4px 12px rgb(0 0 0 / 0.08);
	}
	.suggestion {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
		cursor: pointer;
		border-bottom: var(--border-thin) solid var(--rule);
	}
	.suggestion:last-child {
		border-bottom: none;
	}
	.suggestion:hover,
	.suggestion.active {
		background: var(--surface-raised);
	}
	.sugg-avatar {
		width: 1.5rem;
		height: 1.5rem;
		flex-shrink: 0;
		border-radius: 50%;
		object-fit: cover;
		background: var(--surface-sunken);
	}
	.sugg-avatar-empty {
		display: inline-block;
		border: var(--border-thin) solid var(--rule);
	}
	.sugg-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.sugg-handle {
		font-size: var(--text-sm);
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sugg-name {
		font-size: var(--text-xs);
		color: var(--ink-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
		margin: 0;
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

	/* ---------- Activity subsection ---------- */
	.subsection {
		margin-top: var(--space-7);
	}
	.subsection-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-4);
		margin-bottom: var(--space-3);
		padding-bottom: var(--space-2);
		border-bottom: var(--border-thin) solid var(--rule);
	}
	.subsection-title {
		font-size: var(--text-sm);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--ink-2);
		margin: 0;
	}
	.activity-loading {
		padding: var(--space-3) var(--space-2);
		font-size: var(--text-sm);
	}

	.ledger-link-act {
		grid-template-columns: auto auto 1fr auto auto;
	}
	.ledger-tag {
		font-size: var(--text-2xs);
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--ink-3);
		min-width: 8ch;
		transition: color var(--dur-fast) var(--ease-out-quart);
	}
	.ledger-link-act:hover .ledger-tag {
		color: var(--accent);
	}
	.ledger-byline {
		font-size: var(--text-sm);
		color: var(--ink-3);
		max-width: 24ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
		.ledger-link-act {
			grid-template-columns: auto 1fr auto;
			grid-template-areas:
				'tag byline date'
				'title title title';
		}
		.ledger-tag {
			grid-area: tag;
		}
		.ledger-byline {
			grid-area: byline;
			max-width: none;
		}
	}
</style>
