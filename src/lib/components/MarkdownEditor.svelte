<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { EditorView, basicSetup } from 'codemirror';
	import { EditorState, Compartment } from '@codemirror/state';
	import { markdown } from '@codemirror/lang-markdown';
	import { theme } from '$lib/theme.svelte';

	let { value = $bindable('') }: { value?: string } = $props();

	let container: HTMLDivElement;
	let view: EditorView | null = null;
	let suppressOutput = false;
	const themeCompartment = new Compartment();

	function isDark(): boolean {
		if (theme.pref === 'dark') return true;
		if (theme.pref === 'light') return false;
		return window.matchMedia('(prefers-color-scheme: dark)').matches;
	}

	function cmTheme(dark: boolean) {
		return EditorView.theme(
			{
				'&': {
					backgroundColor: 'transparent',
					color: 'var(--ink)',
					fontFamily: 'var(--font-mono)',
					fontSize: 'var(--text-base)',
					lineHeight: 'var(--leading-body)'
				},
				'.cm-content': {
					caretColor: 'var(--accent)',
					padding: 'var(--space-4) 0'
				},
				'.cm-cursor, .cm-dropCursor': {
					borderLeftColor: 'var(--accent)',
					borderLeftWidth: '2px'
				},
				'&.cm-focused .cm-selectionBackground, ::selection': {
					backgroundColor: 'var(--selection-bg)',
					color: 'var(--selection-fg)'
				},
				'.cm-gutters': {
					backgroundColor: 'var(--surface-sunken)',
					color: 'var(--ink-4)',
					border: '0',
					borderRight: 'var(--border-thin) solid var(--rule)',
					fontSize: 'var(--text-xs)'
				},
				'.cm-activeLineGutter': {
					backgroundColor: 'transparent',
					color: 'var(--accent)'
				},
				'.cm-activeLine': {
					backgroundColor: 'color-mix(in oklch, var(--accent-fade) 35%, transparent)'
				},
				'.cm-selectionMatch': {
					backgroundColor: 'var(--accent-fade)'
				},
				'.cm-matchingBracket': {
					outline: '1px solid var(--accent)',
					color: 'var(--accent) !important'
				}
			},
			{ dark }
		);
	}

	onMount(() => {
		view = new EditorView({
			parent: container,
			state: EditorState.create({
				doc: value,
				extensions: [
					basicSetup,
					markdown(),
					EditorView.lineWrapping,
					themeCompartment.of(cmTheme(isDark())),
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

	// Reconfigure CodeMirror theme when app theme or system preference changes.
	$effect(() => {
		if (!view) return;
		// Track theme.pref reactively
		void theme.pref;
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		function sync() {
			view?.dispatch({ effects: themeCompartment.reconfigure(cmTheme(isDark())) });
		}
		sync();
		mq.addEventListener('change', sync);
		return () => mq.removeEventListener('change', sync);
	});

	onDestroy(() => {
		view?.destroy();
		view = null;
	});
</script>

<div bind:this={container} class="editor"></div>

<style>
	.editor {
		position: relative;
	}
	.editor :global(.cm-gutters) {
		display: none;
	}
	.editor :global(.cm-editor) {
		border: var(--border-thin) solid var(--rule-strong);
		background: var(--surface);
	}
	.editor :global(.cm-editor.cm-focused) {
		outline: var(--border-thick) solid var(--accent);
		outline-offset: -2px;
		border-color: var(--accent);
	}
	.editor :global(.cm-scroller) {
		max-height: 70vh;
	}
	.editor :global(.cm-content) {
		max-width: calc(72ch + var(--space-4));
		margin: 0 auto;
	}
</style>
