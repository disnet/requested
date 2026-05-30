<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount, tick } from 'svelte';
	import { fade } from 'svelte/transition';
	import { SvelteSet } from 'svelte/reactivity';
	import { auth } from '$lib/atproto/auth.svelte';
	import { listMyDocuments, type DocumentSummary } from '$lib/atproto/documents';
	import { searchActorsTypeahead, type Profile } from '$lib/atproto/profile';
	import { loadActivity, type ActivityEntry } from '$lib/activity';
	import { loadInbox, type InboxResult } from '$lib/inbox';
	import { getCachedInbox, setCachedInbox, updateCachedInbox, formatAge } from '$lib/inbox-cache';
	import { dismissComment, dismissComments } from '$lib/dismissed-comments';

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

	// Inbox: unread, non-dismissed comments grouped by document. Cache-first so
	// returning to / shows last-known state immediately; a stale cache also
	// keeps refreshing in the background.
	let inbox = $state<InboxResult | null>(null);
	let inboxLoading = $state(false);
	let inboxError = $state<string | null>(null);
	let inboxAgeTick = $state(0); // re-renders the "as of" stamp every minute
	const expanded = new SvelteSet<string>();

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
			inbox = null;
			inboxError = null;
			inboxLoading = false;
			expanded.clear();
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
		// Inbox: paint from cache instantly when present so the section doesn't
		// flash empty on every visit. Always fetch fresh in the background.
		const cached = getCachedInbox(did);
		if (cached) inbox = cached;
		void refreshInbox(agent, did, { background: cached != null });
	});

	async function refreshInbox(
		agent: NonNullable<typeof auth.agent>,
		did: string,
		opts: { background?: boolean } = {}
	) {
		if (!opts.background) {
			inboxLoading = true;
			inboxError = null;
		}
		try {
			const result = await loadInbox(agent, did);
			inbox = result;
			setCachedInbox(did, result);
			inboxError = null;
		} catch (err) {
			if (!opts.background) {
				inboxError = err instanceof Error ? err.message : String(err);
			}
		} finally {
			inboxLoading = false;
		}
	}

	function onRefreshInbox() {
		const agent = auth.agent;
		const did = auth.did;
		if (!agent || !did) return;
		void refreshInbox(agent, did);
	}

	function toggleExpanded(docUri: string) {
		if (expanded.has(docUri)) expanded.delete(docUri);
		else expanded.add(docUri);
	}

	function onDismissComment(commentUri: string, docUri: string) {
		const did = auth.did;
		if (!did) return;
		dismissComment(commentUri, did);
		const next = updateCachedInbox(did, (r) => removeItemFromInbox(r, docUri, commentUri));
		if (next) inbox = next;
	}

	function onDismissMention(mentionUri: string, docUri: string) {
		const did = auth.did;
		if (!did) return;
		dismissComment(mentionUri, did);
		const next = updateCachedInbox(did, (r) => removeItemFromInbox(r, docUri, mentionUri));
		if (next) inbox = next;
	}

	function onDismissGroup(docUri: string) {
		const did = auth.did;
		if (!did) return;
		const group = inbox?.groups.find((g) => g.docUri === docUri);
		if (!group) return;
		dismissComments(
			[...group.comments.map((c) => c.uri), ...group.mentions.map((m) => m.uri)],
			did
		);
		const next = updateCachedInbox(did, (r) => removeGroupFromInbox(r, docUri));
		if (next) inbox = next;
		expanded.delete(docUri);
	}

	function groupUnread(g: InboxResult['groups'][number]): number {
		return g.comments.length + g.mentions.length;
	}

	function inboxTotal(groups: InboxResult['groups']): number {
		return groups.reduce((sum, g) => sum + groupUnread(g), 0);
	}

	// Drop a single comment or mention (keyed by at-uri) from its group, removing
	// the group entirely once it has neither comments nor mentions left.
	function removeItemFromInbox(r: InboxResult, docUri: string, itemUri: string): InboxResult {
		const groups = r.groups
			.map((g) => {
				if (g.docUri !== docUri) return g;
				const comments = g.comments.filter((c) => c.uri !== itemUri);
				const mentions = g.mentions.filter((m) => m.uri !== itemUri);
				if (comments.length === 0 && mentions.length === 0) return null;
				const mostRecentAt = [
					...comments.map((c) => c.createdAt),
					...mentions.map((m) => m.createdAt)
				].sort((a, b) => b.localeCompare(a))[0];
				return { ...g, comments, mentions, mostRecentAt };
			})
			.filter((g): g is NonNullable<typeof g> => g !== null);
		return { ...r, groups, totalUnread: inboxTotal(groups) };
	}

	function removeGroupFromInbox(r: InboxResult, docUri: string): InboxResult {
		const groups = r.groups.filter((g) => g.docUri !== docUri);
		return { ...r, groups, totalUnread: inboxTotal(groups) };
	}

	function shortVersion(versionUri: string): string {
		const rkey = versionUri.split('/').pop() ?? '';
		return rkey.length > 8 ? rkey.slice(-6) : rkey;
	}

	// Bump the age stamp once a minute so "just now" → "1 min ago" → "2 min ago"
	// without needing a render trigger. Cheap; ages are derived from inboxAgeTick.
	onMount(() => {
		const id = setInterval(() => {
			inboxAgeTick = inboxAgeTick + 1;
		}, 60_000);
		return () => clearInterval(id);
	});

	// Scroll to the inbox anchor when the user lands with #inbox in the URL.
	onMount(async () => {
		if (typeof window === 'undefined') return;
		if (window.location.hash !== '#inbox') return;
		await tick();
		document.getElementById('inbox')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	});

	const inboxStamp = $derived.by(() => {
		// Read inboxAgeTick so this re-computes on the interval.
		void inboxAgeTick;
		return inbox ? formatAge(inbox.loadedAt) : '';
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

	// Newer comments show relative time so a "2h ago" comment doesn't read as
	// "today's date" with no useful precision. Older drops to ISO date for
	// parity with the rest of the page.
	function formatCommentTime(iso: string): string {
		void inboxAgeTick;
		const ms = Date.now() - Date.parse(iso);
		if (Number.isNaN(ms)) return formatDate(iso);
		const mins = Math.round(ms / 60_000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins} min ago`;
		const hours = Math.round(mins / 60);
		if (hours < 24) return `${hours} h ago`;
		return formatDate(iso);
	}

	function unreadLabel(n: number): string {
		if (n >= 100) return '99+ new';
		return `${n} new`;
	}

	// Brief specifies fade-out, not layout animation. Honor prefers-reduced-motion
	// by collapsing the fade to 0ms so the row removal is instant.
	const reducedMotion = $derived.by(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	});

	// Cap each expanded group at this many comments to keep the panel from
	// getting unwieldy on a popular doc. Older comments are reachable by opening
	// the document.
	const GROUP_VISIBLE_CAP = 50;
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

		{#if inbox && inbox.groups.length > 0}
			<section id="inbox" class="subsection subsection-inbox" aria-label="Inbox">
				<header class="subsection-head">
					<h2 class="subsection-title">Inbox</h2>
					<div class="inbox-meta">
						<span class="muted inbox-stamp" aria-live="polite">
							{inboxLoading ? 'refreshing…' : `as of ${inboxStamp}`}
						</span>
						<button
							type="button"
							class="action inbox-refresh"
							onclick={onRefreshInbox}
							disabled={inboxLoading}
							aria-label="Refresh inbox"
						>
							[ refresh ]
						</button>
					</div>
				</header>
				<ol class="ledger ledger-inbox" aria-label="Unread comments by document">
					{#each inbox.groups as group (group.docUri)}
						{@const isOpen = expanded.has(group.docUri)}
						{@const unreadCount = group.comments.length + group.mentions.length}
						{@const actors = [
							...group.comments.map((c) => ({ handle: c.commenterHandle, at: c.createdAt })),
							...group.mentions.map((m) => ({ handle: m.authorHandle, at: m.createdAt }))
						].sort((a, b) => b.at.localeCompare(a.at))}
						{@const recentActor = actors[0].handle}
						{@const moreCount = new Set(actors.map((a) => a.handle)).size - 1}
						{@const visible = group.comments.slice(0, GROUP_VISIBLE_CAP)}
						{@const hidden = group.comments.length - visible.length}
						<li class="ledger-row ledger-row-inbox" class:open={isOpen}>
							<button
								type="button"
								class="ledger-link ledger-link-inbox"
								onclick={() => toggleExpanded(group.docUri)}
								aria-expanded={isOpen}
								aria-controls="inbox-group-{group.docUri}"
							>
								<span class="ledger-tag ledger-tag-new" aria-hidden="true">
									<span class="dot" aria-hidden="true"></span>{unreadLabel(unreadCount)}
								</span>
								<span class="sr-only">{unreadCount} unread items</span>
								<span class="ledger-title">{group.docTitle}</span>
								<span class="ledger-byline">
									from @{recentActor}{#if moreCount > 0}
										<span class="ledger-more"> + {moreCount} more</span>
									{/if}
								</span>
								<span class="ledger-dots" aria-hidden="true"></span>
								<time class="ledger-date" datetime={group.mostRecentAt}>
									{formatCommentTime(group.mostRecentAt)}
								</time>
								<span class="ledger-caret" aria-hidden="true">{isOpen ? '−' : '+'}</span>
							</button>
							{#if isOpen}
								<div id="inbox-group-{group.docUri}" class="inbox-panel">
									{#if group.mentions.length > 0}
										<ol class="inbox-comments inbox-mentions">
											{#each group.mentions as m (m.uri)}
												<li
													class="inbox-comment"
													transition:fade={{ duration: reducedMotion ? 0 : 160 }}
												>
													<a
														class="inbox-comment-link"
														href={resolve('/d/[did]/[rkey]', {
															did: group.docDid,
															rkey: group.docRkey
														})}
													>
														<span class="inbox-commenter">@{m.authorHandle}</span>
														<span class="inbox-line inbox-line-mention">MENTION</span>
														<span class="inbox-snippet"
															>mentioned you in version {shortVersion(m.versionUri)}</span
														>
														<span class="ledger-dots inbox-dots" aria-hidden="true"></span>
														<time class="inbox-time" datetime={m.createdAt}>
															{formatCommentTime(m.createdAt)}
														</time>
													</a>
													<button
														type="button"
														class="action inbox-dismiss"
														onclick={() => onDismissMention(m.uri, group.docUri)}
														aria-label="Dismiss mention from @{m.authorHandle}"
													>
														[ dismiss ]
													</button>
												</li>
											{/each}
										</ol>
									{/if}
									<ol class="inbox-comments">
										{#each visible as c (c.uri)}
											<li
												class="inbox-comment"
												transition:fade={{ duration: reducedMotion ? 0 : 160 }}
											>
												<a
													class="inbox-comment-link"
													href={resolve('/d/[did]/[rkey]', {
														did: group.docDid,
														rkey: group.docRkey
													})}
												>
													<span class="inbox-commenter">@{c.commenterHandle}</span>
													{#if c.line != null}
														<span class="inbox-line">L{c.line}</span>
													{/if}
													<span class="inbox-snippet">{c.snippet || '(empty comment)'}</span>
													<span class="ledger-dots inbox-dots" aria-hidden="true"></span>
													<time class="inbox-time" datetime={c.createdAt}>
														{formatCommentTime(c.createdAt)}
													</time>
												</a>
												<button
													type="button"
													class="action inbox-dismiss"
													onclick={() => onDismissComment(c.uri, group.docUri)}
													aria-label="Dismiss comment from @{c.commenterHandle}"
												>
													[ dismiss ]
												</button>
											</li>
										{/each}
									</ol>
									{#if hidden > 0}
										<p class="inbox-hidden-note muted">
											{hidden} older {hidden === 1 ? 'comment' : 'comments'} hidden — open the document
											to see all.
										</p>
									{/if}
									<div class="inbox-panel-foot">
										<a
											class="action inbox-open"
											href={resolve('/d/[did]/[rkey]', {
												did: group.docDid,
												rkey: group.docRkey
											})}
										>
											[ open&nbsp;document ]
										</a>
										<button
											type="button"
											class="action inbox-dismiss-all"
											onclick={() => onDismissGroup(group.docUri)}
										>
											[ dismiss&nbsp;all ]
										</button>
									</div>
								</div>
							{/if}
						</li>
					{/each}
				</ol>
			</section>
		{:else if inboxLoading && !inbox}
			<section class="subsection subsection-inbox" aria-label="Inbox">
				<header class="subsection-head">
					<h2 class="subsection-title">Inbox</h2>
				</header>
				<p class="muted activity-loading">Checking for new comments…</p>
			</section>
		{:else if inboxError && !inbox}
			<section class="subsection subsection-inbox" aria-label="Inbox">
				<header class="subsection-head">
					<h2 class="subsection-title">Inbox</h2>
					<button
						type="button"
						class="action inbox-refresh"
						onclick={onRefreshInbox}
						aria-label="Retry"
					>
						[ retry ]
					</button>
				</header>
				<p class="error">Couldn't reach Constellation.</p>
			</section>
		{/if}

		{#if activity === null}
			<section class="subsection" aria-label="Reading list">
				<header class="subsection-head">
					<h2 class="subsection-title">Reading list</h2>
				</header>
				<p class="muted activity-loading">Loading reading list…</p>
			</section>
		{:else if activityError}
			<section class="subsection" aria-label="Reading list">
				<header class="subsection-head">
					<h2 class="subsection-title">Reading list</h2>
				</header>
				<p class="error">{activityError}</p>
			</section>
		{:else if activity.length > 0}
			<section class="subsection" aria-label="Reading list">
				<header class="subsection-head">
					<h2 class="subsection-title">Reading list</h2>
				</header>
				<ol class="ledger ledger-activity">
					{#each activity as a (a.uri)}
						<li class="ledger-row">
							<a
								class="ledger-link ledger-link-act"
								href={resolve('/d/[did]/[rkey]', { did: a.did, rkey: a.rkey })}
							>
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

	.ledger-tag {
		font-size: var(--text-2xs);
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--ink-3);
		min-width: 8ch;
		transition: color var(--dur-fast) var(--ease-out-quart);
	}
	.ledger-byline {
		font-size: var(--text-sm);
		color: var(--ink-3);
		max-width: 24ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ---------- Inbox ---------- */
	.subsection-inbox {
		margin-top: var(--space-7);
	}
	.subsection-inbox .subsection-head {
		gap: var(--space-4);
	}
	.inbox-meta {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-3);
		font-size: var(--text-xs);
	}
	.inbox-stamp {
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
	}
	.inbox-refresh {
		font-size: var(--text-xs);
		white-space: nowrap;
	}
	.inbox-refresh[disabled] {
		opacity: 0.5;
		cursor: progress;
	}

	.ledger-inbox .ledger-row-inbox {
		display: block;
	}
	.ledger-link-inbox {
		display: grid;
		grid-template-columns: auto 1fr auto auto auto auto;
		align-items: baseline;
		gap: var(--space-3);
		padding: var(--space-4) var(--space-2);
		width: 100%;
		background: none;
		border: 0;
		text-align: left;
		font: inherit;
		color: var(--ink);
		cursor: pointer;
		transition: background var(--dur-fast) var(--ease-out-quart);
	}
	.ledger-link-inbox:hover {
		background: var(--surface-raised);
	}
	.ledger-link-inbox:hover .ledger-tag-new {
		color: var(--accent);
	}
	.ledger-tag-new {
		display: inline-flex;
		align-items: center;
		gap: 0.4ch;
		font-size: var(--text-2xs);
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--ink-2);
		min-width: 8ch;
		transition: color var(--dur-fast) var(--ease-out-quart);
	}
	.ledger-tag-new .dot {
		display: inline-block;
		width: 0.45em;
		height: 0.45em;
		background: var(--accent);
		border-radius: 50%;
		transform: translateY(-0.15em);
	}
	.ledger-caret {
		display: inline-block;
		width: 1.25rem;
		text-align: center;
		font-size: var(--text-base);
		color: var(--ink-3);
		font-variant-numeric: tabular-nums;
	}
	.ledger-link-inbox:hover .ledger-caret {
		color: var(--accent);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}

	.inbox-panel {
		padding: var(--space-2) var(--space-2) var(--space-4);
		border-top: var(--border-thin) dashed var(--rule);
		background: var(--surface-sunken);
	}
	.inbox-comments {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.inbox-comment {
		display: grid;
		grid-template-columns: 1fr auto;
		align-items: baseline;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-2);
		border-bottom: var(--border-thin) dotted var(--rule);
	}
	.inbox-comment:last-child {
		border-bottom: none;
	}
	.inbox-comment-link {
		display: grid;
		grid-template-columns: auto auto 1fr auto auto;
		align-items: baseline;
		gap: var(--space-3);
		text-decoration: none;
		color: var(--ink);
		min-width: 0;
	}
	.inbox-comment-link:hover .inbox-commenter {
		color: var(--accent);
	}
	.inbox-commenter {
		font-size: var(--text-sm);
		color: var(--ink-2);
		font-weight: 500;
		white-space: nowrap;
		transition: color var(--dur-fast) var(--ease-out-quart);
	}
	.inbox-line {
		font-size: var(--text-2xs);
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--ink-3);
		padding: 0.1em 0.5ch;
		border: var(--border-thin) solid var(--rule);
		font-variant-numeric: tabular-nums;
	}
	.inbox-line-mention {
		color: var(--accent);
		border-color: var(--accent);
	}
	.inbox-snippet {
		font-size: var(--text-sm);
		color: var(--ink-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.inbox-dots {
		min-width: 1ch;
	}
	.inbox-time {
		font-size: var(--text-xs);
		color: var(--ink-3);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.inbox-dismiss {
		font-size: var(--text-xs);
		color: var(--ink-3);
		opacity: 0;
		transition:
			color var(--dur-fast) var(--ease-out-quart),
			opacity var(--dur-fast) var(--ease-out-quart);
	}
	.inbox-comment:hover .inbox-dismiss,
	.inbox-dismiss:focus-visible {
		opacity: 1;
	}
	.inbox-dismiss:hover {
		color: var(--accent);
	}
	.ledger-more {
		color: var(--ink-4);
	}
	.inbox-hidden-note {
		font-size: var(--text-xs);
		padding: var(--space-2) var(--space-2) 0;
		font-style: italic;
	}
	.inbox-panel-foot {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-2) 0;
		margin-top: var(--space-2);
		border-top: var(--border-thin) dotted var(--rule);
		font-size: var(--text-xs);
	}
	.inbox-open,
	.inbox-dismiss-all {
		font-size: var(--text-xs);
	}
	.inbox-open:hover {
		color: var(--accent);
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
			grid-template-columns: 1fr auto;
			grid-template-areas:
				'byline date'
				'title title';
		}
		.ledger-byline {
			grid-area: byline;
			max-width: none;
		}
		.ledger-link-inbox {
			grid-template-columns: auto 1fr auto;
			grid-template-areas:
				'tag date caret'
				'title title title'
				'byline byline byline';
			row-gap: var(--space-1);
		}
		.ledger-link-inbox .ledger-tag-new {
			grid-area: tag;
		}
		.ledger-link-inbox .ledger-title {
			grid-area: title;
			white-space: normal;
		}
		.ledger-link-inbox .ledger-byline {
			grid-area: byline;
			max-width: none;
		}
		.ledger-link-inbox .ledger-date {
			grid-area: date;
			text-align: right;
		}
		.ledger-link-inbox .ledger-caret {
			grid-area: caret;
		}
		.ledger-link-inbox .ledger-dots {
			display: none;
		}
		.inbox-comment {
			grid-template-columns: 1fr;
			gap: var(--space-1);
		}
		.inbox-comment-link {
			grid-template-columns: auto auto;
			grid-template-areas:
				'commenter line'
				'snippet snippet'
				'time time';
			gap: var(--space-1) var(--space-2);
		}
		.inbox-commenter {
			grid-area: commenter;
		}
		.inbox-line {
			grid-area: line;
			justify-self: start;
		}
		.inbox-snippet {
			grid-area: snippet;
			white-space: normal;
		}
		.inbox-time {
			grid-area: time;
		}
		.inbox-dots {
			display: none;
		}
		.inbox-dismiss {
			opacity: 1;
			justify-self: end;
		}
	}
</style>
