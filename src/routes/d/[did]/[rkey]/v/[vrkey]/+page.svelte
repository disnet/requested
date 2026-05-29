<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import { parseAtUri } from '$lib/atproto/documents';
	import { versionMarkdown } from '$lib/atproto/lexicons';
	import { extractToc, renderMarkdown } from '$lib/markdown';
	import { downloadMarkdown } from '$lib/export';
	import TableOfContents from '$lib/components/TableOfContents.svelte';

	const { data } = $props();

	const loaded = $derived(data.doc);
	const version = $derived(data.version);
	const author = $derived(data.profile);
	const versionIndex = $derived(data.versionIndex);
	const error = $derived(data.loadError);

	const did = $derived(page.params.did as string);
	const rkey = $derived(page.params.rkey as string);
	const docPath = $derived(resolve('/d/[did]/[rkey]', { did, rkey }));
	const historyPath = $derived(resolve('/d/[did]/[rkey]/history', { did, rkey }));
	const diffBasePath = $derived(resolve('/d/[did]/[rkey]/diff', { did, rkey }));
	const isCurrent = $derived(
		loaded?.version != null && version != null && loaded.version.cid === version.cid
	);
	const renderedHtml = $derived(version ? renderMarkdown(versionMarkdown(version.value)) : '');
	const tocEntries = $derived(version ? extractToc(versionMarkdown(version.value)) : []);

	const authorHandle = $derived(author?.handle ?? loaded?.did ?? '');
	const authorDid = $derived(loaded?.did ?? '');

	function formatDate(iso: string): string {
		const d = new Date(iso);
		const y = d.getUTCFullYear();
		const m = String(d.getUTCMonth() + 1).padStart(2, '0');
		const day = String(d.getUTCDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}

	const currentVersionRkey = $derived(loaded?.version ? parseAtUri(loaded.version.uri).rkey : null);

	function onExport() {
		if (!loaded || !version) return;
		const title = loaded.value.title + (versionIndex ? ` v${versionIndex.n}` : '');
		downloadMarkdown(title, versionMarkdown(version.value), version.rkey);
	}
</script>

<svelte:head>
	{#if loaded?.value.title}
		<title>{loaded.value.title} (older version) — Requested</title>
	{/if}
</svelte:head>

{#if error}
	<div class="column">
		<p class="error">{error}</p>
	</div>
{:else if loaded === null || version === null}
	<div class="column">
		<p class="muted">Loading…</p>
	</div>
{:else}
	{#if !isCurrent}
		<aside class="stripe-banner stripe-banner-warn version-banner">
			<span>
				Status: Superseded — viewing an older version from
				<time datetime={version.value.createdAt}>{formatDate(version.value.createdAt)}</time>
			</span>
			<span class="version-banner-actions">
				<a class="action" href={docPath}>[ jump to current ]</a>
				{#if currentVersionRkey}
					<a
						class="action"
						href={`${diffBasePath}?from=${version.rkey}&to=${currentVersionRkey}` as ResolvedPathname}
					>
						[ diff vs current ]
					</a>
				{/if}
				<a class="action" href={historyPath}>[ all versions ]</a>
			</span>
		</aside>
	{/if}

	<article class="document">
		<header class="meta-block">
			<div class="meta-row">
				<div class="meta-left">
					<div class="meta-line">
						<span class="meta-key">Document</span>
						<span class="meta-val mono-tight">{loaded.rkey}</span>
					</div>
					<div class="meta-line">
						<span class="meta-key">Status</span>
						{#if isCurrent}
							<span class="status status-current">Current</span>
						{:else}
							<span class="status status-superseded">Superseded</span>
						{/if}
					</div>
					<div class="meta-line">
						<span class="meta-key">Version</span>
						<span class="meta-val">
							{#if versionIndex}
								v{versionIndex.n} of {versionIndex.total}
							{:else}
								<span class="mono-tight">{version.rkey}</span>
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
								<span>{authorHandle}</span>
							</span>
							<span class="meta-author-did mono-tight">{authorDid}</span>
						</span>
					</div>
					<div class="meta-line">
						<span class="meta-key">Published</span>
						<span class="meta-val">
							<time datetime={version.value.createdAt}>
								{formatDate(version.value.createdAt)}
							</time>
						</span>
					</div>
				</div>
			</div>

			<h1 class="doc-title">{loaded.value.title}</h1>

			<nav class="meta-actions">
				<a class="action" href={historyPath}>[ history ]</a>
				<a class="action" href={diffBasePath}>[ diff ]</a>
				<button type="button" class="action" onclick={onExport}>[ export ]</button>
			</nav>
		</header>

		<TableOfContents entries={tocEntries} />

		<div class="prose">
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by DOMPurify in renderMarkdown -->
			{@html renderedHtml}
		</div>
	</article>
{/if}

<style>
	.version-banner {
		max-width: var(--col-wide);
		margin: 0 auto var(--space-6);
		display: flex;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--space-3);
	}
	.version-banner-actions {
		display: flex;
		gap: var(--space-3);
		text-transform: none;
		letter-spacing: 0;
	}

	.document {
		max-width: var(--col-body);
		margin-inline: auto;
	}

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
		min-width: 7ch;
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

	.prose {
		font-size: var(--text-base);
		line-height: var(--leading-body);
		color: var(--ink);
		counter-reset: l1 l2 l3;
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
	}
	.prose :global(h1) {
		font-size: var(--text-2xl);
	}
	.prose :global(h2) {
		font-size: var(--text-xl);
	}
	.prose :global(h3) {
		font-size: var(--text-lg);
	}
	/* Section numbering keyed on the normalized heading depth emitted by
	   markdown.ts. See matching note in the reader page CSS. */
	.prose :global([data-h-norm='1']) {
		counter-reset: l2 l3;
	}
	.prose :global([data-h-norm='1']::before) {
		content: counter(l1) '. ';
		counter-increment: l1;
		color: var(--ink-3);
		margin-right: 0.5ch;
	}
	.prose :global([data-h-norm='2']) {
		counter-reset: l3;
	}
	.prose :global([data-h-norm='2']::before) {
		content: counter(l1) '.' counter(l2) '. ';
		counter-increment: l2;
		color: var(--ink-3);
		margin-right: 0.5ch;
	}
	.prose :global([data-h-norm='3']::before) {
		content: counter(l1) '.' counter(l2) '.' counter(l3) '. ';
		counter-increment: l3;
		color: var(--ink-3);
		margin-right: 0.5ch;
	}
	.prose :global(h1[data-h-norm='1']) {
		padding-bottom: var(--space-2);
		border-bottom: var(--border-thin) solid var(--rule);
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
	.prose :global(a) {
		color: var(--accent);
		text-decoration-color: var(--accent);
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
	}
	.prose :global(:not(pre) > code) {
		background: var(--surface-sunken);
		padding: 1px 4px;
		border: var(--border-thin) solid var(--rule);
	}
	.prose :global(table) {
		/* Keep wide tables from pushing the page sideways on mobile — they
		   scroll horizontally inside their own box instead. */
		display: block;
		max-width: 100%;
		overflow-x: auto;
	}

	@media (max-width: 720px) {
		.meta-row {
			grid-template-columns: 1fr;
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
	}
</style>
