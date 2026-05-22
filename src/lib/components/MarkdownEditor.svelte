<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { EditorView, basicSetup } from 'codemirror';
	import { EditorState } from '@codemirror/state';
	import { markdown } from '@codemirror/lang-markdown';

	let { value = $bindable('') }: { value?: string } = $props();

	let container: HTMLDivElement;
	let view: EditorView | null = null;
	let suppressOutput = false;

	onMount(() => {
		view = new EditorView({
			parent: container,
			state: EditorState.create({
				doc: value,
				extensions: [
					basicSetup,
					markdown(),
					EditorView.lineWrapping,
					EditorView.updateListener.of((update) => {
						if (update.docChanged && !suppressOutput) {
							value = update.state.doc.toString();
						}
					})
				]
			})
		});
	});

	// Sync external value changes back into the editor (e.g. loading a fresh doc).
	// Guarded so the round-trip from editor → value → effect → editor doesn't loop.
	$effect(() => {
		if (!view) return;
		const current = view.state.doc.toString();
		if (current === value) return;
		suppressOutput = true;
		view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
		suppressOutput = false;
	});

	onDestroy(() => {
		view?.destroy();
		view = null;
	});
</script>

<div bind:this={container} class="editor"></div>

<style>
	.editor :global(.cm-editor) {
		border: 1px solid #ccc;
		border-radius: 6px;
		min-height: 24rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.95rem;
	}
	.editor :global(.cm-editor.cm-focused) {
		outline: 2px solid #226;
		outline-offset: -2px;
	}
	.editor :global(.cm-scroller) {
		max-height: 70vh;
	}
</style>
