# Requested

Publish markdown RFCs and collect threaded line-comments on [atproto](https://atproto.com).

Live at **[requested.fyi](https://requested.fyi)**.

## Why

Durable, citable, comment-able technical writing currently lives in one of two places:

- Heavyweight and centralized — Google Docs, Notion. The document is hostage to a vendor.
- Lightweight and ephemeral — Slack, GitHub issues. The discussion evaporates.

Requested is for the documents that deserve more weight than a Slack thread, more permanence than a Notion page, and more reviewability than a Google Doc: architecture decisions, internal RFCs, protocol proposals, design memos.

Every document and every comment is a record on its owner's PDS. The artifact outlives the app — anyone with an atproto identity can read it, comment on it, or mirror it, and nothing about that depends on `requested.fyi` continuing to exist.

## How it works

- Documents are `fyi.requested.document` records on the author's PDS, with immutable `fyi.requested.documentVersion` snapshots chained by `previousVersion`.
- Comments are `fyi.requested.comment` records on the **commenter's** PDS, pinned to the specific version they were reading. Optional line anchoring and threading.
- Anyone can read any RFC unauthenticated; commenting requires an atproto sign-in.
- Pure browser SPA — no server, no database. Hosted as static files on Cloudflare Pages.

See [`CLAUDE.md`](./CLAUDE.md) for architecture notes and [`PRODUCT.md`](./PRODUCT.md) for the design rationale.

## Development

```sh
npm install
npm run dev      # Vite dev server on http://127.0.0.1:5173
npm run check    # svelte-check (typecheck + Svelte diagnostics)
npm run lint     # prettier --check && eslint
npm run build    # static SPA into build/
```

The dev server is bound to `127.0.0.1:5173` with `strictPort` because the atproto OAuth loopback client requires the literal `127.0.0.1` (not `localhost`).
