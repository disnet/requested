<script lang="ts">
	import { onMount } from 'svelte';
	import { auth } from '$lib/atproto/auth.svelte';
	import { theme } from '$lib/theme.svelte';
	import '$lib/styles/fonts.css';
	import '$lib/styles/tokens.css';
	import '$lib/styles/base.css';

	let { children } = $props();

	let signOutConfirm = $state(false);
	let confirmTimer: ReturnType<typeof setTimeout> | null = null;

	onMount(() => {
		theme.init();
		void auth.init();
	});

	function onSignOut() {
		if (!signOutConfirm) {
			signOutConfirm = true;
			confirmTimer = setTimeout(() => (signOutConfirm = false), 3000);
			return;
		}
		if (confirmTimer) clearTimeout(confirmTimer);
		signOutConfirm = false;
		void auth.signOut();
	}

	const themeGlyph = $derived.by(() => {
		switch (theme.pref) {
			case 'light':
				return '☼';
			case 'dark':
				return '☾';
			default:
				return '◐';
		}
	});

	const themeLabel = $derived.by(() => {
		switch (theme.pref) {
			case 'light':
				return 'Light theme — click for dark';
			case 'dark':
				return 'Dark theme — click for system';
			default:
				return 'Follows system theme — click for light';
		}
	});
</script>

<svelte:head>
	<title>Requested</title>
</svelte:head>

<header class="shell">
	<div class="shell-inner">
		<a href="/" class="brand" aria-label="Requested home">
			<span class="brand-mark">Requested</span>
		</a>
		<nav class="shell-nav" aria-label="Account">
			{#if auth.status === 'loading'}
				<span class="muted shell-dots" aria-label="loading">···</span>
			{:else if auth.status === 'signed-in'}
				<a href="/new" class="action shell-new">[ new&nbsp;document ]</a>
				<span class="shell-user" title={auth.did ?? ''}>
					{#if auth.profile?.avatar}
						<img class="shell-avatar" src={auth.profile.avatar} alt="" />
					{:else}
						<span class="shell-avatar shell-avatar-placeholder" aria-hidden="true"></span>
					{/if}
					<span class="shell-handle">{auth.profile?.handle ?? auth.did ?? '…'}</span>
				</span>
				<button type="button" class="action shell-signout" onclick={onSignOut}>
					{signOutConfirm ? '[ confirm? ]' : '[ sign out ]'}
				</button>
			{:else}
				<span class="muted">signed&nbsp;out</span>
			{/if}
			<button
				type="button"
				class="theme-toggle"
				onclick={() => theme.cycle()}
				aria-label={themeLabel}
				title={themeLabel}
			>
				<span aria-hidden="true">{themeGlyph}</span>
			</button>
		</nav>
	</div>
</header>

<main class="shell-main">
	{@render children()}
</main>

<footer class="shell-foot">
	<div class="shell-foot-inner">
		<span class="muted">Requested · documents live on your atproto PDS · </span>
		<a href="https://github.com/disnet/at-rfc" target="_blank" rel="noopener">source</a>
	</div>
</footer>

<style>
	.shell {
		border-bottom: var(--border-thin) solid var(--rule);
		background: var(--surface);
	}
	.shell-inner {
		max-width: var(--col-shell);
		margin-inline: auto;
		padding: var(--space-4) var(--space-5);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-5);
	}

	.brand {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-3);
		text-decoration: none;
		color: var(--ink);
	}
	.brand-mark {
		font-weight: 700;
		font-size: var(--text-md);
		letter-spacing: var(--track-caps);
	}
	.brand:hover .brand-mark {
		color: var(--accent);
	}

	.shell-nav {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		font-size: var(--text-sm);
	}
	.shell-new {
		white-space: nowrap;
	}
	.shell-user {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		max-width: 16rem;
		color: var(--ink-2);
	}
	.shell-handle {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.shell-avatar {
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 999px;
		object-fit: cover;
		flex-shrink: 0;
		border: 1px solid var(--rule);
	}
	.shell-avatar-placeholder {
		background: var(--surface-sunken);
	}
	.shell-signout {
		white-space: nowrap;
	}
	.shell-dots {
		letter-spacing: 0.3em;
	}

	.theme-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border: var(--border-thin) solid var(--rule-strong);
		color: var(--ink-2);
		font-size: var(--text-base);
		transition:
			color var(--dur-fast) var(--ease-out-quart),
			border-color var(--dur-fast) var(--ease-out-quart);
	}
	.theme-toggle:hover {
		color: var(--accent);
		border-color: var(--accent);
	}

	.shell-main {
		flex: 1 1 auto;
		padding: var(--space-7) var(--space-5) var(--space-8);
	}

	.shell-foot {
		border-top: var(--border-thin) solid var(--rule);
		background: var(--surface);
	}
	.shell-foot-inner {
		max-width: var(--col-shell);
		margin-inline: auto;
		padding: var(--space-4) var(--space-5);
		font-size: var(--text-xs);
		color: var(--ink-3);
		text-align: center;
	}

	@media (max-width: 640px) {
		.shell-inner {
			flex-wrap: wrap;
			gap: var(--space-3);
		}
		.shell-nav {
			gap: var(--space-3);
			flex-wrap: wrap;
		}
		.shell-user {
			max-width: 10rem;
		}
	}
</style>
