<script lang="ts">
	import { auth } from '$lib/atproto/auth.svelte';

	let handle = $state('');
	let submitting = $state(false);
	let sessionHandle = $state<string | null>(null);

	async function onSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!handle.trim()) return;
		submitting = true;
		try {
			await auth.signIn(handle);
		} catch (err) {
			auth.error = err instanceof Error ? err.message : String(err);
			submitting = false;
		}
	}

	// Smoke test that the authenticated agent can hit the user's PDS. We use
	// com.atproto.server.getSession (covered by the `atproto` scope) rather
	// than appview calls like app.bsky.actor.getProfile (those would require
	// the additional `transition:generic` scope to service-proxy).
	$effect(() => {
		const agent = auth.agent;
		if (!agent) {
			sessionHandle = null;
			return;
		}
		void (async () => {
			try {
				const res = await agent.com.atproto.server.getSession();
				sessionHandle = res.data.handle;
			} catch (err) {
				sessionHandle = `error: ${err instanceof Error ? err.message : String(err)}`;
			}
		})();
	});
</script>

{#if auth.status === 'loading'}
	<p class="muted">Loading…</p>
{:else if auth.status === 'signed-out'}
	<section class="hero">
		<h1>AT-RFC</h1>
		<p>Publish markdown RFCs to your atproto PDS and collect threaded line-comments.</p>
		<form onsubmit={onSubmit}>
			<label>
				<span>Handle</span>
				<input
					type="text"
					placeholder="alice.bsky.social"
					bind:value={handle}
					autocomplete="username"
					required
				/>
			</label>
			<button type="submit" disabled={submitting}>
				{submitting ? 'Redirecting…' : 'Sign in with atproto'}
			</button>
		</form>
		{#if auth.error}
			<p class="error">{auth.error}</p>
		{/if}
	</section>
{:else}
	<section>
		<h1>You're signed in</h1>
		<dl>
			<dt>DID</dt>
			<dd><code>{auth.did}</code></dd>
			<dt>Handle (via getSession)</dt>
			<dd><code>{sessionHandle ?? '…'}</code></dd>
		</dl>
		<p class="muted">
			Document authoring and the rest of the app will live here. Auth is the only thing wired up so far.
		</p>
	</section>
{/if}

<style>
	.hero {
		text-align: center;
		padding: 3rem 1rem 1rem;
	}
	.hero h1 {
		font-size: 2.5rem;
		margin: 0 0 0.5rem;
	}
	.hero p {
		color: #555;
		max-width: 36rem;
		margin: 0 auto 2rem;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-width: 22rem;
		margin: 0 auto;
		text-align: left;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	label span {
		font-size: 0.8rem;
		color: #555;
	}
	input {
		padding: 0.5rem 0.75rem;
		font: inherit;
		border: 1px solid #ccc;
		border-radius: 6px;
	}
	button {
		padding: 0.5rem 0.75rem;
		font: inherit;
		border: 1px solid #222;
		background: #222;
		color: white;
		border-radius: 6px;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.6;
		cursor: progress;
	}
	.error {
		color: #b00;
		margin-top: 1rem;
		text-align: center;
	}
	.muted {
		color: #888;
	}
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.5rem 1rem;
		max-width: 36rem;
	}
	dt {
		font-weight: 600;
	}
	dd {
		margin: 0;
	}
	code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
</style>
