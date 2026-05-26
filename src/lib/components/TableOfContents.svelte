<script lang="ts">
	import type { TocEntry } from '$lib/markdown';

	let {
		entries,
		minEntries = 2,
		open = true
	}: { entries: TocEntry[]; minEntries?: number; open?: boolean } = $props();
</script>

{#if entries.length >= minEntries}
	<nav class="toc" aria-label="Table of contents">
		<details {open}>
			<summary>Contents</summary>
			<ol class="toc-list">
				{#each entries as e (e.slug)}
					<li class={`toc-d${e.depth}`}>
						<a href={`#${e.slug}`}>
							{#if e.number}
								<span class="toc-num">{e.number}.</span>
							{/if}
							<span class="toc-text">{e.text}</span>
						</a>
					</li>
				{/each}
			</ol>
		</details>
	</nav>
{/if}

<style>
	.toc {
		margin: 0 0 var(--space-6);
		border: var(--border-thin) solid var(--rule);
		background: var(--surface-sunken);
		padding: var(--space-3) var(--space-4);
		font-size: var(--text-sm);
		color: var(--ink-2);
	}
	.toc summary {
		cursor: pointer;
		font-size: var(--text-2xs);
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--ink-3);
		user-select: none;
	}
	.toc summary:hover {
		color: var(--ink);
	}
	.toc summary::marker {
		color: var(--ink-3);
	}
	.toc-list {
		list-style: none;
		padding: 0;
		margin: var(--space-3) 0 0;
	}
	.toc-list li {
		padding: var(--space-1) 0;
		line-height: var(--leading-snug);
	}
	.toc-list a {
		color: var(--ink);
		text-decoration: none;
		display: inline-flex;
		gap: 0.5ch;
		align-items: baseline;
	}
	.toc-list a:hover {
		text-decoration: underline;
		text-decoration-color: var(--accent);
	}
	.toc-num {
		color: var(--ink-3);
		font-variant-numeric: tabular-nums;
		letter-spacing: var(--track-tight);
		flex-shrink: 0;
	}
	/* Depth-based indent. norm 1 sits flush, deeper normalized depths step in
	   one tab each. Depth here is the same normalized 1-based scale the body's
	   `data-h-norm` uses, so a doc that opens with `#` and one that opens with
	   `##` get identical TOC indentation. */
	.toc-d1 {
		padding-inline-start: 0;
		font-weight: 600;
	}
	.toc-d2 {
		padding-inline-start: 1.5ch;
	}
	.toc-d3 {
		padding-inline-start: 3.5ch;
		font-size: var(--text-xs);
		color: var(--ink-2);
	}
	.toc-d4 {
		padding-inline-start: 5.5ch;
		font-size: var(--text-xs);
		color: var(--ink-3);
	}
	.toc-d5,
	.toc-d6 {
		padding-inline-start: 7.5ch;
		font-size: var(--text-xs);
		color: var(--ink-3);
	}
</style>
