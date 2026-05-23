<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { auth } from '$lib/atproto/auth.svelte';
	import { getDocument, listVersionChain, type LoadedDocument } from '$lib/atproto/documents';
	import {
		authoritativeResolution,
		createComment,
		createResolution,
		deleteResolution,
		describeCommentVersionState,
		foldThreads,
		listAllCommentsOn,
		listAllResolutionsOn,
		myResolutionFor,
		type CommentVersionState,
		type LoadedComment,
		type LoadedResolution,
		type Thread
	} from '$lib/atproto/comments';
	import type { StrongRef } from '$lib/atproto/lexicons';
	import { fetchProfile, type Profile } from '$lib/atproto/profile';
	import { renderMarkdown, renderMarkdownBlocks } from '$lib/markdown';
	import CommentEditor from '$lib/components/CommentEditor.svelte';

	let loaded = $state<LoadedDocument | null>(null);
	let author = $state<Profile | null>(null);
	let error = $state<string | null>(null);

	let versionCount = $state<number | null>(null);

	let comments = $state<LoadedComment[]>([]);
	let commentStates = $state<Map<string, CommentVersionState>>(new Map());
	let commenterProfiles = $state<Map<string, Profile>>(new Map());
	let commentsError = $state<string | null>(null);

	let resolutions = $state<LoadedResolution[]>([]);

	// Root URIs whose resolved thread is currently expanded in-view. Resolved
	// threads collapse to a one-line summary by default and toggle open here.
	let expandedResolved = $state<Set<string>>(new Set());

	let resolveBusy = $state<Set<string>>(new Set());
	let resolveError = $state<Map<string, string>>(new Map());

	// `composer` is null when closed. `line` is the source-line being commented
	// on (or null for a whole-document comment). `parent` is set when replying
	// to an existing comment, in which case the new comment record carries that
	// strongRef as its `parent`. `replyToHandle` is purely for the composer
	// header copy and may be a DID fallback.
	let composer = $state<{
		line: number | null;
		parent: StrongRef | null;
		replyToHandle: string | null;
	} | null>(null);
	let composerBody = $state('');
	let composerPosting = $state(false);
	let composerError = $state<string | null>(null);

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
		const { did, rkey } = page.params as { did: string; rkey: string };
		loaded = null;
		author = null;
		error = null;
		versionCount = null;
		comments = [];
		commentStates = new Map();
		commenterProfiles = new Map();
		commentsError = null;
		resolutions = [];
		expandedResolved = new Set();
		resolveBusy = new Set();
		resolveError = new Map();
		composer = null;
		composerBody = '';
		composerError = null;
		expandedLines = new Set();
		activeLine = null;
		void (async () => {
			try {
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
			const [list, res] = await Promise.all([
				listAllCommentsOn(doc.uri, { agent, myDid }),
				listAllResolutionsOn(doc.uri, { agent, myDid })
			]);
			list.sort((a, b) => a.value.createdAt.localeCompare(b.value.createdAt));
			comments = list;
			resolutions = res;

			const uniqueDids = [...new Set([...list.map((c) => c.did), ...res.map((r) => r.did)])];
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
		loaded?.version ? renderMarkdownBlocks(loaded.version.value.body, { stripLeadingH1: true }) : []
	);

	// Display fields for the metadata block
	const authorHandle = $derived(author?.handle ?? loaded?.did ?? '');
	const authorDid = $derived(loaded?.did ?? '');
	const createdAt = $derived(loaded?.value.createdAt ?? null);
	const updatedAt = $derived(loaded?.version?.value.createdAt ?? null);
	const docCoords = $derived(loaded ? `${loaded.rkey}` : '');

	// Fold the flat comment list into threads (root + flat replies), then
	// partition by anchor. The doc-level bucket holds threads whose root has no
	// `line`; line groups are keyed by the root's line. Replies inherit the
	// root's anchor at render time regardless of what `line` their record
	// happens to carry — replies should never split off from their root.
	const allThreads = $derived(foldThreads(comments));

	const groupedThreads = $derived.by(() => {
		const docLevel: Thread[] = [];
		const byLine = new Map<number, Thread[]>();
		for (const t of allThreads) {
			const line = t.root.value.line;
			if (line == null) {
				docLevel.push(t);
			} else {
				const arr = byLine.get(line) ?? [];
				arr.push(t);
				byLine.set(line, arr);
			}
		}
		const lineGroups = [...byLine.entries()].sort((a, b) => a[0] - b[0]);
		return { docLevel, lineGroups };
	});

	// Authority-filtered resolution lookup, keyed by root comment URI. A thread
	// is "resolved" iff a record with this thread strongRef was written by an
	// authorized DID — the root commenter or the document author. Records by
	// any other DID are silently ignored.
	const documentAuthorDid = $derived(loaded?.did ?? null);
	const resolutionByRoot = $derived.by(() => {
		const out = new Map<string, LoadedResolution>();
		if (!documentAuthorDid) return out;
		for (const t of allThreads) {
			const r = authoritativeResolution(resolutions, t.root, documentAuthorDid);
			if (r) out.set(t.root.uri, r);
		}
		return out;
	});

	// Of the resolutions on this document, the one (if any) that the signed-in
	// user personally wrote for each root — required for the unresolve action
	// since you can only delete records from your own repo.
	const myResolutionByRoot = $derived.by(() => {
		const out = new Map<string, LoadedResolution>();
		const myDid = auth.did;
		if (!myDid) return out;
		for (const t of allThreads) {
			const mine = myResolutionFor(resolutions, t.root, myDid);
			if (mine) out.set(t.root.uri, mine);
		}
		return out;
	});

	function canResolve(thread: Thread): boolean {
		const myDid = auth.did;
		if (!myDid) return false;
		return myDid === thread.root.did || myDid === documentAuthorDid;
	}

	// Items rendered in the desktop rail, in vertical order. Each item is
	// anchored to a body block (or pinned to the top, for the doc group).
	// We fold the composer into whichever item it belongs to; when the user
	// opens a fresh line that has no prior comments, a synthetic item is
	// emitted so the composer has a card of its own.
	type RailItem =
		| { kind: 'doc'; key: string; line: null; threads: Thread[] }
		| { kind: 'line'; key: string; line: number; threads: Thread[] };

	const railItems = $derived.by<RailItem[]>(() => {
		const items: RailItem[] = [];

		const hasDocThreads = groupedThreads.docLevel.length > 0;
		const docComposerOpen = composer?.line === null;
		if (hasDocThreads || docComposerOpen) {
			items.push({
				kind: 'doc',
				key: 'doc',
				line: null,
				threads: groupedThreads.docLevel
			});
		}

		const lineKeys = new Set<number>();
		for (const [line, group] of groupedThreads.lineGroups) {
			lineKeys.add(line);
			items.push({ kind: 'line', key: `L${line}`, line, threads: group });
		}
		// Composer on a fresh line — synthesize an empty group so the rail
		// has somewhere to host the composer.
		if (composer && composer.line != null && !lineKeys.has(composer.line)) {
			items.push({
				kind: 'line',
				key: `L${composer.line}`,
				line: composer.line,
				threads: []
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
		void resolutionByRoot;
		void expandedResolved;
		void resolveError;

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
					const block = article.querySelector<HTMLElement>(`.md-block[data-md-line="${lineAttr}"]`);
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
		composer = { line, parent: null, replyToHandle: null };
		composerBody = '';
		composerError = null;
		// On mobile, expand the inline thread so the composer is visible.
		if (!isRail && line != null) {
			const next = new Set(expandedLines);
			next.add(line);
			expandedLines = next;
		}
		// CommentEditor autofocuses itself on mount; openComposer always
		// remounts the editor (different snippet site / unmounts on previous
		// close), so no imperative focus call is needed here.
	}

	function openReply(target: LoadedComment) {
		const profile = commenterProfiles.get(target.did);
		composer = {
			line: target.value.line ?? null,
			parent: { uri: target.uri, cid: target.cid },
			replyToHandle: profile?.handle ?? target.did
		};
		composerBody = '';
		composerError = null;
		if (!isRail && target.value.line != null) {
			const next = new Set(expandedLines);
			next.add(target.value.line);
			expandedLines = next;
		}
	}

	function closeComposer() {
		composer = null;
		composerBody = '';
		composerError = null;
	}

	function toggleResolvedExpand(rootUri: string) {
		const next = new Set(expandedResolved);
		if (next.has(rootUri)) next.delete(rootUri);
		else next.add(rootUri);
		expandedResolved = next;
	}

	async function resolveThread(thread: Thread) {
		const agent = auth.agent;
		const myDid = auth.did;
		const doc = loaded;
		if (!agent || !myDid || !doc) return;
		if (!canResolve(thread)) return;
		const rootUri = thread.root.uri;
		if (resolveBusy.has(rootUri)) return;
		resolveBusy = new Set(resolveBusy).add(rootUri);
		const nextErr = new Map(resolveError);
		nextErr.delete(rootUri);
		resolveError = nextErr;
		try {
			await createResolution(agent, myDid, { uri: thread.root.uri, cid: thread.root.cid }, doc.uri);
			await loadComments(doc, agent, myDid);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const m = new Map(resolveError);
			m.set(rootUri, msg);
			resolveError = m;
		} finally {
			const b = new Set(resolveBusy);
			b.delete(rootUri);
			resolveBusy = b;
		}
	}

	async function unresolveThread(thread: Thread) {
		const agent = auth.agent;
		const myDid = auth.did;
		const doc = loaded;
		if (!agent || !myDid || !doc) return;
		const mine = myResolutionByRoot.get(thread.root.uri);
		if (!mine) return; // you can only delete your own record
		const rootUri = thread.root.uri;
		if (resolveBusy.has(rootUri)) return;
		resolveBusy = new Set(resolveBusy).add(rootUri);
		const nextErr = new Map(resolveError);
		nextErr.delete(rootUri);
		resolveError = nextErr;
		try {
			await deleteResolution(agent, myDid, mine.rkey);
			// Collapse the "expanded resolved" state for this thread on success,
			// so the next render shows the now-open thread normally.
			const ex = new Set(expandedResolved);
			ex.delete(rootUri);
			expandedResolved = ex;
			await loadComments(doc, agent, myDid);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const m = new Map(resolveError);
			m.set(rootUri, msg);
			resolveError = m;
		} finally {
			const b = new Set(resolveBusy);
			b.delete(rootUri);
			resolveBusy = b;
		}
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

	async function postComment() {
		const agent = auth.agent;
		const myDid = auth.did;
		const doc = loaded;
		const current = composer;
		if (composerPosting) return;
		if (!agent || !myDid || !doc?.version || !current) return;
		if (!composerBody.trim()) {
			composerError = 'Comment cannot be empty.';
			return;
		}
		composerPosting = true;
		composerError = null;
		try {
			const opts: { line?: number; parent?: StrongRef } = {};
			if (current.line != null) opts.line = current.line;
			if (current.parent) opts.parent = current.parent;
			await createComment(
				agent,
				myDid,
				{
					documentUri: doc.uri,
					version: { uri: doc.version.uri, cid: doc.version.cid }
				},
				composerBody.trim(),
				opts
			);
			closeComposer();
			await loadComments(doc, agent, myDid);
		} catch (err) {
			composerError = err instanceof Error ? err.message : String(err);
		} finally {
			composerPosting = false;
		}
	}

	function submitComment(event: Event) {
		event.preventDefault();
		void postComment();
	}

	function onComposerEscape() {
		if (composer && !composerPosting) closeComposer();
	}

	function formatDate(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		const y = d.getUTCFullYear();
		const m = String(d.getUTCMonth() + 1).padStart(2, '0');
		const day = String(d.getUTCDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}

	// Extracts a single line from the current document body. Returns the trimmed
	// line text, or '' if the line is out of range. Used to render the source-
	// line excerpt in comment card heads so the card identifies its anchor by
	// content, not just line number.
	function getLineText(body: string | undefined, line: number | null): string {
		if (!body || line == null) return '';
		return (body.split('\n')[line - 1] ?? '').trim();
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
									<a href={`/d/${page.params.did}`} class="author-link">{authorHandle}</a>
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
					<a class="action" href={`/d/${page.params.did}/${page.params.rkey}/history`}>
						[ history ]
					</a>
					<a class="action" href={`/d/${page.params.did}/${page.params.rkey}/diff`}>[ diff ]</a>
					{#if isOwner}
						<a class="action" href={`/d/${page.params.did}/${page.params.rkey}/edit`}> [ edit ] </a>
					{/if}
				</nav>
			</header>

			<div class="prose">
				{#each renderedBlocks as block, i (i)}
					{@const blockLineThreads =
						groupedThreads.lineGroups.find(([l]) => l === block.line)?.[1] ?? []}
					{@const blockCommentCount = blockLineThreads.reduce(
						(acc, t) => acc + 1 + t.replies.length,
						0
					)}
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
						{#if blockCommentCount > 0 && isRail}
							<span class="md-comment-count" aria-hidden="true">
								[{blockCommentCount}]
							</span>
						{/if}
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
						{#if !isRail && expandedLines.has(block.line) && blockLineThreads.length > 0}
							<div class="inline-thread">
								{@render lineHeader(block.line, blockLineThreads[0].root)}
								{#each blockLineThreads as thread (thread.root.uri)}
									{@render threadInline(thread)}
								{/each}
								{#if composer && composer.line === block.line && composer.parent == null}
									{@render inlineComposer()}
								{/if}
							</div>
						{:else if !isRail && composer && composer.line === block.line && composer.parent == null}
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
							<button type="button" class="rail-doc-btn" onclick={() => openComposer(null)}>
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
						{#each item.threads as thread (thread.root.uri)}
							{@render threadRail(thread)}
						{/each}
						{#if composer && composer.line === (item.kind === 'doc' ? null : item.line) && composer.parent == null}
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
					{#if groupedThreads.docLevel.length > 0}
						<span class="rail-count">{groupedThreads.docLevel.length}</span>
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

			{#if composer && composer.line === null && composer.parent == null}
				{@render inlineComposer()}
			{/if}

			{#if groupedThreads.docLevel.length === 0 && composer?.line !== null && !commentsError}
				<p class="muted doc-comments-empty">No document-level comments yet.</p>
			{:else}
				{#each groupedThreads.docLevel as thread (thread.root.uri)}
					{@render threadInline(thread)}
				{/each}
			{/if}
		</section>
	{/if}
{/if}

{#snippet inlineComposer()}
	<form class="composer composer-inline" onsubmit={submitComment}>
		<header class="composer-header">
			{#if composer?.parent}
				<span class="muted">Replying to @{composer.replyToHandle ?? '…'}</span>
			{:else if composer?.line != null}
				<span class="muted">Commenting on this line</span>
			{:else}
				<span class="anchor-tag">doc</span>
				<span class="muted">Commenting on the whole document</span>
			{/if}
		</header>
		<CommentEditor bind:value={composerBody} onEscape={onComposerEscape} onSubmit={postComment} />
		{#if composerError}
			<p class="error">{composerError}</p>
		{/if}
		<div class="composer-actions">
			<button type="submit" class="bracket-btn bracket-btn-primary" disabled={composerPosting}>
				{composerPosting
					? '[ posting… ]'
					: composer?.parent
						? '[ post reply ]'
						: '[ post comment ]'}
			</button>
			<button type="button" class="bracket-btn" onclick={closeComposer} disabled={composerPosting}>
				[ cancel ]
			</button>
		</div>
	</form>
{/snippet}

{#snippet lineHeader(line: number, refComment: LoadedComment)}
	{@const state = commentStates.get(refComment.uri)}
	{@const shift = state?.kind === 'line-stale' ? state.shift : null}
	<h3 class="comment-anchor">
		{#if shift?.kind === 'shifted'}
			<code class="line-excerpt" title={shift.text || '(empty line)'}>
				{shift.text || '(empty line)'}
			</code>
			<span class="anchor-aside">moved</span>
		{:else if shift?.kind === 'lost'}
			<code class="line-excerpt line-excerpt-lost" title={shift.text || '(empty line)'}>
				{shift.text || '(empty line)'}
			</code>
			<span class="anchor-aside anchor-aside-warn">removed</span>
		{:else}
			{@const lineText = getLineText(loaded?.version?.value.body, line)}
			<code class="line-excerpt" title={lineText || '(empty line)'}>
				{lineText || '(empty line)'}
			</code>
		{/if}
	</h3>
{/snippet}

{#snippet threadInline(thread: Thread)}
	{@const resolution = resolutionByRoot.get(thread.root.uri)}
	{@const mineRes = myResolutionByRoot.get(thread.root.uri)}
	{@const isResolved = !!resolution}
	{@const expanded = expandedResolved.has(thread.root.uri)}
	{@const replyCount = thread.replies.length}
	{@const resolverProfile = resolution ? commenterProfiles.get(resolution.did) : null}
	{@const busy = resolveBusy.has(thread.root.uri)}
	{@const err = resolveError.get(thread.root.uri)}
	<div class="thread" class:thread-resolved={isResolved} class:thread-expanded={expanded}>
		{#if isResolved && !expanded}
			<div class="resolved-summary">
				<span class="resolved-mark" aria-hidden="true">✓</span>
				<span class="resolved-text">
					Resolved by <strong>@{resolverProfile?.handle ?? resolution.did}</strong>
					{#if replyCount > 0}
						<span class="resolved-sep">·</span>
						{replyCount}
						{replyCount === 1 ? 'reply' : 'replies'}
					{/if}
				</span>
				<div class="resolved-actions">
					<button
						type="button"
						class="bracket-btn bracket-btn-sm"
						onclick={() => toggleResolvedExpand(thread.root.uri)}
					>
						[ show ]
					</button>
					{#if mineRes}
						<button
							type="button"
							class="bracket-btn bracket-btn-sm"
							disabled={busy}
							onclick={() => unresolveThread(thread)}
						>
							{busy ? '[ …  ]' : '[ unresolve ]'}
						</button>
					{/if}
				</div>
				{#if err}
					<p class="error resolved-error">{err}</p>
				{/if}
			</div>
		{:else}
			{#if isResolved}
				<div class="resolved-banner">
					<span class="resolved-mark" aria-hidden="true">✓</span>
					<span class="resolved-text">
						Resolved by <strong>@{resolverProfile?.handle ?? resolution.did}</strong>
					</span>
					<div class="resolved-actions">
						<button
							type="button"
							class="bracket-btn bracket-btn-sm"
							onclick={() => toggleResolvedExpand(thread.root.uri)}
						>
							[ hide ]
						</button>
						{#if mineRes}
							<button
								type="button"
								class="bracket-btn bracket-btn-sm"
								disabled={busy}
								onclick={() => unresolveThread(thread)}
							>
								{busy ? '[ …  ]' : '[ unresolve ]'}
							</button>
						{/if}
					</div>
				</div>
			{/if}
			{@render commentCard(thread.root, true, isResolved)}
			{#if !isResolved}
				<div class="comment-actions">
					{#if auth.status === 'signed-in'}
						<button
							type="button"
							class="bracket-btn bracket-btn-sm"
							onclick={() => openReply(thread.root)}
						>
							[ reply ]
						</button>
					{/if}
					{#if canResolve(thread)}
						<button
							type="button"
							class="bracket-btn bracket-btn-sm"
							disabled={busy}
							onclick={() => resolveThread(thread)}
						>
							{busy ? '[ …  ]' : '[ resolve ]'}
						</button>
					{/if}
					{#if err}
						<span class="error inline-error">{err}</span>
					{/if}
				</div>
			{/if}
			{#if composer && composer.parent?.uri === thread.root.uri}
				{@render inlineComposer()}
			{/if}
			{#each thread.replies as r (r.uri)}
				{@render commentCard(r, false, isResolved)}
				{#if !isResolved && auth.status === 'signed-in'}
					<div class="comment-actions reply-actions">
						<button type="button" class="bracket-btn bracket-btn-sm" onclick={() => openReply(r)}>
							[ reply ]
						</button>
					</div>
				{/if}
				{#if composer && composer.parent?.uri === r.uri}
					{@render inlineComposer()}
				{/if}
			{/each}
		{/if}
	</div>
{/snippet}

{#snippet commentCard(c: LoadedComment, isRoot: boolean, threadResolved: boolean)}
	{@const state = commentStates.get(c.uri)}
	{@const profile = commenterProfiles.get(c.did)}
	<article class="comment" class:comment-reply={!isRoot} class:comment-dim={threadResolved}>
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
				<span class="stale-note">on earlier version</span>
			{/if}
		</div>
		<div class="comment-body prose prose-sm">
			{@html renderMarkdown(c.value.body)}
		</div>
	</article>
{/snippet}

{#snippet railHeader(item: RailItem)}
	{@const firstUri = item.threads[0]?.root.uri}
	{@const state = firstUri ? commentStates.get(firstUri) : undefined}
	{@const shift = state?.kind === 'line-stale' ? state.shift : null}
	<header class="rail-card-head">
		{#if item.kind === 'doc'}
			<span class="rail-doc-label">On the whole document</span>
		{:else if shift?.kind === 'shifted'}
			<code class="rail-line-excerpt" title={shift.text || '(empty line)'}>
				{shift.text || '(empty line)'}
			</code>
			<span class="rail-card-aside">moved</span>
		{:else if shift?.kind === 'lost'}
			<code class="rail-line-excerpt rail-line-excerpt-lost" title={shift.text || '(empty line)'}>
				{shift.text || '(empty line)'}
			</code>
			<span class="rail-card-aside rail-card-aside-warn">removed</span>
		{:else}
			{@const lineText = getLineText(loaded?.version?.value.body, item.line)}
			<code class="rail-line-excerpt" title={lineText || '(empty line)'}>
				{lineText || '(empty line)'}
			</code>
		{/if}
	</header>
{/snippet}

{#snippet threadRail(thread: Thread)}
	{@const resolution = resolutionByRoot.get(thread.root.uri)}
	{@const mineRes = myResolutionByRoot.get(thread.root.uri)}
	{@const isResolved = !!resolution}
	{@const expanded = expandedResolved.has(thread.root.uri)}
	{@const replyCount = thread.replies.length}
	{@const resolverProfile = resolution ? commenterProfiles.get(resolution.did) : null}
	{@const busy = resolveBusy.has(thread.root.uri)}
	{@const err = resolveError.get(thread.root.uri)}
	<div class="rail-thread" class:thread-resolved={isResolved} class:thread-expanded={expanded}>
		{#if isResolved && !expanded}
			<div class="resolved-summary">
				<span class="resolved-mark" aria-hidden="true">✓</span>
				<span class="resolved-text">
					Resolved by <strong>@{resolverProfile?.handle ?? resolution.did}</strong>
					{#if replyCount > 0}
						<span class="resolved-sep">·</span>
						{replyCount}
						{replyCount === 1 ? 'reply' : 'replies'}
					{/if}
				</span>
				<div class="resolved-actions">
					<button
						type="button"
						class="bracket-btn bracket-btn-sm"
						onclick={() => toggleResolvedExpand(thread.root.uri)}
					>
						[ show ]
					</button>
					{#if mineRes}
						<button
							type="button"
							class="bracket-btn bracket-btn-sm"
							disabled={busy}
							onclick={() => unresolveThread(thread)}
						>
							{busy ? '[ …  ]' : '[ unresolve ]'}
						</button>
					{/if}
				</div>
				{#if err}
					<p class="error resolved-error">{err}</p>
				{/if}
			</div>
		{:else}
			{#if isResolved}
				<div class="resolved-banner">
					<span class="resolved-mark" aria-hidden="true">✓</span>
					<span class="resolved-text">
						Resolved by <strong>@{resolverProfile?.handle ?? resolution.did}</strong>
					</span>
					<div class="resolved-actions">
						<button
							type="button"
							class="bracket-btn bracket-btn-sm"
							onclick={() => toggleResolvedExpand(thread.root.uri)}
						>
							[ hide ]
						</button>
						{#if mineRes}
							<button
								type="button"
								class="bracket-btn bracket-btn-sm"
								disabled={busy}
								onclick={() => unresolveThread(thread)}
							>
								{busy ? '[ …  ]' : '[ unresolve ]'}
							</button>
						{/if}
					</div>
				</div>
			{/if}
			{@render commentBody(thread.root, true, isResolved)}
			{#if !isResolved}
				<div class="comment-actions rail-actions">
					{#if auth.status === 'signed-in'}
						<button
							type="button"
							class="bracket-btn bracket-btn-sm"
							onclick={() => openReply(thread.root)}
						>
							[ reply ]
						</button>
					{/if}
					{#if canResolve(thread)}
						<button
							type="button"
							class="bracket-btn bracket-btn-sm"
							disabled={busy}
							onclick={() => resolveThread(thread)}
						>
							{busy ? '[ …  ]' : '[ resolve ]'}
						</button>
					{/if}
					{#if err}
						<span class="error inline-error">{err}</span>
					{/if}
				</div>
			{/if}
			{#if composer && composer.parent?.uri === thread.root.uri}
				{@render inlineComposer()}
			{/if}
			{#each thread.replies as r (r.uri)}
				{@render commentBody(r, false, isResolved)}
				{#if !isResolved && auth.status === 'signed-in'}
					<div class="comment-actions rail-actions reply-actions">
						<button type="button" class="bracket-btn bracket-btn-sm" onclick={() => openReply(r)}>
							[ reply ]
						</button>
					</div>
				{/if}
				{#if composer && composer.parent?.uri === r.uri}
					{@render inlineComposer()}
				{/if}
			{/each}
		{/if}
	</div>
{/snippet}

{#snippet commentBody(c: LoadedComment, isRoot: boolean, threadResolved: boolean)}
	{@const state = commentStates.get(c.uri)}
	{@const profile = commenterProfiles.get(c.did)}
	<div class="rail-comment" class:rail-comment-reply={!isRoot} class:comment-dim={threadResolved}>
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
			{#if state && state.kind !== 'current'}
				<span class="stale-note">on earlier version</span>
			{/if}
		</div>
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
		--rail-width: 40ch;
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
		top: 0;
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
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--space-2);
		row-gap: 4px;
		margin-bottom: var(--space-3);
	}
	.rail-doc-label {
		font-style: italic;
		font-size: var(--text-xs);
		color: var(--ink-3);
		letter-spacing: 0;
	}
	.rail-line-excerpt {
		flex: 1 1 6ch;
		min-width: 0;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		line-height: var(--leading-snug);
		color: var(--ink-2);
		background: var(--surface-sunken);
		padding: 1px 6px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		letter-spacing: var(--track-tight);
	}
	.rail-line-excerpt-lost {
		color: var(--ink-3);
		text-decoration: line-through;
		text-decoration-color: var(--warn);
	}
	.rail-card-aside {
		font-size: var(--text-2xs);
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--ink-3);
		font-style: italic;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.rail-card-aside-warn {
		color: var(--warn);
		font-style: normal;
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
		gap: var(--space-2);
		margin-bottom: var(--space-2);
		font-size: var(--text-2xs);
		color: var(--ink-3);
		letter-spacing: 0;
	}
	.rail-comment-handle {
		color: var(--ink-2);
	}
	.rail-comment-time {
		color: var(--ink-3);
	}
	/* Inline italic note replacing the bordered "ON EARLIER VERSION" pill.
	   The body is what should signal a comment's content; drift status is a
	   small footnote on the meta line, not a competing block element. */
	.stale-note {
		font-style: italic;
		color: var(--warn);
		font-size: var(--text-2xs);
		letter-spacing: 0;
	}
	.rail-comment-meta .stale-note::before {
		content: '· ';
		color: var(--ink-4);
		font-style: normal;
	}
	.rail-comment-body {
		font-size: var(--text-sm);
		line-height: var(--leading-snug);
		color: var(--ink);
		font-weight: 500;
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

	/* Persistent gutter count: when a block has comments, show [N] in the left
	   gutter so the body itself signals where comments live. Rail-mode only —
	   inline mode already has .line-chip. The [+] action button drops below
	   the count when both are present, so they never collide. */
	.prose :global(.md-comment-count) {
		position: absolute;
		left: -3rem;
		top: 0.1em;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		letter-spacing: var(--track-tight);
		color: var(--ink-3);
		pointer-events: none;
		transition: color var(--dur-fast) var(--ease-out-quart);
	}
	.prose :global(.md-block.is-active > .md-comment-count) {
		color: var(--accent);
	}
	.doc-shell.has-rail .prose :global(.md-block.has-comments > .md-comment-btn) {
		top: 1.4em;
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
	/* The thread sits inside `.prose`, so `.prose :global(h3)` would otherwise
	   bleed in: large/bold text plus a `0.0.1.`-style section counter from
	   `h3::before`. Override both here. */
	.inline-thread .comment-anchor {
		font-size: var(--text-sm);
		font-weight: 500;
		margin: 0 0 var(--space-3);
		padding-bottom: 0;
		border-bottom: 0;
	}
	.inline-thread .comment-anchor::before {
		content: none;
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
		flex-wrap: wrap;
		gap: var(--space-2);
		font-size: var(--text-sm);
	}
	.composer-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	/* Nested composer (inside a rail card or inline thread): drop the
	   double chrome (border + bg + outer padding) so it reads as part of
	   its parent card rather than a box-in-a-box, and shrink type so the
	   header fits on one line at narrow widths. */
	.rail-card .composer-inline,
	.inline-thread .composer-inline {
		margin: var(--space-3) 0 0;
		padding: 0;
		gap: var(--space-2);
		background: transparent;
		border: 0;
	}
	.rail-card .composer-header,
	.inline-thread .composer-header {
		font-size: var(--text-xs);
	}
	.rail-card .composer-actions :global(.bracket-btn),
	.inline-thread .composer-actions :global(.bracket-btn) {
		font-size: var(--text-xs);
		padding: 4px var(--space-2);
	}

	.comment-anchor {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-3);
		row-gap: var(--space-1);
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
		flex-shrink: 0;
	}
	.line-excerpt {
		flex: 1 1 8ch;
		min-width: 0;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		font-weight: 400;
		line-height: var(--leading-snug);
		color: var(--ink);
		background: var(--surface-sunken);
		padding: 2px 8px;
		border: var(--border-thin) solid var(--rule);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		letter-spacing: var(--track-tight);
	}
	.line-excerpt-lost {
		color: var(--ink-3);
		text-decoration: line-through;
		text-decoration-color: var(--warn);
	}
	.anchor-aside {
		font-size: var(--text-2xs);
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		color: var(--ink-3);
		font-style: italic;
		font-weight: 400;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.anchor-aside-warn {
		color: var(--warn);
		font-style: normal;
	}

	.comment {
		padding: var(--space-3) 0;
	}
	.comment + .comment {
		border-top: var(--border-thin) solid var(--rule);
	}
	.comment-meta .stale-note::before {
		content: '· ';
		color: var(--ink-4);
		font-style: normal;
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

	/* --- Threads (root + flat replies) ---
	   A thread is a sub-block inside a rail-card or inline-thread. Multiple
	   threads can stack within the same card (multiple roots on the same line).
	   The hairline rule between threads is a sibling-margin trick so the first
	   thread sits flush with the card header. */
	.thread + .thread,
	.rail-thread + .rail-thread {
		margin-top: var(--space-4);
		padding-top: var(--space-4);
		border-top: var(--border-thin) solid var(--rule);
	}

	/* Indent replies one step so the threading is legible without trapping the
	   eye into a deep tree. Only one level — see the design brief. */
	.comment-reply {
		margin-left: var(--space-4);
	}
	.rail-comment-reply {
		margin-left: var(--space-3);
		padding-left: var(--space-3);
		border-left: 1px solid var(--rule);
	}

	/* Reply / resolve action row. Lives between a comment and the next sibling
	   (next reply, composer, or end-of-thread). Uses the same bracketed button
	   vocabulary as the rest of the app. */
	.comment-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: center;
		margin: var(--space-1) 0 var(--space-3);
	}
	.rail-actions {
		margin: 2px 0 var(--space-3);
	}
	.reply-actions {
		margin-left: var(--space-4);
	}
	.rail-actions.reply-actions {
		margin-left: var(--space-3);
	}
	:global(.bracket-btn.bracket-btn-sm) {
		font-size: var(--text-xs);
		padding: 2px var(--space-2);
	}

	/* Inside a comment card the bracketed glyphs already carry structure —
	   the surrounding card border is the only chrome the row needs. Drop the
	   button border + padding so [ reply ] / [ resolve ] read as quiet
	   actions instead of stacking another box inside one. */
	.rail-card :global(.bracket-btn-sm),
	.inline-thread :global(.bracket-btn-sm),
	.doc-comments :global(.comment-actions .bracket-btn-sm),
	.doc-comments :global(.resolved-actions .bracket-btn-sm) {
		border: 0;
		padding: 0;
		color: var(--ink-3);
		background: transparent;
		letter-spacing: 0;
	}
	.rail-card :global(.bracket-btn-sm:hover),
	.inline-thread :global(.bracket-btn-sm:hover),
	.doc-comments :global(.comment-actions .bracket-btn-sm:hover),
	.doc-comments :global(.resolved-actions .bracket-btn-sm:hover) {
		color: var(--accent);
		background: transparent;
		border: 0;
	}
	.inline-error {
		font-size: var(--text-xs);
	}

	/* Resolved thread treatment. Collapsed by default to a one-line summary
	   so a doc with twenty resolved discussions still scans cleanly. Expanding
	   reveals the conversation under a subtle banner with [hide] / [unresolve]
	   actions; the comments themselves dim one step but stay legible. */
	.resolved-summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-2) 0;
		font-size: var(--text-xs);
		color: var(--ink-2);
	}
	.rail-thread .resolved-summary {
		font-size: var(--text-2xs);
		gap: var(--space-1) var(--space-2);
	}
	.resolved-banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-2) 0;
		margin-bottom: var(--space-2);
		font-size: var(--text-xs);
		color: var(--ink-2);
		border-bottom: var(--border-thin) solid var(--rule);
	}
	.rail-thread .resolved-banner {
		font-size: var(--text-2xs);
		gap: var(--space-1) var(--space-2);
	}
	.resolved-mark {
		color: var(--accent);
		font-weight: 700;
	}
	.resolved-text {
		flex: 1 1 auto;
		min-width: 0;
		line-height: var(--leading-snug);
	}
	.resolved-text strong {
		font-weight: 600;
		color: var(--ink);
	}
	.resolved-sep {
		color: var(--ink-4);
		margin: 0 0.1ch;
	}
	.resolved-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		flex-shrink: 0;
	}
	.resolved-error {
		flex: 1 1 100%;
		font-size: var(--text-xs);
		margin: 0;
	}
	.comment-dim {
		opacity: 0.6;
	}
	.comment-dim:hover,
	.thread-expanded:hover .comment-dim {
		opacity: 1;
	}

	/* In the rail card, a thread that's currently collapsed-resolved doesn't
	   need its own padding; the summary line carries the whole card. */
	.rail-thread.thread-resolved:not(.thread-expanded) {
		padding-top: 0;
	}
</style>
