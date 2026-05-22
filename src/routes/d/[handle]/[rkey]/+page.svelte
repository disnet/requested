<script lang="ts">
	import { page } from '$app/state';
	import { auth } from '$lib/atproto/auth.svelte';
	import {
		getDocument,
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
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}
		})();
	});

	$effect(() => {
		const doc = loaded;
		if (!doc) return;
		// Re-runs when auth resolves so a signed-in user's own freshly-posted
		// comments get unioned in via listMyCommentsOn.
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
					list.map(async (c) => [c.uri, await describeCommentVersionState(c.value, current)] as const)
				);
				commentStates = new Map(entries);
			}
		} catch (err) {
			commentsError = err instanceof Error ? err.message : String(err);
		}
	}

	// Local helper to typecheck the agent value above without re-declaring its type.
	function getAgent() {
		return auth.agent;
	}

	const isOwner = $derived(loaded != null && auth.did === loaded.did);
	const renderedHtml = $derived(loaded?.version ? renderMarkdown(loaded.version.value.body) : '');
	const lineCount = $derived(loaded?.version ? loaded.version.value.body.split('\n').length : 0);

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
				<span class="sep">·</span>
				<a href={`/d/${page.params.handle}/${page.params.rkey}/history`}>History</a>
				{#if isOwner}
					<span class="sep">·</span>
					<a href={`/d/${page.params.handle}/${page.params.rkey}/edit`}>Edit</a>
				{/if}
			</div>
		</header>

		<div class="prose">{@html renderedHtml}</div>
	</article>

	<section class="comments">
		<header class="comments-header">
			<h2>Comments</h2>
			{#if auth.status === 'signed-in'}
				{#if !composerOpen}
					<button type="button" onclick={() => openComposer()}>Add comment</button>
				{/if}
			{:else}
				<span class="muted">Sign in to add comments.</span>
			{/if}
		</header>

		{#if composerOpen}
			<form class="composer" onsubmit={submitComment}>
				<label class="line-input">
					Line (optional)
					<input
						type="text"
						inputmode="numeric"
						pattern="[0-9]*"
						placeholder="leave blank for whole document"
						bind:value={composerLine}
					/>
				</label>
				<textarea
					rows="4"
					placeholder="Write a comment in markdown…"
					bind:value={composerBody}
				></textarea>
				{#if composerError}
					<p class="error">{composerError}</p>
				{/if}
				<div class="composer-actions">
					<button type="submit" disabled={composerPosting}>
						{composerPosting ? 'Posting…' : 'Post comment'}
					</button>
					<button type="button" onclick={closeComposer} disabled={composerPosting}>Cancel</button>
				</div>
			</form>
		{/if}

		{#if commentsError}
			<p class="error">{commentsError}</p>
		{/if}

		{#if comments.length === 0 && !commentsError}
			<p class="muted">No comments yet on this document.</p>
		{:else}
			{#if groupedComments.docLevel.length > 0}
				<div class="comment-group">
					<h3>On the whole document</h3>
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
	<h3>
		{#if shift?.kind === 'shifted'}
			Line {shift.to} <span class="shift">(was line {shift.from})</span>
		{:else if shift?.kind === 'lost'}
			<span class="shift">Line {line} — no longer present</span>
		{:else}
			Line {line}
		{/if}
	</h3>
	{#if shift?.kind === 'shifted' || shift?.kind === 'lost'}
		<p class="snippet" title="Original line text"><code>{shift.text || '(empty line)'}</code></p>
	{/if}
{/snippet}

{#snippet commentCard(c: LoadedComment)}
	{@const state = commentStates.get(c.uri)}
	{@const profile = commenterProfiles.get(c.did)}
	<article class="comment">
		<div class="comment-meta">
			<span class="commenter">
				{#if profile?.avatar}
					<img class="avatar" src={profile.avatar} alt="" />
				{/if}
				<span>{profile?.handle ?? c.did}</span>
			</span>
			<span class="sep">·</span>
			<time datetime={c.value.createdAt}>
				{new Date(c.value.createdAt).toLocaleString()}
			</time>
			{#if state && state.kind !== 'current'}
				<span class="badge">made on earlier version</span>
			{/if}
		</div>
		<div class="comment-body prose">{@html renderMarkdown(c.value.body)}</div>
	</article>
{/snippet}

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

	.comments {
		margin-top: 3rem;
		padding-top: 1.5rem;
		border-top: 1px solid #e5e5e5;
	}
	.comments-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.comments-header h2 {
		margin: 0;
		font-size: 1.4rem;
	}
	.composer {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
		padding: 1rem;
		background: #fafafa;
		border: 1px solid #e5e5e5;
		border-radius: 6px;
	}
	.composer textarea {
		font: inherit;
		padding: 0.5rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		resize: vertical;
	}
	.line-input {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9rem;
		color: #555;
	}
	.line-input input {
		width: 8rem;
		padding: 0.25rem 0.4rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		font: inherit;
	}
	.composer-actions {
		display: flex;
		gap: 0.5rem;
	}
	.comment-group {
		margin-top: 1.5rem;
	}
	.comment-group h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
		color: #333;
	}
	.shift {
		color: #a55;
		font-weight: normal;
	}
	.snippet {
		margin: 0 0 0.5rem;
		font-size: 0.85rem;
		color: #666;
	}
	.snippet code {
		background: #f6f8fa;
		padding: 0.1rem 0.3rem;
		border-radius: 3px;
	}
	.comment {
		margin-bottom: 0.75rem;
		padding: 0.75rem 1rem;
		border: 1px solid #e5e5e5;
		border-radius: 6px;
		background: #fff;
	}
	.comment-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
		color: #777;
		margin-bottom: 0.25rem;
	}
	.commenter {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		color: #333;
	}
	.badge {
		display: inline-block;
		padding: 0.1rem 0.4rem;
		font-size: 0.75rem;
		border-radius: 999px;
		background: #fff3cd;
		color: #856404;
		border: 1px solid #ffeeba;
	}
	.comment-body {
		font-size: 0.95rem;
	}
</style>
