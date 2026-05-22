<script lang="ts">
	import { page } from '$app/state';
	import { auth } from '$lib/atproto/auth.svelte';
	import {
		getDocument,
		listVersionChain,
		resolveHandleToDid,
		type LoadedDocument
	} from '$lib/atproto/documents';
	import {
		createComment,
		describeCommentVersionState,
		listAllCommentsOn,
		type CommentVersionState,
		type LoadedComment
	} from '$lib/atproto/comments';
	import { fetchProfile, type Profile } from '$lib/atproto/profile';
	import { renderMarkdown } from '$lib/markdown';

	let loaded = $state<LoadedDocument | null>(null);
	let author = $state<Profile | null>(null);
	let error = $state<string | null>(null);

	let versionCount = $state<number | null>(null);

	let comments = $state<LoadedComment[]>([]);
	let commentStates = $state<Map<string, CommentVersionState>>(new Map());
	let commenterProfiles = $state<Map<string, Profile>>(new Map());
	let commentsError = $state<string | null>(null);

	let composerOpen = $state(false);
	let composerLine = $state<string>('');
	let composerBody = $state('');
	let composerPosting = $state(false);
	let composerError = $state<string | null>(null);

	$effect(() => {
		const { handle, rkey } = page.params as { handle: string; rkey: string };
		loaded = null;
		author = null;
		error = null;
		versionCount = null;
		comments = [];
		commentStates = new Map();
		commenterProfiles = new Map();
		commentsError = null;
		void (async () => {
			try {
				const did = await resolveHandleToDid(handle);
				const [doc, profile] = await Promise.all([
					getDocument(did, rkey),
					fetchProfile(did).catch(() => null)
				]);
				loaded = doc;
				author = profile;
				// Fire-and-forget — version count is informational, not load-blocking.
				void listVersionChain(did, rkey)
					.then((chain) => (versionCount = chain.length))
					.catch(() => (versionCount = null));
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}
		})();
	});

	$effect(() => {
		const doc = loaded;
		if (!doc) return;
		const agent = auth.agent;
		const myDid = auth.did;
		void loadComments(doc, agent, myDid);
	});

	async function loadComments(
		doc: LoadedDocument,
		agent: ReturnType<typeof getAgent>,
		myDid: string | null
	) {
		commentsError = null;
		try {
			const list = await listAllCommentsOn(doc.uri, { agent, myDid });
			list.sort((a, b) => a.value.createdAt.localeCompare(b.value.createdAt));
			comments = list;

			const uniqueDids = [...new Set(list.map((c) => c.did))];
			void Promise.all(
				uniqueDids.map(async (did) => {
					if (commenterProfiles.has(did)) return;
					try {
						const p = await fetchProfile(did);
						commenterProfiles = new Map(commenterProfiles).set(did, p);
					} catch {
						// Profile lookup is display-only; falling back to the DID is fine.
					}
				})
			);

			if (doc.version) {
				const current = {
					uri: doc.version.uri,
					cid: doc.version.cid,
					body: doc.version.value.body
				};
				const entries = await Promise.all(
					list.map(
						async (c) => [c.uri, await describeCommentVersionState(c.value, current)] as const
					)
				);
				commentStates = new Map(entries);
			}
		} catch (err) {
			commentsError = err instanceof Error ? err.message : String(err);
		}
	}

	function getAgent() {
		return auth.agent;
	}

	const isOwner = $derived(loaded != null && auth.did === loaded.did);
	const renderedHtml = $derived(
		loaded?.version ? renderMarkdown(loaded.version.value.body, { stripLeadingH1: true }) : ''
	);
	const lineCount = $derived(loaded?.version ? loaded.version.value.body.split('\n').length : 0);

	// Display fields for the metadata block
	const authorHandle = $derived(author?.handle ?? loaded?.did ?? '');
	const authorDid = $derived(loaded?.did ?? '');
	const createdAt = $derived(loaded?.value.createdAt ?? null);
	const updatedAt = $derived(loaded?.version?.value.createdAt ?? null);
	const docCoords = $derived(loaded ? `${loaded.rkey}` : '');

	const groupedComments = $derived.by(() => {
		const docLevel: LoadedComment[] = [];
		const byLine = new Map<number, LoadedComment[]>();
		for (const c of comments) {
			if (c.value.line == null) {
				docLevel.push(c);
			} else {
				const arr = byLine.get(c.value.line) ?? [];
				arr.push(c);
				byLine.set(c.value.line, arr);
			}
		}
		const lineGroups = [...byLine.entries()].sort((a, b) => a[0] - b[0]);
		return { docLevel, lineGroups };
	});

	function openComposer(line?: number) {
		composerOpen = true;
		composerLine = line != null ? String(line) : '';
		composerBody = '';
		composerError = null;
	}

	function closeComposer() {
		composerOpen = false;
		composerBody = '';
		composerLine = '';
		composerError = null;
	}

	async function submitComment(event: Event) {
		event.preventDefault();
		const agent = auth.agent;
		const myDid = auth.did;
		const doc = loaded;
		if (!agent || !myDid || !doc?.version) return;
		if (!composerBody.trim()) {
			composerError = 'Comment cannot be empty.';
			return;
		}
		let line: number | undefined;
		if (composerLine.trim()) {
			const parsed = Number(composerLine);
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > lineCount) {
				composerError = `Line must be between 1 and ${lineCount}.`;
				return;
			}
			line = parsed;
		}
		composerPosting = true;
		composerError = null;
		try {
			await createComment(
				agent,
				myDid,
				{
					documentUri: doc.uri,
					version: { uri: doc.version.uri, cid: doc.version.cid }
				},
				composerBody.trim(),
				{ line }
			);
			closeComposer();
			await loadComments(doc, agent, myDid);
		} catch (err) {
			composerError = err instanceof Error ? err.message : String(err);
		} finally {
			composerPosting = false;
		}
	}

	function formatDate(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		const y = d.getUTCFullYear();
		const m = String(d.getUTCMonth() + 1).padStart(2, '0');
		const day = String(d.getUTCDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}
</script>

<svelte:head>
	{#if loaded?.value.title}
		<title>{loaded.value.title} — AT-RFC</title>
	{/if}
</svelte:head>

{#if error}
	<div class="column">
		<p class="error doc-error">
			This document could not be loaded.
			<br /><span class="muted">{error}</span>
		</p>
	</div>
{:else if loaded === null}
	<div class="column">
		<p class="muted">Loading document…</p>
	</div>
{:else if !loaded.version}
	<div class="column">
		<p class="error">This document has no published version yet.</p>
	</div>
{:else}
	<article class="document">
		<header class="meta-block" aria-label="Document metadata">
			<div class="meta-row">
				<div class="meta-left">
					<div class="meta-line">
						<span class="meta-key">Document</span>
						<span class="meta-val mono-tight">{docCoords}</span>
					</div>
					<div class="meta-line">
						<span class="meta-key">Status</span>
						<span class="status status-current">Current</span>
					</div>
					<div class="meta-line">
						<span class="meta-key">Version</span>
						<span class="meta-val">
							{#if versionCount != null && versionCount > 1}
								{versionCount} of {versionCount} (latest)
							{:else if versionCount === 1}
								1 of 1
							{:else}
								<span class="muted">—</span>
							{/if}
						</span>
					</div>
				</div>
				<div class="meta-right">
					<div class="meta-line meta-author">
						<span class="meta-key">Author</span>
						<span class="meta-val">
							<span class="meta-author-handle">
								{#if author?.avatar}
									<img class="meta-avatar" src={author.avatar} alt="" />
								{/if}
								<a href={`/d/${page.params.handle}`} class="author-link">{authorHandle}</a>
							</span>
							<span class="meta-author-did mono-tight">{authorDid}</span>
						</span>
					</div>
					<div class="meta-line">
						<span class="meta-key">Created</span>
						<span class="meta-val">
							<time datetime={createdAt ?? ''}>{formatDate(createdAt)}</time>
						</span>
					</div>
					<div class="meta-line">
						<span class="meta-key">Updated</span>
						<span class="meta-val">
							<time datetime={updatedAt ?? ''}>{formatDate(updatedAt)}</time>
						</span>
					</div>
				</div>
			</div>

			<h1 class="doc-title">{loaded.value.title}</h1>

			<nav class="meta-actions" aria-label="Document actions">
				<a class="action" href={`/d/${page.params.handle}/${page.params.rkey}/history`}>
					[ history ]
				</a>
				<a class="action" href={`/d/${page.params.handle}/${page.params.rkey}/diff`}>[ diff ]</a>
				{#if isOwner}
					<a class="action" href={`/d/${page.params.handle}/${page.params.rkey}/edit`}>[ edit ]</a>
				{/if}
			</nav>
		</header>

		<div class="prose">
			{@html renderedHtml}
		</div>
	</article>

	<section class="comments" aria-label="Comments">
		<header class="comments-header">
			<h2><span class="section-num">§</span> Comments</h2>
			{#if auth.status === 'signed-in'}
				{#if !composerOpen}
					<button type="button" class="bracket-btn" onclick={() => openComposer()}>
						[ add comment ]
					</button>
				{/if}
			{:else}
				<span class="muted">Sign in to add comments.</span>
			{/if}
		</header>

		{#if composerOpen}
			<form class="composer" onsubmit={submitComment}>
				<div class="composer-meta">
					<label class="field composer-line">
						<span class="field-label">Line</span>
						<input
							class="field-control"
							type="text"
							inputmode="numeric"
							pattern="[0-9]*"
							placeholder="leave blank for whole document"
							bind:value={composerLine}
						/>
					</label>
				</div>
				<textarea
					class="composer-body"
					rows="5"
					placeholder="Write a comment in markdown…"
					bind:value={composerBody}
				></textarea>
				{#if composerError}
					<p class="error">{composerError}</p>
				{/if}
				<div class="composer-actions">
					<button type="submit" class="bracket-btn bracket-btn-primary" disabled={composerPosting}>
						{composerPosting ? '[ posting… ]' : '[ post comment ]'}
					</button>
					<button
						type="button"
						class="bracket-btn"
						onclick={closeComposer}
						disabled={composerPosting}
					>
						[ cancel ]
					</button>
				</div>
			</form>
		{/if}

		{#if commentsError}
			<p class="error">{commentsError}</p>
		{/if}

		{#if comments.length === 0 && !commentsError}
			<p class="muted comments-empty">No comments yet on this document.</p>
		{:else}
			{#if groupedComments.docLevel.length > 0}
				<div class="comment-group">
					<h3 class="comment-anchor">
						<span class="anchor-tag">document</span>
						On the whole document
					</h3>
					{#each groupedComments.docLevel as c (c.uri)}
						{@render commentCard(c)}
					{/each}
				</div>
			{/if}

			{#each groupedComments.lineGroups as [line, group] (line)}
				<div class="comment-group">
					{@render lineHeader(line, group)}
					{#each group as c (c.uri)}
						{@render commentCard(c)}
					{/each}
				</div>
			{/each}
		{/if}
	</section>
{/if}

{#snippet lineHeader(line: number, group: LoadedComment[])}
	{@const state = commentStates.get(group[0].uri)}
	{@const shift = state?.kind === 'line-stale' ? state.shift : null}
	<h3 class="comment-anchor">
		{#if shift?.kind === 'shifted'}
			<span class="anchor-tag">L{shift.to}</span>
			<span>Line {shift.to} <span class="shift">was L{shift.from}</span></span>
		{:else if shift?.kind === 'lost'}
			<span class="anchor-tag anchor-tag-warn">L{line}</span>
			<span class="shift">Line {line} — no longer present</span>
		{:else}
			<span class="anchor-tag">L{line}</span>
			<span>Line {line}</span>
		{/if}
	</h3>
	{#if shift?.kind === 'shifted' || shift?.kind === 'lost'}
		<p class="snippet" title="Original line text">
			<code>{shift.text || '(empty line)'}</code>
		</p>
	{/if}
{/snippet}

{#snippet commentCard(c: LoadedComment)}
	{@const state = commentStates.get(c.uri)}
	{@const profile = commenterProfiles.get(c.did)}
	<article class="comment">
		<div class="comment-meta">
			<span class="commenter">
				{#if profile?.avatar}
					<img class="comment-avatar" src={profile.avatar} alt="" />
				{/if}
				<span>{profile?.handle ?? c.did}</span>
			</span>
			<span class="meta-sep">·</span>
			<time datetime={c.value.createdAt}>
				{new Date(c.value.createdAt).toLocaleString()}
			</time>
			{#if state && state.kind !== 'current'}
				<span class="status status-superseded">on earlier version</span>
			{/if}
		</div>
		<div class="comment-body prose prose-sm">
			{@html renderMarkdown(c.value.body)}
		</div>
	</article>
{/snippet}

<style>
	.document {
		max-width: var(--col-body);
		margin-inline: auto;
	}

	/* --- Metadata block --- */
	.meta-block {
		margin-bottom: var(--space-7);
		padding-bottom: var(--space-5);
		border-bottom: var(--border-thin) solid var(--rule);
	}
	.meta-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-5);
		font-size: var(--text-sm);
		color: var(--ink-2);
	}
	.meta-left {
		text-align: left;
	}
	.meta-right {
		text-align: right;
	}
	.meta-line {
		display: flex;
		gap: var(--space-3);
		align-items: baseline;
		padding: var(--space-1) 0;
		line-height: var(--leading-snug);
	}
	.meta-right .meta-line {
		justify-content: flex-end;
	}
	.meta-right .meta-line > .meta-val {
		text-align: right;
	}
	.meta-key {
		font-size: var(--text-2xs);
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--ink-3);
		min-width: 6ch;
	}
	.meta-val {
		color: var(--ink);
	}
	.mono-tight {
		letter-spacing: var(--track-tight);
		font-size: var(--text-xs);
		color: var(--ink-3);
		word-break: break-all;
	}
	.meta-author {
		flex-direction: column;
		align-items: flex-end;
		gap: var(--space-1);
	}
	.meta-author > .meta-key {
		align-self: flex-end;
	}
	.meta-author-handle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
	}
	.author-link {
		color: var(--ink);
		text-decoration-color: var(--rule-strong);
	}
	.author-link:hover {
		color: var(--accent);
	}
	.meta-author-did {
		display: block;
	}
	.meta-avatar {
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 999px;
		object-fit: cover;
		border: 1px solid var(--rule);
	}

	.doc-title {
		margin: var(--space-6) 0 var(--space-3);
		font-size: var(--text-3xl);
		font-weight: 700;
		line-height: var(--leading-tight);
		letter-spacing: var(--track-tight);
		text-align: center;
		color: var(--ink);
	}

	.meta-actions {
		display: flex;
		justify-content: center;
		gap: var(--space-4);
		font-size: var(--text-sm);
	}

	/* --- Prose --- */
	.prose {
		font-size: var(--text-base);
		line-height: var(--leading-body);
		color: var(--ink);
		counter-reset: section;
	}
	.prose :global(h1),
	.prose :global(h2),
	.prose :global(h3),
	.prose :global(h4) {
		font-weight: 700;
		line-height: var(--leading-snug);
		margin-top: var(--space-7);
		margin-bottom: var(--space-3);
		color: var(--ink);
		scroll-margin-top: var(--space-6);
	}
	.prose :global(h1) {
		font-size: var(--text-2xl);
		counter-reset: sub;
		padding-bottom: var(--space-2);
		border-bottom: var(--border-thin) solid var(--rule);
	}
	.prose :global(h1::before) {
		content: counter(section) '. ';
		counter-increment: section;
		color: var(--ink-3);
		margin-right: 0.5ch;
	}
	.prose :global(h2) {
		font-size: var(--text-xl);
		counter-reset: subsub;
	}
	.prose :global(h2::before) {
		content: counter(section) '.' counter(sub) '. ';
		counter-increment: sub;
		color: var(--ink-3);
		margin-right: 0.5ch;
	}
	.prose :global(h3) {
		font-size: var(--text-lg);
	}
	.prose :global(h3::before) {
		content: counter(section) '.' counter(sub) '.' counter(subsub) '. ';
		counter-increment: subsub;
		color: var(--ink-3);
		margin-right: 0.5ch;
	}
	.prose :global(h4) {
		font-size: var(--text-md);
		color: var(--ink-2);
	}
	.prose :global(p),
	.prose :global(ul),
	.prose :global(ol),
	.prose :global(blockquote),
	.prose :global(pre),
	.prose :global(table) {
		margin: 0 0 var(--space-4);
	}
	.prose :global(ul),
	.prose :global(ol) {
		padding-left: 2.5ch;
	}
	.prose :global(li) {
		margin-bottom: var(--space-1);
	}
	.prose :global(a) {
		color: var(--accent);
		text-decoration-color: var(--accent);
		text-decoration-thickness: 1px;
	}
	.prose :global(a:hover) {
		text-decoration-thickness: 2px;
	}
	.prose :global(blockquote) {
		border-left: 2px solid var(--rule-strong);
		padding: var(--space-1) 0 var(--space-1) var(--space-4);
		color: var(--ink-2);
		font-style: italic;
	}
	.prose :global(pre) {
		background: var(--surface-sunken);
		border: var(--border-thin) solid var(--rule);
		padding: var(--space-3) var(--space-4);
		overflow-x: auto;
		font-size: 0.9em;
		line-height: 1.5;
	}
	.prose :global(:not(pre) > code) {
		background: var(--surface-sunken);
		padding: 1px 4px;
		font-size: 0.9em;
		border: var(--border-thin) solid var(--rule);
	}
	.prose :global(table) {
		border-collapse: collapse;
		font-size: var(--text-sm);
		width: 100%;
		max-width: 100ch;
	}
	.prose :global(th),
	.prose :global(td) {
		border-bottom: var(--border-thin) solid var(--rule);
		padding: var(--space-2) var(--space-3);
		text-align: left;
	}
	.prose :global(th) {
		font-weight: 700;
		border-bottom: var(--border-thick) solid var(--rule-strong);
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		font-size: var(--text-xs);
		color: var(--ink-3);
	}
	.prose :global(hr) {
		border: 0;
		border-top: var(--border-thin) solid var(--rule);
		margin: var(--space-6) 0;
	}
	.prose :global(strong) {
		font-weight: 700;
	}

	.prose-sm {
		font-size: var(--text-sm);
		line-height: var(--leading-snug);
	}
	.prose-sm :global(p) {
		margin-bottom: var(--space-2);
	}

	.doc-error {
		text-align: center;
		padding-top: var(--space-7);
		font-size: var(--text-sm);
	}

	/* --- Comments section --- */
	.comments {
		max-width: var(--col-body);
		margin: var(--space-9) auto 0;
		padding-top: var(--space-5);
		border-top: var(--border-thick) solid var(--rule-strong);
	}
	.comments-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-4);
		margin-bottom: var(--space-5);
	}
	.comments-header h2 {
		font-size: var(--text-xl);
		font-weight: 700;
		letter-spacing: var(--track-tight);
	}
	.section-num {
		color: var(--accent);
		margin-right: 0.5ch;
	}

	.composer {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		margin-bottom: var(--space-6);
		padding: var(--space-4) var(--space-5);
		background: var(--surface-raised);
		border: var(--border-thin) solid var(--rule);
	}
	.composer-meta {
		display: flex;
	}
	.composer-line {
		max-width: 24rem;
	}
	.composer-body {
		font-family: var(--font-mono);
		font-size: var(--text-base);
		line-height: var(--leading-body);
		padding: var(--space-3);
		background: var(--surface);
		border: var(--border-thin) solid var(--rule-strong);
		color: var(--ink);
		resize: vertical;
		min-height: 6rem;
	}
	.composer-body:focus {
		outline: var(--border-thick) solid var(--accent);
		outline-offset: -2px;
		border-color: var(--accent);
	}
	.composer-actions {
		display: flex;
		gap: var(--space-3);
	}

	.comment-group {
		margin-top: var(--space-6);
	}
	.comment-group:first-child {
		margin-top: 0;
	}
	.comment-anchor {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		font-size: var(--text-md);
		font-weight: 500;
		margin-bottom: var(--space-3);
		color: var(--ink);
	}
	.anchor-tag {
		display: inline-block;
		font-size: var(--text-2xs);
		font-weight: 500;
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		padding: 2px var(--space-2);
		border: var(--border-thin) solid var(--accent);
		color: var(--accent);
		min-width: 4ch;
		text-align: center;
	}
	.anchor-tag-warn {
		border-color: var(--warn);
		color: var(--warn);
	}
	.shift {
		color: var(--warn);
		font-style: italic;
		font-weight: 400;
	}
	.snippet {
		margin: 0 0 var(--space-3) calc(4ch + var(--space-3));
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.snippet code {
		background: var(--surface-sunken);
		padding: 1px 4px;
		border: var(--border-thin) solid var(--rule);
	}

	.comment {
		margin-bottom: var(--space-4);
		padding: var(--space-4) var(--space-5);
		border: var(--border-thin) solid var(--rule);
		background: var(--surface);
		margin-left: calc(4ch + var(--space-3));
	}
	.comment-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-xs);
		color: var(--ink-3);
		margin-bottom: var(--space-2);
	}
	.commenter {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--ink-2);
	}
	.comment-avatar {
		width: 1rem;
		height: 1rem;
		border-radius: 999px;
		object-fit: cover;
		border: 1px solid var(--rule);
	}
	.meta-sep {
		color: var(--ink-4);
	}
	.comment-body :global(p:last-child) {
		margin-bottom: 0;
	}
	.comments-empty {
		text-align: center;
		padding: var(--space-6) 0;
		border: var(--border-thin) dashed var(--rule);
	}

	@media (max-width: 720px) {
		.meta-row {
			grid-template-columns: 1fr;
			gap: var(--space-3);
		}
		.meta-right {
			text-align: left;
		}
		.meta-right .meta-line {
			justify-content: flex-start;
		}
		.meta-right .meta-line > .meta-val {
			text-align: left;
		}
		.meta-author {
			align-items: flex-start;
		}
		.meta-author > .meta-key {
			align-self: flex-start;
		}
		.doc-title {
			font-size: var(--text-2xl);
			text-align: left;
		}
		.meta-actions {
			justify-content: flex-start;
		}
		.comment,
		.snippet {
			margin-left: 0;
		}
	}
</style>
