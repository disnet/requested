<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { EditorView, minimalSetup } from 'codemirror';
	import { EditorState, Prec } from '@codemirror/state';
	import { keymap, placeholder as placeholderExt } from '@codemirror/view';
	import { markdown } from '@codemirror/lang-markdown';

	let {
		value = $bindable(''),
		placeholder = 'Write a comment in markdown…',
		autofocus = true,
		onEscape,
		onSubmit
	}: {
		value?: string;
		placeholder?: string;
		autofocus?: boolean;
		onEscape?: () => void;
		onSubmit?: () => void;
	} = $props();

	let container: HTMLDivElement;
	let view: EditorView | null = null;
	let suppressOutput = false;

	onMount(() => {
		view = new EditorView({
			parent: container,
			state: EditorState.create({
				doc: value,
				extensions: [
					minimalSetup,
					markdown(),
					EditorView.lineWrapping,
					placeholderExt(placeholder),
					// High precedence so these bindings win against minimalSetup's
					// defaults — Escape would otherwise just clear selection.
					Prec.high(
						keymap.of([
							{
								key: 'Escape',
								run: () => {
									if (!onEscape) return false;
									onEscape();
									return true;
								}
							},
							{
								key: 'Mod-Enter',
								run: () => {
									if (!onSubmit) return false;
									onSubmit();
									return true;
								}
							}
						])
					),
					EditorView.theme(
						{
							'&': {
								backgroundColor: 'var(--surface)',
								color: 'var(--ink)',
								fontFamily: 'var(--font-mono)',
								fontSize: 'var(--text-base)',
								lineHeight: 'var(--leading-body)'
							},
							'.cm-content': {
								caretColor: 'var(--accent)',
								padding: 'var(--space-3)'
							},
							'.cm-cursor, .cm-dropCursor': {
								borderLeftColor: 'var(--accent)',
								borderLeftWidth: '2px'
							},
							'&.cm-focused .cm-selectionBackground, ::selection': {
								backgroundColor: 'var(--selection-bg)'
							},
							'.cm-placeholder': {
								color: 'var(--ink-4)',
								fontStyle: 'normal'
							}
						},
						{ dark: false }
					),
					EditorView.updateListener.of((update) => {
						if (update.docChanged && !suppressOutput) {
							value = update.state.doc.toString();
						}
					})
				]
			})
		});
		if (autofocus) view.focus();
	});

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
		border: var(--border-thin) solid var(--rule-strong);
		background: var(--surface);
		min-height: 6rem;
	}
	.editor :global(.cm-editor.cm-focused) {
		outline: var(--border-thick) solid var(--accent);
		outline-offset: -2px;
		border-color: var(--accent);
	}
	.editor :global(.cm-scroller) {
		max-height: 24rem;
	}
</style>
