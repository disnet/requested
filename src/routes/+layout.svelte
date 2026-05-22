<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { onMount } from 'svelte';
	import { auth } from '$lib/atproto/auth.svelte';

	let { children } = $props();

	onMount(() => {
		void auth.init();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>AT-RFC</title>
</svelte:head>

<header>
	<a href="/" class="brand">AT-RFC</a>
	<nav>
		{#if auth.status === 'loading'}
			<span class="muted">…</span>
		{:else if auth.status === 'signed-in'}
			<span class="user" title={auth.did ?? ''}>
				{#if auth.profile?.avatar}
					<img class="avatar" src={auth.profile.avatar} alt="" />
				{:else}
					<span class="avatar avatar-placeholder" aria-hidden="true"></span>
				{/if}
				<span class="handle">{auth.profile?.handle ?? auth.did ?? '…'}</span>
			</span>
			<button type="button" onclick={() => auth.signOut()}>Sign out</button>
		{:else}
			<span class="muted">signed out</span>
		{/if}
	</nav>
</header>

<main>
	{@render children()}
</main>

<style>
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1.5rem;
		border-bottom: 1px solid #e5e5e5;
	}
	.brand {
		font-weight: 700;
		text-decoration: none;
		color: inherit;
	}
	nav {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 0.9rem;
	}
	.user {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 22rem;
	}
	.handle {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.avatar {
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 999px;
		object-fit: cover;
		flex-shrink: 0;
	}
	.avatar-placeholder {
		background: #ddd;
	}
	.muted {
		color: #888;
	}
	main {
		padding: 1.5rem;
		max-width: 56rem;
		margin: 0 auto;
	}
</style>
