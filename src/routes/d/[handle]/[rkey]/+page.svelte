<script lang="ts">
	import { onMount } from 'svelte';
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
	import { renderMarkdown, renderMarkdownBlocks } from '$lib/markdown';

	let loaded = $state<LoadedDocument | null>(null);
	let author = $state<Profile | null>(null);
	let error = $state<string | null>(null);

	let versionCount = $state<number | null>(null);

	let comments = $state<LoadedComment[]>([]);
	let commentStates = $state<Map<string, CommentVersionState>>(new Map());
	let commenterProfiles = $state<Map<string, Profile>>(new Map());
	let commentsError = $state<string | null>(null);

	// `composer` is null when closed. When open, `line` is the source-line
	// being commented on, or null for a whole-document comment.
	let composer = $state<{ line: number | null } | null>(null);
	let composerBody = $state('');
	let composerPosting = $state(false);
	let composerError = $state<string | null>(null);
	let composerBodyEl: HTMLTextAreaElement | undefined;

	// Viewport-driven layout mode. Above the breakpoint, line comments live in
	// a right-side rail anchored to each block. Below it, they collapse into
	// inline threads under their block. matchMedia is initialized in onMount —
	// SSR is off project-wide, so this is the first paint as far as users see.
	let isRail = $state(false);

	// Mobile fallback: which line threads are expanded inline. The doc-level
	// section is always expanded on mobile, so it doesn't need a flag.
	let expandedLines = $state<Set<number>>(new Set());

	// Cross-highlight: which line is currently being hovered or focused in
	// either the body or the rail. `null` for the doc-level group.
	let activeLine = $state<number | null | 'doc'>(null);

	// Refs used by the anchoring effect. These are $state so that bind:this
	// triggers the anchoring effect once the elements are mounted.
	let articleEl = $state<HTMLElement | undefined>(undefined);
	let railEl = $state<HTMLElement | undefined>(undefined);

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
		composer = null;
		composerBody = '';
		composerError = null;
		expandedLines = new Set();
		activeLine = null;
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

	onMount(() => {
		const mq = window.matchMedia('(min-width: 1200px)');
		isRail = mq.matches;
		const onChange = (e: MediaQueryListEvent) => {
			isRail = e.matches;
			// Re-collapse mobile threads when crossing back over the breakpoint,
			// since the rail cards take over the role on desktop.
			if (e.matches) expandedLines = new Set();
		};
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	});

	const isOwner = $derived(loaded != null && auth.did === loaded.did);
	const renderedBlocks = $derived(
		loaded?.version
			? renderMarkdownBlocks(loaded.version.value.body, { stripLeadingH1: true })
			: []
	);

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

	// Items rendered in the desktop rail, in vertical order. Each item is
	// anchored to a body block (or pinned to the top, for the doc group).
	// We fold the composer into whichever item it belongs to; when the user
	// opens a fresh line that has no prior comments, a synthetic item is
	// emitted so the composer has a card of its own.
	type RailItem =
		| { kind: 'doc'; key: string; line: null; comments: LoadedComment[] }
		| { kind: 'line'; key: string; line: number; comments: LoadedComment[] };

	const railItems = $derived.by<RailItem[]>(() => {
		const items: RailItem[] = [];

		const hasDocComments = groupedComments.docLevel.length > 0;
		const docComposerOpen = composer?.line === null;
		if (hasDocComments || docComposerOpen) {
			items.push({
				kind: 'doc',
				key: 'doc',
				line: null,
				comments: groupedComments.docLevel
			});
		}

		const lineKeys = new Set<number>();
		for (const [line, group] of groupedComments.lineGroups) {
			lineKeys.add(line);
			items.push({ kind: 'line', key: `L${line}`, line, comments: group });
		}
		// Composer on a fresh line — synthesize an empty group so the rail
		// has somewhere to host the composer.
		if (composer && composer.line != null && !lineKeys.has(composer.line)) {
			items.push({
				kind: 'line',
				key: `L${composer.line}`,
				line: composer.line,
				comments: []
			});
		}
		items.sort((a, b) => {
			if (a.line == null) return -1;
			if (b.line == null) return 1;
			return a.line - b.line;
		});
		return items;
	});

	// Anchor each rail card to its matching .md-block. The doc-group is pinned
	// at top:0; subsequent cards take max(desired, prev.bottom + gap) to avoid
	// overlap. Re-runs on layout changes via ResizeObserver.
	const ANCHOR_GAP = 12;
	$effect(() => {
		if (!isRail) return;
		const article = articleEl;
		const rail = railEl;
		if (!article || !rail) return;

		// Dependencies — track everything that can affect layout.
		void railItems;
		void renderedBlocks;
		void composer;
		void commentStates;

		let raf = 0;
		let firstPass = true;
		const reflow = () => {
			raf = 0;
			const articleRect = article.getBoundingClientRect();
			const head = rail.querySelector<HTMLElement>('.rail-head');
			// Floor — cards must clear the (sticky) rail header.
			const floor = head ? head.offsetHeight + ANCHOR_GAP : 0;
			const cards = rail.querySelectorAll<HTMLElement>('.rail-card');
			let prevBottom = floor;
			for (const card of cards) {
				if (firstPass) card.style.transition = 'none';
				const lineAttr = card.dataset.line;
				let desired = floor;
				if (lineAttr) {
					const block = article.querySelector<HTMLElement>(
						`.md-block[data-md-line="${lineAttr}"]`
					);
					if (block) {
						desired = block.getBoundingClientRect().top - articleRect.top;
					}
				}
				const top = Math.max(desired, prevBottom === floor ? floor : prevBottom + ANCHOR_GAP);
				card.style.transform = `translateY(${top}px)`;
				prevBottom = top + card.offsetHeight;
			}
			rail.style.minHeight = `${prevBottom}px`;
			if (firstPass) {
				// Re-enable the transform transition after the initial paint, so
				// subsequent reflows animate but the mount doesn't.
				requestAnimationFrame(() => {
					for (const card of cards) card.style.transition = '';
				});
				firstPass = false;
			}
		};

		const schedule = () => {
			if (raf) return;
			raf = requestAnimationFrame(reflow);
		};

		const ro = new ResizeObserver(schedule);
		ro.observe(article);
		ro.observe(rail);
		for (const card of rail.querySelectorAll<HTMLElement>('.rail-card')) {
			ro.observe(card);
		}
		schedule();

		return () => {
			ro.disconnect();
			if (raf) cancelAnimationFrame(raf);
		};
	});

	function openComposer(line: number | null) {
		composer = { line };
		composerBody = '';
		composerError = null;
		// On mobile, expand the inline thread so the composer is visible.
		if (!isRail && line != null) {
			const next = new Set(expandedLines);
			next.add(line);
			expandedLines = next;
		}
		// Defer focus until the textarea has been mounted by the each-loop.
		requestAnimationFrame(() => composerBodyEl?.focus());
	}

	function closeComposer() {
		composer = null;
		composerBody = '';
		composerError = null;
	}

	function toggleLine(line: number) {
		const next = new Set(expandedLines);
		if (next.has(line)) next.delete(line);
		else next.add(line);
		expandedLines = next;
	}

	function setActiveLine(line: number | null | 'doc') {
		activeLine = line;
	}

	async function submitComment(event: Event) {
		event.preventDefault();
		const agent = auth.agent;
		const myDid = auth.did;
		const doc = loaded;
		const current = composer;
		if (!agent || !myDid || !doc?.version || !current) return;
		if (!composerBody.trim()) {
			composerError = 'Comment cannot be empty.';
			return;
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
				current.line != null ? { line: current.line } : {}
			);
			closeComposer();
			await loadComments(doc, agent, myDid);
		} catch (err) {
			composerError = err instanceof Error ? err.message : String(err);
		} finally {
			composerPosting = false;
		}
	}

	function handleComposerKey(event: KeyboardEvent) {
		if (event.key === 'Escape' && composer && !composerPosting) {
			event.preventDefault();
			closeComposer();
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

	function formatRelative(iso: string): string {
		const then = new Date(iso).getTime();
		const now = Date.now();
		const s = Math.max(0, Math.round((now - then) / 1000));
		if (s < 45) return 'just now';
		const m = Math.round(s / 60);
		if (m < 60) return `${m} min ago`;
		const h = Math.round(m / 60);
		if (h < 24) return `${h}h ago`;
		const d = Math.round(h / 24);
		if (d < 14) return `${d}d ago`;
		return formatDate(iso);
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
	<div class="doc-shell" class:has-rail={isRail}>
		<article class="document" bind:this={articleEl}>
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
						<a class="action" href={`/d/${page.params.handle}/${page.params.rkey}/edit`}>
							[ edit ]
						</a>
					{/if}
				</nav>
			</header>

			<div class="prose">
				{#each renderedBlocks as block, i (i)}
					{@const blockLineGroup = groupedComments.lineGroups.find(([l]) => l === block.line)}
					{@const blockCommentCount = blockLineGroup ? blockLineGroup[1].length : 0}
					{@const isActive = activeLine === block.line}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="md-block"
						class:has-comments={blockCommentCount > 0}
						class:is-active={isActive}
						data-md-line={block.line}
						onmouseenter={() => setActiveLine(block.line)}
						onmouseleave={() => setActiveLine(null)}
						onfocusin={() => setActiveLine(block.line)}
						onfocusout={() => setActiveLine(null)}
					>
						{#if auth.status === 'signed-in'}
							<button
								type="button"
								class="md-comment-btn"
								aria-label={`Add comment on line ${block.line}`}
								title={`Comment on line ${block.line}`}
								onclick={() => openComposer(block.line)}
							>
								[+]
							</button>
						{/if}
						{@html block.html}
						{#if blockCommentCount > 0 && !isRail}
							<button
								type="button"
								class="line-chip"
								aria-expanded={expandedLines.has(block.line)}
								onclick={() => toggleLine(block.line)}
							>
								<span class="line-chip-count">{blockCommentCount}</span>
								<span class="line-chip-label">
									{blockCommentCount === 1 ? 'comment' : 'comments'}
								</span>
							</button>
						{/if}
						{#if !isRail && expandedLines.has(block.line) && blockLineGroup}
							<div class="inline-thread">
								{@render lineHeader(block.line, blockLineGroup[1])}
								{#each blockLineGroup[1] as c (c.uri)}
									{@render commentCard(c)}
								{/each}
								{#if composer && composer.line === block.line}
									{@render inlineComposer()}
								{/if}
							</div>
						{:else if !isRail && composer && composer.line === block.line}
							<div class="inline-thread">
								{@render inlineComposer()}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</article>

		{#if isRail}
			<aside class="rail" aria-label="Comments" bind:this={railEl}>
				<header class="rail-head">
					<h2 class="rail-title">
						<span class="section-num">§</span> Comments
						{#if comments.length > 0}
							<span class="rail-count">{comments.length}</span>
						{/if}
					</h2>
					{#if commentsError}
						<p class="error rail-error">{commentsError}</p>
					{/if}
					{#if auth.status === 'signed-in'}
						{#if composer?.line == null && composer !== null}
							<!-- whole-doc composer is open and will appear in the doc card -->
						{:else}
							<button
								type="button"
								class="rail-doc-btn"
								onclick={() => openComposer(null)}
							>
								[ comment on document ]
							</button>
						{/if}
					{:else}
						<span class="muted rail-signin">Sign in to add comments.</span>
					{/if}
				</header>

				{#if railItems.length === 0 && !commentsError}
					<p class="muted rail-empty">No comments yet.</p>
				{/if}

				{#each railItems as item (item.key)}
					{@const isActive =
						(item.kind === 'doc' && activeLine === 'doc') ||
						(item.kind === 'line' && activeLine === item.line)}
					<article
						class="rail-card"
						class:rail-card-doc={item.kind === 'doc'}
						class:is-active={isActive}
						data-line={item.kind === 'line' ? item.line : ''}
						onmouseenter={() => setActiveLine(item.kind === 'doc' ? 'doc' : item.line)}
						onmouseleave={() => setActiveLine(null)}
						onfocusin={() => setActiveLine(item.kind === 'doc' ? 'doc' : item.line)}
						onfocusout={() => setActiveLine(null)}
					>
						{@render railHeader(item)}
						{#each item.comments as c (c.uri)}
							{@render commentBody(c)}
						{/each}
						{#if composer && composer.line === (item.kind === 'doc' ? null : item.line)}
							{@render inlineComposer()}
						{/if}
					</article>
				{/each}
			</aside>
		{/if}
	</div>

	{#if !isRail}
		<section class="doc-comments" aria-label="Document-level comments">
			<header class="doc-comments-head">
				<h2>
					<span class="section-num">§</span> On the whole document
					{#if groupedComments.docLevel.length > 0}
						<span class="rail-count">{groupedComments.docLevel.length}</span>
					{/if}
				</h2>
				{#if auth.status === 'signed-in'}
					{#if composer?.line !== null}
						<button type="button" class="bracket-btn" onclick={() => openComposer(null)}>
							[ comment on document ]
						</button>
					{/if}
				{:else}
					<span class="muted">Sign in to add comments.</span>
				{/if}
			</header>

			{#if commentsError}
				<p class="error">{commentsError}</p>
			{/if}

			{#if composer && composer.line === null}
				{@render inlineComposer()}
			{/if}

			{#if groupedComments.docLevel.length === 0 && composer?.line !== null && !commentsError}
				<p class="muted doc-comments-empty">No document-level comments yet.</p>
			{:else}
				{#each groupedComments.docLevel as c (c.uri)}
					{@render commentCard(c)}
				{/each}
			{/if}
		</section>
	{/if}
{/if}

{#snippet inlineComposer()}
	<form class="composer composer-inline" onsubmit={submitComment}>
		<header class="composer-header">
			{#if composer?.line != null}
				<span class="anchor-tag">L{composer.line}</span>
				<span class="muted">Commenting on line {composer.line}</span>
			{:else}
				<span class="anchor-tag">doc</span>
				<span class="muted">Commenting on the whole document</span>
			{/if}
		</header>
		<textarea
			class="composer-body"
			rows="4"
			placeholder="Write a comment in markdown…"
			bind:value={composerBody}
			bind:this={composerBodyEl}
			onkeydown={handleComposerKey}
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
{/snippet}

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

{#snippet railHeader(item: RailItem)}
	{@const firstUri = item.comments[0]?.uri}
	{@const state = firstUri ? commentStates.get(firstUri) : undefined}
	{@const shift = state?.kind === 'line-stale' ? state.shift : null}
	<header class="rail-card-head">
		{#if item.kind === 'doc'}
			<span class="rail-tag rail-tag-doc">DOC</span>
			<span class="rail-card-label">on the whole document</span>
		{:else if shift?.kind === 'shifted'}
			<span class="rail-tag">L{shift.to}</span>
			<span class="rail-card-label">
				<span class="shift">was L{shift.from}</span>
			</span>
		{:else if shift?.kind === 'lost'}
			<span class="rail-tag rail-tag-warn">L{item.line}</span>
			<span class="rail-card-label shift">line removed</span>
		{:else}
			<span class="rail-tag">L{item.line}</span>
			<span class="rail-card-label">line {item.line}</span>
		{/if}
	</header>
	{#if shift?.kind === 'shifted' || shift?.kind === 'lost'}
		<p class="rail-snippet" title="Original line text">
			<code>{shift.text || '(empty line)'}</code>
		</p>
	{/if}
{/snippet}

{#snippet commentBody(c: LoadedComment)}
	{@const state = commentStates.get(c.uri)}
	{@const profile = commenterProfiles.get(c.did)}
	<div class="rail-comment">
		<div class="rail-comment-meta">
			<span class="commenter">
				{#if profile?.avatar}
					<img class="comment-avatar" src={profile.avatar} alt="" />
				{/if}
				<span class="rail-comment-handle">{profile?.handle ?? c.did}</span>
			</span>
			<time datetime={c.value.createdAt} class="rail-comment-time">
				{formatRelative(c.value.createdAt)}
			</time>
		</div>
		{#if state && state.kind !== 'current'}
			<span class="status status-superseded rail-comment-stale">on earlier version</span>
		{/if}
		<div class="rail-comment-body prose prose-sm">
			{@html renderMarkdown(c.value.body)}
		</div>
	</div>
{/snippet}

<style>
	/* --- Doc shell: body + (optional) right-side comment rail --- */
	.doc-shell {
		max-width: var(--col-body);
		margin-inline: auto;
	}
	.doc-shell.has-rail {
		max-width: calc(var(--col-body) + var(--space-7) + var(--rail-width));
		display: grid;
		grid-template-columns: minmax(0, var(--col-body)) var(--rail-width);
		column-gap: var(--space-7);
		align-items: start;
	}

	.document {
		min-width: 0;
	}

	/* --- Rail --- */
	.doc-shell {
		--rail-width: 30ch;
	}
	.rail {
		position: relative;
		border-left: var(--border-thin) solid var(--rule);
		padding-left: var(--space-5);
		font-size: var(--text-sm);
	}
	.rail-head {
		position: sticky;
		top: var(--space-4);
		padding-bottom: var(--space-4);
		margin-bottom: var(--space-4);
		border-bottom: var(--border-thin) solid var(--rule);
		background: var(--surface);
		z-index: 1;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.rail-title {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		font-size: var(--text-md);
		font-weight: 700;
		letter-spacing: var(--track-tight);
		color: var(--ink);
	}
	.rail-count {
		font-size: var(--text-2xs);
		letter-spacing: var(--track-caps);
		color: var(--ink-3);
		padding: 1px var(--space-2);
		border: var(--border-thin) solid var(--rule-strong);
	}
	.rail-doc-btn {
		align-self: flex-start;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--ink-2);
		background: transparent;
		border: 0;
		padding: 0;
		cursor: pointer;
		text-decoration: underline;
		text-decoration-color: var(--rule-strong);
		text-decoration-thickness: 1px;
		text-underline-offset: 3px;
		transition:
			color var(--dur-fast) var(--ease-out-quart),
			text-decoration-color var(--dur-fast) var(--ease-out-quart);
	}
	.rail-doc-btn:hover {
		color: var(--accent);
		text-decoration-color: currentColor;
	}
	.rail-signin {
		font-size: var(--text-xs);
	}
	.rail-error {
		margin: 0;
		font-size: var(--text-xs);
	}
	.rail-empty {
		font-size: var(--text-xs);
		padding: var(--space-4) 0;
		font-style: italic;
	}

	.rail-card {
		position: absolute;
		left: var(--space-5);
		right: 0;
		padding: var(--space-3) var(--space-4);
		background: var(--surface);
		border: var(--border-thin) solid var(--rule);
		font-size: var(--text-xs);
		line-height: var(--leading-snug);
		transition:
			border-color var(--dur-mid) var(--ease-out-quart),
			background var(--dur-mid) var(--ease-out-quart),
			transform var(--dur-mid) var(--ease-out-quart);
	}
	.rail-card.is-active {
		border-color: var(--accent);
		background: var(--surface-raised);
	}
	.rail-card-doc {
		background: var(--surface-raised);
	}
	.rail-card-head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-bottom: var(--space-2);
	}
	.rail-tag {
		display: inline-block;
		font-size: var(--text-2xs);
		font-weight: 500;
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		padding: 1px var(--space-2);
		border: var(--border-thin) solid var(--accent);
		color: var(--accent);
		min-width: 4ch;
		text-align: center;
	}
	.rail-tag-doc {
		border-color: var(--ink-3);
		color: var(--ink-3);
	}
	.rail-tag-warn {
		border-color: var(--warn);
		color: var(--warn);
	}
	.rail-card-label {
		font-size: var(--text-2xs);
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--ink-3);
	}
	.rail-snippet {
		margin: 0 0 var(--space-2);
		font-size: var(--text-2xs);
		color: var(--ink-3);
	}
	.rail-snippet code {
		background: var(--surface-sunken);
		padding: 1px 4px;
		border: var(--border-thin) solid var(--rule);
	}

	.rail-comment + .rail-comment {
		margin-top: var(--space-3);
		padding-top: var(--space-3);
		border-top: var(--border-thin) solid var(--rule);
	}
	.rail-comment-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-bottom: var(--space-2);
		font-size: var(--text-2xs);
		color: var(--ink-3);
	}
	.rail-comment-handle {
		color: var(--ink-2);
	}
	.rail-comment-time {
		color: var(--ink-3);
	}
	.rail-comment-stale {
		margin-bottom: var(--space-2);
	}
	.rail-comment-body {
		font-size: var(--text-xs);
		line-height: var(--leading-snug);
		color: var(--ink);
	}
	.rail-comment-body :global(p) {
		margin-bottom: var(--space-2);
	}
	.rail-comment-body :global(p:last-child) {
		margin-bottom: 0;
	}
	.rail-comment-body :global(pre),
	.rail-comment-body :global(code) {
		font-size: 0.9em;
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

	/* --- Line-anchored comment affordance ---
	   Each top-level markdown block gets a hover-revealed [+] in the left
	   gutter so commenting on a line is one click. Margin collapsing still
	   happens through the wrapping div, so block spacing is unchanged. */
	.prose :global(.md-block) {
		position: relative;
		margin-inline: calc(-1 * var(--space-2));
		padding-inline: var(--space-2);
		transition: background var(--dur-mid) var(--ease-out-quart);
	}
	.prose :global(.md-block.is-active) {
		background: color-mix(in oklch, var(--accent-fade) 60%, transparent);
	}
	.prose :global(.md-comment-btn) {
		position: absolute;
		left: -3rem;
		top: 0.1em;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		letter-spacing: var(--track-tight);
		color: var(--ink-3);
		background: transparent;
		border: 0;
		padding: 0;
		cursor: pointer;
		opacity: 0;
		transition:
			opacity var(--dur-fast) var(--ease-out-quart),
			color var(--dur-fast) var(--ease-out-quart);
	}
	.prose :global(.md-block:hover > .md-comment-btn),
	.prose :global(.md-comment-btn:focus-visible) {
		opacity: 1;
	}
	.prose :global(.md-comment-btn:hover) {
		color: var(--accent);
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

	/* --- Doc-level comments section (mobile fallback) --- */
	.doc-comments {
		max-width: var(--col-body);
		margin: var(--space-8) auto 0;
		padding-top: var(--space-5);
		border-top: var(--border-thick) solid var(--rule-strong);
	}
	.doc-comments-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-4);
		margin-bottom: var(--space-5);
		flex-wrap: wrap;
	}
	.doc-comments-head h2 {
		font-size: var(--text-lg);
		font-weight: 700;
		letter-spacing: var(--track-tight);
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
	}
	.doc-comments-empty {
		padding: var(--space-5) 0;
		font-style: italic;
		font-size: var(--text-sm);
	}
	.section-num {
		color: var(--accent);
		margin-right: 0.25ch;
	}

	/* --- Mobile line chip + inline thread --- */
	.line-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.4ch;
		margin-top: var(--space-2);
		font-family: var(--font-mono);
		font-size: var(--text-2xs);
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--accent);
		background: transparent;
		border: var(--border-thin) solid var(--accent);
		padding: 2px var(--space-2);
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out-quart),
			color var(--dur-fast) var(--ease-out-quart);
	}
	.line-chip:hover,
	.line-chip[aria-expanded='true'] {
		background: var(--accent);
		color: var(--accent-on);
	}
	.line-chip-count {
		font-weight: 700;
	}

	.inline-thread {
		margin-top: var(--space-3);
		padding: var(--space-3) var(--space-4);
		background: var(--surface-raised);
		border: var(--border-thin) solid var(--rule);
	}
	.inline-thread .comment {
		margin-left: 0;
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
	.composer-inline {
		margin: var(--space-3) 0 var(--space-5);
		padding: var(--space-3) var(--space-4);
	}
	.composer-header {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		font-size: var(--text-sm);
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

	.comment-anchor {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		font-size: var(--text-sm);
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
		margin: 0 0 var(--space-3);
		font-size: var(--text-sm);
		color: var(--ink-3);
	}
	.snippet code {
		background: var(--surface-sunken);
		padding: 1px 4px;
		border: var(--border-thin) solid var(--rule);
	}

	.comment {
		margin-bottom: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border: var(--border-thin) solid var(--rule);
		background: var(--surface);
	}
	.comment:last-child {
		margin-bottom: 0;
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
		.prose :global(.md-comment-btn) {
			position: static;
			display: inline-block;
			margin-right: var(--space-2);
			opacity: 0.5;
		}
	}
</style>
