<script lang="ts">
	import type { Snippet } from 'svelte';
	import MarkdownEditor from './MarkdownEditor.svelte';

	let {
		body = $bindable(''),
		saving = false,
		error = null as string | null,
		submitLabel = '',
		submitDisabled = false,
		cancelHref = '/',
		onsubmit = () => {},
		header,
	}: {
		body: string;
		saving?: boolean;
		error?: string | null;
		submitLabel?: string;
		submitDisabled?: boolean;
		cancelHref?: string;
		onsubmit?: () => void;
		header: Snippet;
	} = $props();
</script>

<form
	class="composer"
	onsubmit={(e) => {
		e.preventDefault();
		onsubmit();
	}}
>
	{@render header()}

	<div class="editor-frame">
		<div class="editor-rail">
			<span class="rail-label">Body</span>
		</div>
		<MarkdownEditor bind:value={body} />
	</div>

	<div class="actions">
		{#if error}
			<p class="error actions-error">{error}</p>
		{/if}
		<a href={cancelHref} class="action">[ cancel ]</a>
		<button type="submit" class="bracket-btn bracket-btn-primary" disabled={submitDisabled}>
			{submitLabel}
		</button>
	</div>
</form>

<style>
	.composer {
		max-width: var(--col-wide);
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}

	.editor-frame {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.editor-rail {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-size: var(--text-2xs);
		text-transform: uppercase;
		letter-spacing: var(--track-caps);
		color: var(--ink-3);
	}
	.rail-label {
		color: var(--ink-2);
	}

	.actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-4);
	}
	.actions-error {
		margin-right: auto;
	}
</style>
