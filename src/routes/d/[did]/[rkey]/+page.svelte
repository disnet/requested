<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { Agent } from '@atproto/api';
	import { auth } from '$lib/atproto/auth.svelte';
	import { listVersionChain, saveNewVersion } from '$lib/atproto/documents';
	import type { LoadedDocument } from '$lib/atproto/documents';
	import {
		applySuggestion,
		authoritativeResolution,
		buildSuggestionAnchor,
		createComment,
		createResolution,
		deleteResolution,
		describeCommentVersionState,
		findSuggestionAnchor,
		foldThreads,
		listAllCommentsOn,
		listAllResolutionsOn,
		myResolutionFor,
		type CommentVersionState,
		type LoadedComment,
		type LoadedResolution,
		type Thread
	} from '$lib/atproto/comments';
	import type { CommentSuggestion, StrongRef } from '$lib/atproto/lexicons';
	import { fetchProfile, type Profile } from '$lib/atproto/profile';
	import { renderMarkdown, renderMarkdownBlocks } from '$lib/markdown';
	import { recordView } from '$lib/viewed-docs';
	import CommentEditor from '$lib/components/CommentEditor.svelte';

	const { data } = $props();

	// Document, version, and author profile come pre-loaded from +page.ts — the
	// Worker fetches them server-side in SSR builds, and SvelteKit's universal
	// load runs them in the browser in SPA builds. `loaded` and `author` stay
	// as $derived so that client-side navigation between documents picks up the
	// new data without us having to refetch here.
	const loaded = $derived<LoadedDocument | null>(data.doc);
	const author = $derived<Profile | null>(data.profile);
	const error = $derived<string | null>(data.loadError);

	// Version chain is informational (just used for the "1 of N" hint), so we
	// keep it client-side and let it land lazily after first paint.
	let versionCount = $state<number | null>(null);

	let comments = $state<LoadedComment[]>([]);
	const commentStates = new SvelteMap<string, CommentVersionState>();
	const commenterProfiles = new SvelteMap<string, Profile>();
	let commentsError = $state<string | null>(null);

	let resolutions = $state<LoadedResolution[]>([]);

	// Root URIs whose resolved thread is currently expanded in-view. Resolved
	// threads collapse to a one-line summary by default and toggle open here.
	const expandedResolved = new SvelteSet<string>();

	const resolveBusy = new SvelteSet<string>();
	const resolveError = new SvelteMap<string, string>();

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

	// Inline suggest-edit state. Independent from the comment composer: clicking
	// [~] on a block (or sub-anchor) swaps the rendered markdown for a CodeMirror
	// editor preloaded with the source for that line range. `startLine`/`endLine`
	// are the 1-indexed source-line span being edited (`endLine === startLine` for
	// single-line edits); `replacement` is the editor's working text. Submitting
	// posts a `fyi.requested.comment` with an empty body and a suggestion anchor
	// derived from the current body + range at submit time.
	let suggestEdit = $state<{
		startLine: number;
		endLine: number;
		replacement: string;
	} | null>(null);
	let suggestPosting = $state(false);
	let suggestError = $state<string | null>(null);

	// Per-thread state for the author's "Apply" action on a suggestion. Mirrors
	// the resolveBusy/Error pair next door so the surfaces look the same.
	const applyBusy = new SvelteSet<string>();
	const applyError = new SvelteMap<string, string>();

	// Viewport-driven layout mode. Above the breakpoint, line comments live in
	// a right-side rail anchored to each block. Below it, they collapse into
	// inline threads under their block. matchMedia is initialized in onMount —
	// SSR is off project-wide, so this is the first paint as far as users see.
	let isRail = $state(false);

	// Mobile fallback: which line threads are expanded inline. The doc-level
	// section is always expanded on mobile, so it doesn't need a flag.
	const expandedLines = new SvelteSet<number>();

	// Cross-highlight: which line is currently being hovered or focused in
	// either the body or the rail. `null` for the doc-level group.
	let activeLine = $state<number | null | 'doc'>(null);

	// Persistent line highlight from a `#L<n>` permalink — either the URL hash
	// on first load or set when the user clicks a ¶ glyph. Independent from
	// `activeLine` so hovering elsewhere doesn't clear it.
	let linkedLine = $state<number | null>(null);

	// Transient confirmation that surfaces when ¶ copies a permalink to the
	// clipboard. Cleared on a short timer.
	let flashMsg = $state<string | null>(null);
	let flashTimer: number | null = null;

	// One-shot guard so the initial `#L<n>` scroll fires exactly once per
	// document load. Plain closure var — not reactive, doesn't drive effects.
	let didInitialHashScroll = false;

	// Refs used by the anchoring effect. These are $state so that bind:this
	// triggers the anchoring effect once the elements are mounted.
	let articleEl = $state<HTMLElement | undefined>(undefined);
	let railEl = $state<HTMLElement | undefined>(undefined);

	// When navigating between documents client-side, reset the per-document UI
	// state and kick off the secondary fetches that don't block first paint.
	// `data.doc?.uri` changes drive this — `untrack` keeps the reactive state
	// writes from re-triggering the effect.
	$effect(() => {
		const docUri = data.doc?.uri ?? null;
		untrack(() => {
			versionCount = null;
			comments = [];
			commentStates.clear();
			commenterProfiles.clear();
			commentsError = null;
			resolutions = [];
			expandedResolved.clear();
			resolveBusy.clear();
			resolveError.clear();
			composer = null;
			composerBody = '';
			composerError = null;
			suggestEdit = null;
			suggestError = null;
			applyBusy.clear();
			applyError.clear();
			expandedLines.clear();
			activeLine = null;
			linkedLine = null;
			didInitialHashScroll = false;
		});
		if (!docUri || !data.doc) return;
		const { did, rkey } = data.doc;
		void listVersionChain(did, rkey)
			.then((chain) => (versionCount = chain.length))
			.catch(() => (versionCount = null));
	});

	$effect(() => {
		const doc = loaded;
		if (!doc) return;
		const agent = auth.agent;
		const myDid = auth.did;
		void loadComments(doc, agent, myDid);
	});

	// Track local read history. Records any successful load of someone else's
	// document; the signed-in user's own docs already appear in Authored.
	// Per-device localStorage only — see src/lib/viewed-docs.ts.
	$effect(() => {
		const doc = loaded;
		const myDid = auth.did;
		if (!doc || !myDid || doc.did === myDid) return;
		recordView({ uri: doc.uri, did: doc.did, rkey: doc.rkey, viewerDid: myDid });
	});

	async function loadComments(doc: LoadedDocument, agent: Agent | null, myDid: string | null) {
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
						commenterProfiles.set(did, p);
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
				commentStates.clear();
				for (const [uri, state] of entries) commentStates.set(uri, state);
			}
		} catch (err) {
			commentsError = err instanceof Error ? err.message : String(err);
		}
	}

	onMount(() => {
		const mq = window.matchMedia('(min-width: 1200px)');
		isRail = mq.matches;
		const onChange = (e: MediaQueryListEvent) => {
			isRail = e.matches;
			// Re-collapse mobile threads when crossing back over the breakpoint,
			// since the rail cards take over the role on desktop.
			if (e.matches) expandedLines.clear();
		};
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	});

	const isOwner = $derived(loaded != null && auth.did === loaded.did);
	const renderedBlocks = $derived(
		loaded?.version ? renderMarkdownBlocks(loaded.version.value.body) : []
	);

	// Reverse index from any anchor line (block-level OR sub-anchor) to the
	// containing block's start line. Used so that opening a composer on, say,
	// list item line 7 expands the parent block on mobile and so cross-
	// highlights know which block frames a given sub-anchor.
	const subToBlock = $derived.by(() => {
		const map = new SvelteMap<number, number>();
		for (const b of renderedBlocks) {
			map.set(b.line, b.line);
			for (const sl of b.subLines) map.set(sl, b.line);
		}
		return map;
	});

	// Display fields for the metadata block
	const authorHandle = $derived(author?.handle ?? loaded?.did ?? '');
	const authorDid = $derived(loaded?.did ?? '');
	const createdAt = $derived(loaded?.value.createdAt ?? null);
	const updatedAt = $derived(loaded?.version?.value.createdAt ?? null);
	const docCoords = $derived(loaded ? `${loaded.rkey}` : '');

	const routeDid = $derived(page.params.did as string);
	const routeRkey = $derived(page.params.rkey as string);
	const authorProfilePath = $derived(resolve('/d/[did]', { did: routeDid }));
	const historyPath = $derived(
		resolve('/d/[did]/[rkey]/history', { did: routeDid, rkey: routeRkey })
	);
	const diffPath = $derived(resolve('/d/[did]/[rkey]/diff', { did: routeDid, rkey: routeRkey }));
	const editPath = $derived(resolve('/d/[did]/[rkey]/edit', { did: routeDid, rkey: routeRkey }));

	// Fold the flat comment list into threads (root + flat replies), then
	// partition by anchor. The doc-level bucket holds threads whose root has no
	// `line`; line groups are keyed by the root's line. Replies inherit the
	// root's anchor at render time regardless of what `line` their record
	// happens to carry — replies should never split off from their root.
	const allThreads = $derived(foldThreads(comments));

	const groupedThreads = $derived.by(() => {
		const docLevel: Thread[] = [];
		const byLine = new SvelteMap<number, Thread[]>();
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
		const out = new SvelteMap<string, LoadedResolution>();
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
		const out = new SvelteMap<string, LoadedResolution>();
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

	// Whether the signed-in user can apply a thread's suggestion right now.
	// Author-only, the thread root must carry a suggestion, and the anchor must
	// still resolve uniquely in the current body — otherwise an earlier apply
	// (or any edit) has perturbed the surrounding context and the user has to
	// fall back to applying by hand.
	function canApply(thread: Thread): boolean {
		const myDid = auth.did;
		if (!myDid || myDid !== documentAuthorDid) return false;
		const sugg = thread.root.value.suggestion;
		const body = loaded?.version?.value.body;
		if (!sugg || !body) return false;
		return findSuggestionAnchor(body, sugg) != null;
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

		const lineKeys = new SvelteSet<number>();
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
					// Prefer a sub-anchor (list item, table row, code line) when
					// one matches — the rail card should sit next to the specific
					// item, not the outer composite block. Fall back to the block
					// itself for non-composite lines.
					const anchor =
						article.querySelector<HTMLElement>(`.md-sub[data-md-line="${lineAttr}"]`) ??
						article.querySelector<HTMLElement>(`[data-md-line="${lineAttr}"]`);
					if (anchor) {
						desired = anchor.getBoundingClientRect().top - articleRect.top;
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

	// Sub-anchor [+] buttons are injected into the rendered HTML by
	// renderMarkdownBlocks, so they're outside Svelte's reactive scope.
	// Delegate clicks here: each button carries `data-md-add="<line>"`.
	$effect(() => {
		const article = articleEl;
		if (!article) return;
		const onClick = (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			const btn = target?.closest<HTMLElement>('.md-sub-btn');
			if (!btn) return;
			const lineStr = btn.dataset.mdAdd;
			if (lineStr == null) return;
			const lineNum = Number(lineStr);
			if (!Number.isFinite(lineNum)) return;
			e.preventDefault();
			tryOpenComposer(lineNum);
		};
		article.addEventListener('click', onClick);
		return () => article.removeEventListener('click', onClick);
	});

	// Sub-anchor [~] buttons mirror the [+] delegation above. Each button carries
	// `data-md-edit="<line>"`; sub-anchors are always single source line, so the
	// edit range is just that line.
	$effect(() => {
		const article = articleEl;
		if (!article) return;
		const onClick = (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			const btn = target?.closest<HTMLElement>('.md-sub-edit-btn');
			if (!btn) return;
			const lineStr = btn.dataset.mdEdit;
			if (lineStr == null) return;
			const lineNum = Number(lineStr);
			if (!Number.isFinite(lineNum)) return;
			e.preventDefault();
			tryOpenSuggestEdit(lineNum, lineNum);
		};
		article.addEventListener('click', onClick);
		return () => article.removeEventListener('click', onClick);
	});

	// ¶ permalink glyphs (both block-level and sub-anchor) carry
	// `data-md-link="<line>"` and an `href="#L<line>"`. Plain left-click is
	// intercepted to update the hash silently, copy the full URL, and pin a
	// highlight; modifier-clicks and middle-clicks fall through to the
	// browser's standard link handling so users can open in a new tab.
	$effect(() => {
		const article = articleEl;
		if (!article) return;
		const onClick = (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			const link = target?.closest<HTMLElement>('.md-link-btn');
			if (!link) return;
			if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
			const lineStr = link.dataset.mdLink;
			if (lineStr == null) return;
			const lineNum = Number(lineStr);
			if (!Number.isFinite(lineNum)) return;
			e.preventDefault();
			void copyLineLink(lineNum);
		};
		article.addEventListener('click', onClick);
		return () => article.removeEventListener('click', onClick);
	});

	// Pointer / focus delegation for the active-line cross-highlight. Walks
	// up from the event target to the closest `[data-md-line]`; that resolves
	// to a sub-anchor when inside one (e.g., a list item) and the surrounding
	// block otherwise. Replaces per-block onmouseenter/onfocusin so the
	// granularity matches the anchor the pointer is actually over.
	$effect(() => {
		const article = articleEl;
		if (!article) return;
		const resolveLine = (target: EventTarget | null): number | null => {
			const el = target as HTMLElement | null;
			const anchor = el?.closest<HTMLElement>('[data-md-line]');
			const v = anchor?.dataset.mdLine;
			return v != null ? Number(v) : null;
		};
		const onOver = (e: MouseEvent) => {
			const l = resolveLine(e.target);
			if (l != null) setActiveLine(l);
		};
		const onLeave = () => setActiveLine(null);
		const onFocusIn = (e: FocusEvent) => {
			const l = resolveLine(e.target);
			if (l != null) setActiveLine(l);
		};
		const onFocusOut = () => setActiveLine(null);
		article.addEventListener('mouseover', onOver);
		article.addEventListener('mouseleave', onLeave);
		article.addEventListener('focusin', onFocusIn);
		article.addEventListener('focusout', onFocusOut);
		return () => {
			article.removeEventListener('mouseover', onOver);
			article.removeEventListener('mouseleave', onLeave);
			article.removeEventListener('focusin', onFocusIn);
			article.removeEventListener('focusout', onFocusOut);
		};
	});

	// Mobile inline-thread portal. List blocks render per-sub-line inline-thread
	// elements (see the `block.kind === 'list'` branch in the markup) marked with
	// `data-portal-line`. This effect walks each one and re-parents it inside
	// the matching `li.md-sub[data-md-line="N"]` so the composer / thread sits
	// directly under the list item the user actually clicked, instead of
	// stranded at the bottom of a potentially-very-long list. Idempotent: skips
	// elements already inside their target. Only fires on mobile — the rail
	// handles spatial proximity via absolute positioning on desktop.
	$effect(() => {
		if (isRail) return;
		const article = articleEl;
		if (!article) return;
		// Track everything that can change the set of portal'd inline-threads.
		void composer;
		void suggestEdit;
		void expandedLines.size;
		void comments;
		void renderedBlocks;
		// Match anything carrying `data-portal-line`: inline-threads as before,
		// plus the inline suggest-editor when it opens on a list-item sub-anchor.
		const portals = article.querySelectorAll<HTMLElement>('[data-portal-line]');
		for (const portal of portals) {
			const lineStr = portal.dataset.portalLine;
			if (!lineStr) continue;
			// Sub-anchors for tables (<tr>) and code lines (<span>) can't host
			// block-level descendants cleanly, so the selector is `<li>`-only —
			// the inline-thread is then left at its rendered position for any
			// non-list composite that ever picks up `data-portal-line` later.
			const target = article.querySelector<HTMLElement>(`li.md-sub[data-md-line="${lineStr}"]`);
			if (!target) continue;
			if (portal.parentElement === target) continue;
			target.appendChild(portal);
		}
	});

	// Toggle .is-active on sub-anchors based on activeLine. .md-block uses
	// Svelte's `class:is-active`, but .md-sub elements live inside {@html}
	// and need imperative class management.
	$effect(() => {
		const article = articleEl;
		if (!article) return;
		const al = activeLine;
		const subs = article.querySelectorAll<HTMLElement>('.md-sub[data-md-line]');
		for (const el of subs) {
			const line = Number(el.dataset.mdLine);
			if (typeof al === 'number' && line === al) {
				el.classList.add('is-active');
			} else {
				el.classList.remove('is-active');
			}
		}
	});

	// Mirror of the is-active effect for permalink highlights. Kept separate so
	// the persistent `.is-linked` class doesn't toggle on every hover.
	$effect(() => {
		const article = articleEl;
		if (!article) return;
		const ll = linkedLine;
		const subs = article.querySelectorAll<HTMLElement>('.md-sub[data-md-line]');
		for (const el of subs) {
			const line = Number(el.dataset.mdLine);
			if (ll != null && line === ll) el.classList.add('is-linked');
			else el.classList.remove('is-linked');
		}
	});

	// First-paint hash handling: when the URL arrives with `#L<n>`, pin the
	// highlight and scroll to the matching block once the body has actually
	// rendered. Guarded so swapping documents (param change resets the flag)
	// gets a fresh chance, but successive renders of the same document don't.
	$effect(() => {
		if (didInitialHashScroll) return;
		const article = articleEl;
		if (!article || !loaded?.version) return;
		// `renderedBlocks` is what populates the DOM under articleEl — read it
		// here so this effect re-runs once the blocks land.
		if (renderedBlocks.length === 0) return;
		didInitialHashScroll = true;
		const match = window.location.hash.match(/^#L(\d+)$/);
		if (!match) return;
		const line = Number(match[1]);
		linkedLine = line;
		// One more frame so the imperative is-linked effect above has applied
		// classes before we measure for the scroll.
		requestAnimationFrame(() => scrollToLine(line, false));
	});

	// Sign-in screen lives at `/`. The OAuth flow redirects back there too,
	// so a signed-out user clicking a comment affordance lands on the form
	// rather than getting silently denied.
	function gotoSignIn() {
		void goto(resolve('/'));
	}

	function tryOpenComposer(line: number | null) {
		if (auth.status !== 'signed-in') {
			gotoSignIn();
			return;
		}
		openComposer(line);
	}

	function tryOpenReply(target: LoadedComment) {
		if (auth.status !== 'signed-in') {
			gotoSignIn();
			return;
		}
		openReply(target);
	}

	function openComposer(line: number | null) {
		// Two affordances can't share the same block-line: opening a comment
		// composer on a line that already has an inline suggest-editor open
		// dismisses the editor so it doesn't end up half-hidden behind the
		// composer card on mobile or compete for visual focus.
		if (line != null && suggestEdit && lineInRange(line, suggestEdit)) {
			suggestEdit = null;
			suggestError = null;
		}
		composer = { line, parent: null, replyToHandle: null };
		composerBody = '';
		composerError = null;
		// On mobile, expand the inline thread so the composer is visible. Sub-
		// anchor composers (e.g., on a specific list item) expand the parent
		// block — expandedLines is keyed by block start line.
		if (!isRail && line != null) {
			const blockLine = subToBlock.get(line) ?? line;
			expandedLines.add(blockLine);
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
			const blockLine = subToBlock.get(target.value.line) ?? target.value.line;
			expandedLines.add(blockLine);
		}
	}

	function closeComposer() {
		composer = null;
		composerBody = '';
		composerError = null;
	}

	// Inline suggest-edit. Two entry points — block-level (top-level paragraph,
	// heading, blockquote: edits the block's entire source range) and sub-anchor
	// (list item, code line, table row: edits exactly that one source line).
	// Single state shape handles both: startLine === endLine for the sub-anchor
	// case. Opens the editor, dismisses the comment composer if it was attached
	// to a line inside the same range so the two affordances don't overlap.
	function tryOpenSuggestEdit(startLine: number, endLine: number) {
		if (auth.status !== 'signed-in') {
			gotoSignIn();
			return;
		}
		openSuggestEdit(startLine, endLine);
	}

	function openSuggestEdit(startLine: number, endLine: number) {
		const body = loaded?.version?.value.body;
		if (!body) return;
		if (
			composer &&
			composer.line != null &&
			composer.line >= startLine &&
			composer.line <= endLine
		) {
			composer = null;
			composerBody = '';
			composerError = null;
		}
		const replacement = body
			.split('\n')
			.slice(startLine - 1, endLine)
			.join('\n');
		suggestEdit = { startLine, endLine, replacement };
		suggestError = null;
		// Mobile: expand the containing block so the swapped-in editor is in view.
		if (!isRail) {
			const blockLine = subToBlock.get(startLine) ?? startLine;
			expandedLines.add(blockLine);
		}
	}

	function closeSuggestEdit() {
		if (suggestPosting) return;
		suggestEdit = null;
		suggestError = null;
	}

	function onSuggestEditEscape() {
		closeSuggestEdit();
	}

	function lineInRange(line: number, range: { startLine: number; endLine: number }): boolean {
		return line >= range.startLine && line <= range.endLine;
	}

	function toggleResolvedExpand(rootUri: string) {
		if (expandedResolved.has(rootUri)) expandedResolved.delete(rootUri);
		else expandedResolved.add(rootUri);
	}

	async function resolveThread(thread: Thread) {
		const agent = auth.agent;
		const myDid = auth.did;
		const doc = loaded;
		if (!agent || !myDid || !doc) return;
		if (!canResolve(thread)) return;
		const rootUri = thread.root.uri;
		if (resolveBusy.has(rootUri)) return;
		resolveBusy.add(rootUri);
		resolveError.delete(rootUri);
		try {
			await createResolution(agent, myDid, { uri: thread.root.uri, cid: thread.root.cid }, doc.uri);
			await loadComments(doc, agent, myDid);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			resolveError.set(rootUri, msg);
		} finally {
			resolveBusy.delete(rootUri);
		}
	}

	// Author-only "Apply" for suggestion threads. Three steps, all on the
	// document author's repo: re-resolve the suggestion's text anchor against
	// the *current* body (so applying multiple suggestions composes — each
	// subsequent apply re-anchors against the updated body), saveNewVersion
	// with the patched body, and createResolution with `appliedIn` set so
	// readers can render "applied in <vN>" instead of plain "resolved". On
	// success we invalidateAll() to pick up the new currentVersion in the
	// page data and reload the comment list to surface the new resolution.
	async function applyThreadSuggestion(thread: Thread) {
		const agent = auth.agent;
		const myDid = auth.did;
		const doc = loaded;
		if (!agent || !myDid || !doc?.version) return;
		if (myDid !== doc.did) return; // author-only
		const sugg = thread.root.value.suggestion;
		if (!sugg) return;
		const rootUri = thread.root.uri;
		if (applyBusy.has(rootUri)) return;
		applyBusy.add(rootUri);
		applyError.delete(rootUri);
		try {
			const patched = applySuggestion(doc.version.value.body, sugg);
			const { versionUri, versionCid } = await saveNewVersion(agent, myDid, doc, patched);
			await createResolution(
				agent,
				myDid,
				{ uri: thread.root.uri, cid: thread.root.cid },
				doc.uri,
				{ appliedIn: { uri: versionUri, cid: versionCid } }
			);
			await invalidateAll();
		} catch (err) {
			applyError.set(rootUri, err instanceof Error ? err.message : String(err));
		} finally {
			applyBusy.delete(rootUri);
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
		resolveBusy.add(rootUri);
		resolveError.delete(rootUri);
		try {
			await deleteResolution(agent, myDid, mine.rkey);
			// Collapse the "expanded resolved" state for this thread on success,
			// so the next render shows the now-open thread normally.
			expandedResolved.delete(rootUri);
			await loadComments(doc, agent, myDid);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			resolveError.set(rootUri, msg);
		} finally {
			resolveBusy.delete(rootUri);
		}
	}

	function toggleLine(line: number) {
		if (expandedLines.has(line)) expandedLines.delete(line);
		else expandedLines.add(line);
	}

	function setActiveLine(line: number | null | 'doc') {
		activeLine = line;
	}

	function scrollToLine(line: number, smooth: boolean) {
		const article = articleEl;
		if (!article) return;
		// Prefer the most specific sub-anchor (list item, code line, table row)
		// over the surrounding block. Falls back to the block when the line
		// isn't a sub-anchor.
		const target =
			article.querySelector<HTMLElement>(`.md-sub[data-md-line="${line}"]`) ??
			article.querySelector<HTMLElement>(`[data-md-line="${line}"]`);
		if (!target) return;
		target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
	}

	function flash(msg: string) {
		flashMsg = msg;
		if (flashTimer != null) clearTimeout(flashTimer);
		flashTimer = window.setTimeout(() => {
			flashMsg = null;
			flashTimer = null;
		}, 1800);
	}

	async function copyLineLink(line: number) {
		// Build the full URL once so any later navigation doesn't change what we
		// hand to the clipboard mid-write.
		const url = `${window.location.origin}${window.location.pathname}#L${line}`;
		// `replaceState` keeps history clean — successive ¶ clicks shouldn't
		// pollute the back stack with one entry per line.
		history.replaceState(null, '', `#L${line}`);
		linkedLine = line;
		scrollToLine(line, true);
		try {
			await navigator.clipboard?.writeText(url);
			flash('Link copied');
		} catch {
			// Clipboard API may be unavailable (insecure context, permissions);
			// the URL bar still reflects the permalink, so this is non-fatal.
			flash('Permalink updated');
		}
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

	// Post the inline suggest-edit. Body is empty (the diff is the whole
	// payload); we anchor the suggestion against the current document body at
	// submit time so it survives intervening writes. The `line` field carries
	// the range's start so existing line-anchored UI (rail card positioning,
	// shift-tracking, etc.) lights up at the natural source location.
	async function postSuggestEdit() {
		const agent = auth.agent;
		const myDid = auth.did;
		const doc = loaded;
		const current = suggestEdit;
		if (suggestPosting) return;
		if (!agent || !myDid || !doc?.version || !current) return;

		const lines = doc.version.value.body.split('\n');
		const original = lines.slice(current.startLine - 1, current.endLine).join('\n');
		if (current.replacement === original) {
			suggestError = 'Suggested edit is identical to the original.';
			return;
		}

		suggestPosting = true;
		suggestError = null;
		try {
			const suggestion = buildSuggestionAnchor(
				doc.version.value.body,
				current.startLine,
				current.replacement,
				current.endLine
			);
			await createComment(
				agent,
				myDid,
				{
					documentUri: doc.uri,
					version: { uri: doc.version.uri, cid: doc.version.cid }
				},
				'',
				{ line: current.startLine, suggestion }
			);
			suggestEdit = null;
			suggestError = null;
			await loadComments(doc, agent, myDid);
		} catch (err) {
			suggestError = err instanceof Error ? err.message : String(err);
		} finally {
			suggestPosting = false;
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
		<title>{loaded.value.title} — Requested</title>
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
	<div class="doc-shell">
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
									<a href={authorProfilePath} class="author-link">{authorHandle}</a>
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
					<a class="action" href={historyPath}>[ history ]</a>
					<a class="action" href={diffPath}>[ diff ]</a>
					{#if isOwner}
						<a class="action" href={editPath}> [ edit ] </a>
					{/if}
				</nav>
			</header>

			<div class="prose">
				{#each renderedBlocks as block, i (i)}
					{@const blockAllLines = [block.line, ...block.subLines]}
					{@const blockLineGroups = groupedThreads.lineGroups.filter(([l]) =>
						blockAllLines.includes(l)
					)}
					{@const blockCommentCount = blockLineGroups.reduce(
						(acc, [, threads]) => acc + threads.reduce((a, t) => a + 1 + t.replies.length, 0),
						0
					)}
					{@const hasSubAnchors = block.subLines.length > 0}
					{@const isActive = activeLine === block.line}
					{@const composerInBlock =
						composer != null &&
						composer.line != null &&
						blockAllLines.includes(composer.line) &&
						composer.parent == null}
					{@const blockBeingEdited =
						!hasSubAnchors &&
						suggestEdit != null &&
						suggestEdit.startLine === block.line &&
						suggestEdit.endLine === block.endLine}
					<div
						class="md-block"
						class:has-comments={blockCommentCount > 0}
						class:has-sub-anchors={hasSubAnchors}
						class:is-active={isActive && !hasSubAnchors && !blockBeingEdited}
						class:is-linked={linkedLine === block.line && !hasSubAnchors && !blockBeingEdited}
						class:is-editing={blockBeingEdited}
						data-md-line={hasSubAnchors ? null : block.line}
					>
						{#if blockCommentCount > 0 && isRail && !hasSubAnchors && !blockBeingEdited}
							<span class="md-comment-count" aria-hidden="true">
								[{blockCommentCount}]
							</span>
						{/if}
						{#if !hasSubAnchors && !blockBeingEdited}
							<a
								class="md-link-btn"
								href={`#L${block.line}`}
								data-md-link={block.line}
								tabindex="-1"
								aria-label={`Link to line ${block.line}`}
								title={`Copy link to line ${block.line}`}
							>
								¶
							</a>
							<button
								type="button"
								class="md-comment-btn"
								aria-label={auth.status === 'signed-in'
									? `Add comment on line ${block.line}`
									: `Sign in to comment on line ${block.line}`}
								title={auth.status === 'signed-in'
									? `Comment on line ${block.line}`
									: 'Sign in to comment'}
								onclick={() => tryOpenComposer(block.line)}
							>
								[+]
							</button>
							<button
								type="button"
								class="md-edit-btn"
								aria-label={auth.status === 'signed-in'
									? `Suggest an edit starting at line ${block.line}`
									: `Sign in to suggest an edit at line ${block.line}`}
								title={auth.status === 'signed-in'
									? `Suggest an edit`
									: 'Sign in to suggest an edit'}
								onclick={() => tryOpenSuggestEdit(block.line, block.endLine)}
							>
								[~]
							</button>
						{/if}
						{#if blockBeingEdited}
							{@render inlineSuggestEditor()}
						{:else}
							<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by DOMPurify in renderMarkdown -->
							{@html block.html}
						{/if}
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
						{#if hasSubAnchors && suggestEdit && blockAllLines.includes(suggestEdit.startLine) && suggestEdit.startLine === suggestEdit.endLine}
							<!-- Sub-anchor suggest-edit (inside list / table / code). The portal
							     effect re-parents this div into the matching <li> on mobile-list
							     blocks; for tables, code, and desktop it stays at its rendered
							     position underneath the block. -->
							<div class="suggest-edit-portal" data-portal-line={suggestEdit.startLine}>
								{@render inlineSuggestEditor()}
							</div>
						{/if}
						{#if !isRail && block.kind === 'list'}
							<!-- List blocks render one inline-thread per affected sub-line so that
							     the portal effect (see articleEl effect block) can move each one
							     inside its matching `<li class="md-sub" data-md-line="N">`. Until
							     the effect runs (or for sub-lines whose `<li>` isn't found), the
							     thread stays here at the end of the block — same as it was before
							     the portal was added. -->
							{#each block.subLines as subLine (subLine)}
								{@const subThreads = blockLineGroups.find(([l]) => l === subLine)?.[1] ?? []}
								{@const showComposer =
									composer != null && composer.line === subLine && composer.parent == null}
								{@const showThreads = expandedLines.has(block.line) && subThreads.length > 0}
								{#if showThreads || showComposer}
									<div class="inline-thread" data-portal-line={subLine}>
										{#if showThreads}
											{@render lineHeader(subLine, subThreads[0].root)}
											{#each subThreads as thread (thread.root.uri)}
												{@render threadInline(thread)}
											{/each}
										{/if}
										{#if showComposer}
											{@render inlineComposer()}
										{/if}
									</div>
								{/if}
							{/each}
						{:else if !isRail && expandedLines.has(block.line) && blockLineGroups.length > 0}
							<div class="inline-thread">
								{#each blockLineGroups as [groupLine, threads] (groupLine)}
									{@render lineHeader(groupLine, threads[0].root)}
									{#each threads as thread (thread.root.uri)}
										{@render threadInline(thread)}
									{/each}
									{#if composer && composer.line === groupLine && composer.parent == null}
										{@render inlineComposer()}
									{/if}
								{/each}
								{#if composerInBlock && !blockLineGroups.some(([l]) => l === composer?.line)}
									{@render inlineComposer()}
								{/if}
							</div>
						{:else if !isRail && composerInBlock}
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
					{#if !(composer?.line == null && composer !== null)}
						<button type="button" class="rail-doc-btn" onclick={() => tryOpenComposer(null)}>
							{auth.status === 'signed-in' ? '[ comment on document ]' : '[ sign in to comment ]'}
						</button>
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
				{#if composer?.line !== null}
					<button type="button" class="bracket-btn" onclick={() => tryOpenComposer(null)}>
						{auth.status === 'signed-in' ? '[ comment on document ]' : '[ sign in to comment ]'}
					</button>
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

{#if flashMsg}
	<div class="link-flash" role="status" aria-live="polite">{flashMsg}</div>
{/if}

{#snippet inlineSuggestEditor()}
	{#if suggestEdit}
		{@const isRange = suggestEdit.startLine !== suggestEdit.endLine}
		<form
			class="suggest-edit"
			onsubmit={(e) => {
				e.preventDefault();
				void postSuggestEdit();
			}}
		>
			<header class="suggest-edit-header">
				<span class="anchor-tag anchor-tag-suggest">edit</span>
				<span class="suggest-edit-target">
					{#if isRange}
						Editing source lines {suggestEdit.startLine}–{suggestEdit.endLine}
					{:else}
						Editing source line {suggestEdit.startLine}
					{/if}
				</span>
				<span class="suggest-edit-hint">⌘↩ to post · esc to cancel</span>
			</header>
			<CommentEditor
				bind:value={suggestEdit.replacement}
				placeholder="Edit the markdown source for this line"
				onEscape={onSuggestEditEscape}
				onSubmit={postSuggestEdit}
			/>
			{#if suggestError}
				<p class="error suggest-edit-error">{suggestError}</p>
			{/if}
			<div class="suggest-edit-actions">
				<button
					type="button"
					class="bracket-btn"
					onclick={closeSuggestEdit}
					disabled={suggestPosting}
				>
					[ cancel ]
				</button>
				<button type="submit" class="bracket-btn bracket-btn-primary" disabled={suggestPosting}>
					{suggestPosting ? '[ posting… ]' : '[ post suggestion ]'}
				</button>
			</div>
		</form>
	{/if}
{/snippet}

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
		<CommentEditor
			bind:value={composerBody}
			placeholder="Write a comment in markdown…"
			onEscape={onComposerEscape}
			onSubmit={postComment}
		/>
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
					{resolution.value.appliedIn ? 'Applied by' : 'Resolved by'}
					<strong>@{resolverProfile?.handle ?? resolution.did}</strong>
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
						{resolution.value.appliedIn ? 'Applied by' : 'Resolved by'}
						<strong>@{resolverProfile?.handle ?? resolution.did}</strong>
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
				{@const applying = applyBusy.has(thread.root.uri)}
				{@const applyErr = applyError.get(thread.root.uri)}
				{@const showApply = thread.root.value.suggestion != null && canApply(thread)}
				<div class="comment-actions">
					{#if showApply}
						<button
							type="button"
							class="bracket-btn bracket-btn-sm bracket-btn-primary"
							disabled={applying}
							onclick={() => applyThreadSuggestion(thread)}
						>
							{applying ? '[ applying… ]' : '[ apply suggestion ]'}
						</button>
					{/if}
					<button
						type="button"
						class="bracket-btn bracket-btn-sm"
						onclick={() => tryOpenReply(thread.root)}
					>
						{auth.status === 'signed-in' ? '[ reply ]' : '[ sign in to reply ]'}
					</button>
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
					{#if applyErr}
						<span class="error inline-error">{applyErr}</span>
					{/if}
				</div>
			{/if}
			{#if composer && composer.parent?.uri === thread.root.uri}
				{@render inlineComposer()}
			{/if}
			{#each thread.replies as r (r.uri)}
				{@render commentCard(r, false, isResolved)}
				{#if !isResolved}
					<div class="comment-actions reply-actions">
						<button
							type="button"
							class="bracket-btn bracket-btn-sm"
							onclick={() => tryOpenReply(r)}
						>
							{auth.status === 'signed-in' ? '[ reply ]' : '[ sign in to reply ]'}
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

{#snippet suggestionDiff(sugg: CommentSuggestion)}
	<div class="suggestion-diff" aria-label="Suggested edit">
		<div class="suggestion-row suggestion-row-from">
			<span class="suggestion-mark" aria-hidden="true">−</span>
			<code class="suggestion-text">{sugg.target || '(empty line)'}</code>
		</div>
		<div class="suggestion-row suggestion-row-to">
			<span class="suggestion-mark" aria-hidden="true">+</span>
			<code class="suggestion-text">{sugg.replacement || '(deletion)'}</code>
		</div>
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
			{#if c.value.suggestion}
				<span class="suggestion-badge">suggested edit</span>
			{/if}
			{#if state && state.kind !== 'current'}
				<span class="stale-note">on earlier version</span>
			{/if}
		</div>
		{#if c.value.suggestion}
			{@render suggestionDiff(c.value.suggestion)}
		{/if}
		<div class="comment-body prose prose-sm">
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by DOMPurify in renderMarkdown -->
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
					{resolution.value.appliedIn ? 'Applied by' : 'Resolved by'}
					<strong>@{resolverProfile?.handle ?? resolution.did}</strong>
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
						{resolution.value.appliedIn ? 'Applied by' : 'Resolved by'}
						<strong>@{resolverProfile?.handle ?? resolution.did}</strong>
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
				{@const applying = applyBusy.has(thread.root.uri)}
				{@const applyErr = applyError.get(thread.root.uri)}
				{@const showApply = thread.root.value.suggestion != null && canApply(thread)}
				<div class="comment-actions rail-actions">
					{#if showApply}
						<button
							type="button"
							class="bracket-btn bracket-btn-sm bracket-btn-primary"
							disabled={applying}
							onclick={() => applyThreadSuggestion(thread)}
						>
							{applying ? '[ applying… ]' : '[ apply suggestion ]'}
						</button>
					{/if}
					<button
						type="button"
						class="bracket-btn bracket-btn-sm"
						onclick={() => tryOpenReply(thread.root)}
					>
						{auth.status === 'signed-in' ? '[ reply ]' : '[ sign in to reply ]'}
					</button>
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
					{#if applyErr}
						<span class="error inline-error">{applyErr}</span>
					{/if}
				</div>
			{/if}
			{#if composer && composer.parent?.uri === thread.root.uri}
				{@render inlineComposer()}
			{/if}
			{#each thread.replies as r (r.uri)}
				{@render commentBody(r, false, isResolved)}
				{#if !isResolved}
					<div class="comment-actions rail-actions reply-actions">
						<button
							type="button"
							class="bracket-btn bracket-btn-sm"
							onclick={() => tryOpenReply(r)}
						>
							{auth.status === 'signed-in' ? '[ reply ]' : '[ sign in to reply ]'}
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
			{#if c.value.suggestion}
				<span class="suggestion-badge">suggested edit</span>
			{/if}
			{#if state && state.kind !== 'current'}
				<span class="stale-note">on earlier version</span>
			{/if}
		</div>
		{#if c.value.suggestion}
			{@render suggestionDiff(c.value.suggestion)}
		{/if}
		<div class="rail-comment-body prose prose-sm">
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by DOMPurify in renderMarkdown -->
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
	/* Reserve the rail column from first paint via a CSS media query that
	   mirrors the JS breakpoint in onMount. The grid is set up before the
	   `<aside class="rail">` mounts and before comments arrive, so the
	   article column doesn't reflow when either lands. */
	@media (min-width: 1200px) {
		.doc-shell {
			max-width: calc(var(--col-body) + var(--space-7) + var(--rail-width));
			display: grid;
			grid-template-columns: minmax(0, var(--col-body)) var(--rail-width);
			column-gap: var(--space-7);
			align-items: start;
		}
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
		padding-bottom: var(--space-2);
		border-bottom: var(--border-thin) solid var(--rule);
	}
	/* The doc title is rendered as an `<h1>` outside `.prose` by the page
	   header, so prose body sections conventionally start at `##` and the
	   counter scheme tracks that. Authors who use `#` in the body get a
	   styled but unnumbered heading. */
	.prose :global(h2) {
		font-size: var(--text-xl);
		counter-reset: sub;
	}
	.prose :global(h2::before) {
		content: counter(section) '. ';
		counter-increment: section;
		color: var(--ink-3);
		margin-right: 0.5ch;
	}
	.prose :global(h3) {
		font-size: var(--text-lg);
		counter-reset: subsub;
	}
	.prose :global(h3::before) {
		content: counter(section) '.' counter(sub) '. ';
		counter-increment: sub;
		color: var(--ink-3);
		margin-right: 0.5ch;
	}
	.prose :global(h4) {
		font-size: var(--text-md);
		color: var(--ink-2);
	}
	.prose :global(h4::before) {
		content: counter(section) '.' counter(sub) '.' counter(subsub) '. ';
		counter-increment: subsub;
		color: var(--ink-3);
		margin-right: 0.5ch;
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
		/* Let the table scroll horizontally within its own box on narrow
		   viewports instead of pushing the whole page sideways. `display: block`
		   keeps the rendered table layout intact via anonymous table boxes. */
		display: block;
		overflow-x: auto;
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
	/* Permalink target — persistent until the user navigates away. An
	   inset accent rail on the left makes the highlight distinguishable
	   from the hover/cross-highlight is-active treatment. */
	.prose :global(.md-block.is-linked) {
		background: color-mix(in oklch, var(--accent-fade) 45%, transparent);
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.prose :global(.md-block.is-active.is-linked) {
		background: color-mix(in oklch, var(--accent-fade) 80%, transparent);
	}
	.prose :global(.md-comment-btn) {
		position: absolute;
		left: -3.5rem;
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

	/* Block-level [~] suggest-edit trigger. Sits to the right of [+] in the
	   gutter, completing the ¶/[+]/[~] row. Hover-revealed identically to its
	   siblings; tinted toward `--addition` on hover so the action-type maps to
	   color (matching the `.suggestion-badge` border + the accent rail on the
	   editor frame). */
	.prose :global(.md-edit-btn) {
		position: absolute;
		left: -1.5rem;
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
	.prose :global(.md-block:hover > .md-edit-btn),
	.prose :global(.md-edit-btn:focus-visible) {
		opacity: 1;
	}
	.prose :global(.md-edit-btn:hover) {
		color: var(--addition);
	}

	/* Permalink glyph ¶. Sits tight to the left of [+] so the pair reads as
	   one gutter unit. Matches [+]'s font + size for a shared baseline;
	   `width: 1ch` gives the glyph a consistent column edge that visually
	   aligns with the brackets on [+]. Line-height is left to inherit from
	   .prose (leading-body) — [+] is a <button> with `font: inherit` in
	   base.css, so any explicit line-height here would desync the line-box
	   and push ¶ off the [+] baseline. Visible to signed-out viewers too —
	   sharing is always public. */
	.prose :global(.md-link-btn) {
		position: absolute;
		left: -5rem;
		top: 0.1em;
		width: 1ch;
		text-align: center;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		letter-spacing: var(--track-tight);
		color: var(--ink-3);
		text-decoration: none;
		opacity: 0;
		transition:
			opacity var(--dur-fast) var(--ease-out-quart),
			color var(--dur-fast) var(--ease-out-quart);
	}
	.prose :global(.md-block:hover > .md-link-btn),
	.prose :global(.md-link-btn:focus-visible) {
		opacity: 1;
	}
	.prose :global(.md-link-btn:hover) {
		color: var(--accent);
	}
	/* Linked block: keep the ¶ glyph visible at low contrast so the reader
	   can see which anchor the permalink resolved to without hovering. */
	.prose :global(.md-block.is-linked > .md-link-btn) {
		opacity: 0.7;
		color: var(--accent);
	}

	/* Persistent gutter count: when a block has comments, show [N] in the left
	   gutter so the body itself signals where comments live. Rail-mode only —
	   inline mode already has .line-chip. The [+] action button drops below
	   the count when both are present, so they never collide. */
	.prose :global(.md-comment-count) {
		position: absolute;
		left: -3.5rem;
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
	/* When a block carries comments, the persistent [N] count sits in the
	   [+]/[~] gutter slot. Drop both action buttons one row so the trio reads
	   as `¶ [N]` over `[+] [~]` instead of letting [~] sit alongside the count
	   while [+] hangs alone below. */
	@media (min-width: 1200px) {
		.doc-shell .prose :global(.md-block.has-comments > .md-comment-btn),
		.doc-shell .prose :global(.md-block.has-comments > .md-edit-btn) {
			top: 1.4em;
		}
	}

	/* --- Sub-anchor affordances ---
	   List items, table rows, and code-block lines are emitted by
	   renderMarkdownBlocks with `.md-sub` + `[data-md-line]`. Each carries an
	   injected [+] button with the same hover-revealed gutter treatment as the
	   block-level [+]. Authorization is gated via `.prose.can-comment`: when
	   the viewer can't comment, every per-line [+] (sub-anchor or block) is
	   hidden. The cross-highlight `.is-active` is toggled imperatively from
	   the page effect (sub-anchors live inside {@html} and are out of Svelte's
	   reactive scope). */

	.prose :global(.md-sub) {
		transition: background var(--dur-mid) var(--ease-out-quart);
	}
	.prose :global(li.md-sub) {
		position: relative;
	}
	/* `.md-code-line` is intentionally NOT positioned: its buttons need to
	   anchor against `.md-block` (the next positioned ancestor, *outside* of
	   `<pre>`) so they aren't clipped by `<pre>`'s `overflow-x: auto`. */
	.prose :global(li.md-sub.is-active),
	.prose :global(.md-code-line.is-active) {
		background: color-mix(in oklch, var(--accent-fade) 60%, transparent);
	}
	.prose :global(tr.md-sub.is-active) {
		background: color-mix(in oklch, var(--accent-fade) 60%, transparent);
	}
	/* Permalink target on sub-anchors. Same treatment as the block-level
	   .is-linked: persistent highlight plus an inset accent rail (rendered
	   via box-shadow so it doesn't shift layout). */
	.prose :global(li.md-sub.is-linked),
	.prose :global(.md-code-line.is-linked) {
		background: color-mix(in oklch, var(--accent-fade) 45%, transparent);
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.prose :global(tr.md-sub.is-linked) {
		background: color-mix(in oklch, var(--accent-fade) 45%, transparent);
	}
	.prose :global(tr.md-sub.is-linked > td:first-child),
	.prose :global(tr.md-sub.is-linked > th:first-child) {
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.prose :global(li.md-sub.is-active.is-linked),
	.prose :global(.md-code-line.is-active.is-linked),
	.prose :global(tr.md-sub.is-active.is-linked) {
		background: color-mix(in oklch, var(--accent-fade) 80%, transparent);
	}

	.prose :global(.md-sub-btn) {
		position: absolute;
		left: -3.5rem;
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
	.prose :global(.md-sub:hover > .md-sub-btn),
	.prose :global(.md-sub-btn:focus-visible) {
		opacity: 1;
	}
	/* Table cells host the [+] for their row — surface it on row hover too. */
	.prose :global(tr.md-sub:hover .md-sub-btn) {
		opacity: 1;
	}
	.prose :global(.md-sub-btn:hover) {
		color: var(--accent);
	}

	/* Sub-anchor [~] — mirrors .md-sub-btn (the [+] sibling) at the third
	   gutter slot. Same visibility rules; addition-tinted hover. */
	.prose :global(.md-sub-edit-btn) {
		position: absolute;
		left: -1.5rem;
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
	.prose :global(.md-sub:hover > .md-sub-edit-btn),
	.prose :global(.md-sub-edit-btn:focus-visible) {
		opacity: 1;
	}
	.prose :global(tr.md-sub:hover .md-sub-edit-btn) {
		opacity: 1;
	}
	.prose :global(.md-sub-edit-btn:hover) {
		color: var(--addition);
	}

	/* Sub-anchor ¶ — mirrors .md-link-btn block-level positioning and shares
	   font + size with the [+] sub-btn so the pair sits on a single baseline.
	   See .md-link-btn for the note on inherited line-height. Visible to
	   signed-out viewers too. */
	.prose :global(.md-sub-link) {
		position: absolute;
		left: -5rem;
		top: 0.1em;
		width: 1ch;
		text-align: center;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		letter-spacing: var(--track-tight);
		color: var(--ink-3);
		text-decoration: none;
		opacity: 0;
		transition:
			opacity var(--dur-fast) var(--ease-out-quart),
			color var(--dur-fast) var(--ease-out-quart);
	}
	.prose :global(.md-sub:hover > .md-sub-link),
	.prose :global(.md-sub-link:focus-visible) {
		opacity: 1;
	}
	.prose :global(tr.md-sub:hover .md-sub-link) {
		opacity: 1;
	}
	.prose :global(.md-sub-link:hover) {
		color: var(--accent);
	}
	.prose :global(.md-sub.is-linked > .md-sub-link) {
		opacity: 0.7;
		color: var(--accent);
	}

	/* Table-row [+]: lives inside the first cell because <tr> isn't a reliable
	   containing block for absolute positioning. Push past the cell's left
	   padding so the button lands in the gutter outside the table. */
	.prose :global(tr.md-sub > td:first-child > .md-sub-btn),
	.prose :global(tr.md-sub > th:first-child > .md-sub-btn) {
		left: calc(-1 * var(--space-3) - 3.5rem);
		top: 50%;
		transform: translateY(-50%);
	}
	/* Table-row [~] — same `inside the first cell` trick, but offset for the
	   third gutter slot. */
	.prose :global(tr.md-sub > td:first-child > .md-sub-edit-btn),
	.prose :global(tr.md-sub > th:first-child > .md-sub-edit-btn) {
		left: calc(-1 * var(--space-3) - 1.5rem);
		top: 50%;
		transform: translateY(-50%);
	}
	/* Same trick for the ¶ glyph — seats just outside the row [+]. */
	.prose :global(tr.md-sub > td:first-child > .md-sub-link),
	.prose :global(tr.md-sub > th:first-child > .md-sub-link) {
		left: calc(-1 * var(--space-3) - 5rem);
		top: 50%;
		transform: translateY(-50%);
	}

	/* List-item sub-anchor buttons: `li.md-sub` is `position: relative`, so the
	   shared `.md-sub-link/.md-sub-btn/.md-sub-edit-btn` positions resolve
	   against the LI's content box, not `.md-block`. That's one UL padding-left
	   (~2.5ch) further right than the block-level buttons, which pushes [~]
	   into the area where the list marker (bullet / number) sits. Shift each
	   sub-anchor button on a list item one extra `1.5rem` left so it lands in
	   the md-block gutter alongside the block-level trio, clearing the marker. */
	.prose :global(li.md-sub > .md-sub-link) {
		left: -6.5rem;
	}
	.prose :global(li.md-sub > .md-sub-btn) {
		left: -5rem;
	}
	.prose :global(li.md-sub > .md-sub-edit-btn) {
		left: -3rem;
	}

	/* Code-block lines are <span class="md-sub md-code-line"> rendered inside
	   <pre>. display:block makes each one its own row; whitespace inside <pre>
	   already preserves the leading indentation in the text content. The [+]
	   sits in the article gutter alongside the block-level [+] — positioned
	   against `.md-block` (not `.md-code-line`) so `<pre>`'s `overflow-x: auto`
	   doesn't clip it. `--md-li` is the line's 0-based index (set inline by
	   `renderMarkdownBlocks`); the `top` is `<pre>`'s padding-top plus that
	   index times `<pre>`'s line height (0.9 × body font × 1.5). */
	.prose :global(.md-code-line) {
		display: block;
	}
	.prose :global(.md-code-line > .md-sub-btn),
	.prose :global(.md-code-line > .md-sub-link),
	.prose :global(.md-code-line > .md-sub-edit-btn) {
		top: calc(var(--space-3) + var(--md-li, 0) * 0.9 * var(--text-base) * 1.5);
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
	/* SSR renders this section because `isRail` starts as false (no viewport
	   available on the server). On desktop the CSS-driven grid above hides
	   it pre-hydration, so when `isRail` flips true in onMount and Svelte
	   removes it from the DOM, nothing shifts. */
	@media (min-width: 1200px) {
		.doc-comments {
			display: none;
		}
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
	   bleed in: large/bold text plus a `1.1.`-style section counter from
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
		/* Block-level affordances on mobile: position absolutely at the top of
		   the block so they don't add a line-box (which on desktop the negative
		   gutter avoids by hover-hiding). .md-block gets a small padding-top to
		   (a) reserve room for the buttons and (b) break margin-collapse — without
		   padding/border, h2's --space-7 margin-top would collapse straight
		   through the empty .md-block, leaving buttons stranded far above the
		   heading. h2/h3/h4 margin-top is also tightened on mobile since the
		   padding-top now provides the section-break breathing room. */
		.prose :global(.md-block) {
			padding-top: 1.4em;
		}
		.prose :global(.md-link-btn),
		.prose :global(.md-comment-btn),
		.prose :global(.md-edit-btn) {
			position: absolute;
			top: 0;
			line-height: 1;
			width: auto;
			opacity: 0.5;
			margin: 0;
			transform: none;
		}
		.prose :global(.md-link-btn) {
			left: 0;
		}
		.prose :global(.md-comment-btn) {
			left: 2em;
		}
		.prose :global(.md-edit-btn) {
			left: 4.5em;
		}
		.prose :global(h2),
		.prose :global(h3),
		.prose :global(h4) {
			margin-top: var(--space-4);
		}
		.prose :global(.md-sub-btn),
		.prose :global(.md-sub-link),
		.prose :global(.md-sub-edit-btn) {
			line-height: 1;
			opacity: 0.5;
			transform: none;
		}
		/* Table-row sub-anchors: desktop offsets them into the negative gutter
		   (left: calc(-1 * var(--space-3) - 3rem)), which is off-screen on mobile
		   since there's no left margin. Pull them inside the first cell instead. */
		.prose :global(tr.md-sub > td:first-child > .md-sub-btn),
		.prose :global(tr.md-sub > th:first-child > .md-sub-btn) {
			left: 2em;
		}
		.prose :global(tr.md-sub > td:first-child > .md-sub-link),
		.prose :global(tr.md-sub > th:first-child > .md-sub-link) {
			left: 0;
		}
		.prose :global(tr.md-sub > td:first-child > .md-sub-edit-btn),
		.prose :global(tr.md-sub > th:first-child > .md-sub-edit-btn) {
			left: 4.5em;
		}
		/* List items and code lines wrap text and live inside their own line
		   element, so the inline static placement above puts [+]/¶ on the same
		   visual line as the first character. Reserve space above each row and
		   absolutely position the buttons there so they land *above* the line
		   instead — matching the paragraph case. Buttons use `left: 0` so they
		   sit inside the row (important for code, where `<pre>`'s `overflow-x`
		   would clip anything in the negative gutter). `.md-code-line` is
		   re-promoted to a positioning context here: desktop deliberately leaves
		   it static so buttons anchor to `.md-block`, but mobile positions them
		   inside the line's own padding, so the line needs to be the CB. */
		.prose :global(li.md-sub),
		.prose :global(.md-code-line) {
			padding-top: 1.2em;
		}
		.prose :global(.md-code-line) {
			position: relative;
		}
		.prose :global(li.md-sub > .md-sub-link),
		.prose :global(li.md-sub > .md-sub-btn),
		.prose :global(li.md-sub > .md-sub-edit-btn),
		.prose :global(.md-code-line > .md-sub-link),
		.prose :global(.md-code-line > .md-sub-btn),
		.prose :global(.md-code-line > .md-sub-edit-btn) {
			position: absolute;
			top: 0;
			margin-right: 0;
		}
		.prose :global(li.md-sub > .md-sub-link),
		.prose :global(.md-code-line > .md-sub-link) {
			left: 0;
		}
		.prose :global(li.md-sub > .md-sub-btn),
		.prose :global(.md-code-line > .md-sub-btn) {
			left: 2em;
		}
		.prose :global(li.md-sub > .md-sub-edit-btn),
		.prose :global(.md-code-line > .md-sub-edit-btn) {
			left: 4.5em;
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

	/* Permalink flash toast. Lives at viewport-bottom on a short timer; the
	   subtle slide-up + fade keeps it out of the user's main task area while
	   still confirming the clipboard write. */
	.link-flash {
		position: fixed;
		bottom: var(--space-5);
		left: 50%;
		transform: translateX(-50%);
		padding: var(--space-2) var(--space-4);
		background: var(--ink);
		color: var(--surface);
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		letter-spacing: var(--track-tight);
		border: var(--border-thin) solid var(--rule-strong);
		box-shadow: 0 4px 12px rgb(0 0 0 / 0.18);
		z-index: 10;
		pointer-events: none;
		animation: flash-in var(--dur-mid) var(--ease-out-quart);
	}
	@keyframes flash-in {
		from {
			opacity: 0;
			transform: translate(-50%, 6px);
		}
		to {
			opacity: 1;
			transform: translate(-50%, 0);
		}
	}

	/* --- Suggested edits ---
	   A "suggestion" is a comment that carries a textual replacement anchored
	   by surrounding context. Visually it reads as a two-row diff (− original,
	   + replacement) sandwiched between the comment meta and the body. The
	   author sees an extra [ apply suggestion ] action when the anchor still
	   matches the current document; everyone else just reads the diff. */

	.suggestion-badge {
		font-size: var(--text-2xs);
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
		padding: 1px 6px;
		border: var(--border-thin) solid var(--addition);
		color: var(--addition);
		font-style: normal;
		font-weight: 500;
	}
	.comment-meta .suggestion-badge::before,
	.rail-comment-meta .suggestion-badge::before {
		content: '· ';
		color: var(--ink-4);
		margin-right: 4px;
	}

	.suggestion-diff {
		display: flex;
		flex-direction: column;
		margin: var(--space-2) 0 var(--space-3);
		border: var(--border-thin) solid var(--rule);
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		line-height: var(--leading-snug);
		overflow: hidden;
	}
	.suggestion-row {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		padding: 4px var(--space-3);
		min-width: 0;
	}
	.suggestion-row-from {
		background: var(--deletion-fade);
		color: var(--ink);
		border-bottom: var(--border-thin) solid var(--rule);
	}
	.suggestion-row-to {
		background: var(--addition-fade);
		color: var(--ink);
	}
	.suggestion-mark {
		flex: 0 0 1ch;
		font-weight: 700;
		user-select: none;
		text-align: center;
	}
	.suggestion-row-from .suggestion-mark {
		color: var(--deletion);
	}
	.suggestion-row-to .suggestion-mark {
		color: var(--addition);
	}
	.suggestion-text {
		flex: 1 1 auto;
		min-width: 0;
		background: transparent;
		border: 0;
		padding: 0;
		white-space: pre-wrap;
		word-break: break-word;
		letter-spacing: var(--track-tight);
	}

	/* --- Inline suggest-edit ---
	   Click `[~]` on a top-level block: the block's rendered HTML swaps for a
	   CodeMirror editor preloaded with the raw source. Click `[~]` on a sub-
	   anchor (li, tr, code line): an editor appears next to the line via the
	   `data-portal-line` mechanism shared with inline-threads. Posting writes a
	   `fyi.requested.comment` with a `suggestion` anchor and an empty body —
	   the diff is the whole payload, no accompanying note. */
	.anchor-tag-suggest {
		border-color: var(--addition);
		color: var(--addition);
	}

	.suggest-edit {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-3) var(--space-4);
		background: var(--surface-raised);
		border: var(--border-thin) solid var(--rule-strong);
		box-shadow: inset 2px 0 0 var(--addition);
	}
	.md-block.is-editing > .suggest-edit {
		margin: var(--space-2) calc(-1 * var(--space-2));
	}
	.suggest-edit-header {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-3);
		font-size: var(--text-xs);
	}
	.suggest-edit-target {
		color: var(--ink-2);
		font-family: var(--font-mono);
		letter-spacing: var(--track-tight);
	}
	.suggest-edit-hint {
		margin-left: auto;
		color: var(--ink-4);
		font-family: var(--font-mono);
		font-size: var(--text-2xs);
		letter-spacing: var(--track-caps);
		text-transform: uppercase;
	}
	@media (max-width: 720px) {
		.suggest-edit-hint {
			display: none;
		}
	}
	.suggest-edit-error {
		font-size: var(--text-xs);
		margin: 0;
	}
	.suggest-edit-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		justify-content: flex-end;
	}

	/* Editing state on the host block: drop the hover-affordance gutter
	   buttons (the trigger row), but keep the block-level layout otherwise.
	   The accent-rail inside .suggest-edit reads as the gutter mark. */
	.prose :global(.md-block.is-editing) {
		background: transparent;
	}

	/* Sub-anchor host: when portaled into an <li>, the editor inherits list
	   indentation; pull it left a touch so it lines up under the item's text
	   rather than under the bullet's text indent. When NOT portaled (tables,
	   code, desktop rail mode), it sits below the composite block as a normal
	   block-level child. */
	.suggest-edit-portal {
		margin-top: var(--space-3);
	}
	/* Wrapped in :global because the portal effect re-parents .suggest-edit-portal
	   into an <li> rendered inside {@html}; the parent-selector branch isn't
	   reachable to Svelte's compile-time CSS analyzer otherwise. */
	:global(li.md-sub > .suggest-edit-portal) {
		margin-left: calc(-1 * var(--space-2));
	}
</style>
