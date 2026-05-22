# Product

## Register

product

## Users

Working software engineers using AT-RFC to draft, publish, and review documents-of-record — architecture decisions, internal RFCs, protocol proposals, design memos. They're comfortable with markdown and GitHub but not necessarily IETF formalism. They reach for AT-RFC when an idea deserves more weight than a Slack thread, more permanence than a Notion page, and more reviewability than a Google Doc.

Two contexts of use:

- **Author** — writing or revising a proposal in long sittings. Wants a clean writing surface, real version history, and confidence that the published artifact looks serious.
- **Reviewer** — reading a colleague's RFC and leaving line-anchored comments. Often skimming first, then doing a deep pass. Wants the document to be scannable and the comment threading to stay out of the way until they want it.

## Product Purpose

AT-RFC lets anyone publish a markdown RFC to their own atproto PDS and collect threaded line-comments from anyone with an atproto identity. It exists because the existing options for durable, citable, comment-able technical writing are either heavyweight and centralized (Google Docs, Notion) or lightweight and ephemeral (Slack, GitHub issues). The atproto data model means documents and comments live on their owners' PDSes — the artifact outlives the app.

Success looks like: an engineer pastes a link to their AT-RFC document in Slack, and the link recipients react to the URL the way they'd react to a link to an IETF RFC — _this is a real document, someone thought about it, I should read it carefully_.

## Brand Personality

Three words: **archival, rigorous, legible.**

Voice and tone — precise, declarative, terse. The same register as a well-written spec: comfortable with formality, allergic to corporate fluff. Never cute. Confident enough in its formalism to not over-explain itself, modern enough to not feel like a museum piece. Think "well-maintained technical journal," not "retro typewriter" and not "SaaS productivity app."

Emotionally the interface should evoke: the calm of opening a clean monospace column of well-organized prose; the credibility of a document that respects itself; the focus of a reading room.

## Anti-references

- **Notion / Linear / SaaS-cream.** Soft shadows, rounded everything, lavender accents, system-sans-everywhere. The default 2020s product look reads as ephemeral. AT-RFC documents are not ephemeral.
- **GitHub flat-utility.** Dense gray chrome, generic blue links, characterless data tables. Functional but anonymous — every dev tool already looks like this.
- Conversely, must **NOT** become brutalist terminal cosplay: all-monospace, neon-on-black, ASCII-block overload, hard-coded 80 columns. That's the failure mode of trying too hard for the RFC reference.
- Must **NOT** become Medium / Substack reader-blog either: big-serif-headline-and-generous-whitespace is beautiful but reads as "personal essay," not "document of record."

## Design Principles

1. **Document of record, not blog post.** Every visual choice should reinforce that an RFC is durable, citable, owned by its publisher. The artifact looks like something worth referencing in a year.
2. **Modern affordances on a vintage scaffold.** Keep the RFC bones — metadata header block, numbered sections, monospace as a typographic anchor, a visible 72-character rule on body text. Add what 1990 didn't have — color used sparingly and meaningfully, real focus and hover states, smooth motion, inline commenting that feels native. The scaffold is borrowed; the affordances are 2026.
3. **Density that respects the reader.** RFC density is informational, not visual noise. Tight, considered spacing. No decorative fluff. Every line earns its vertical space.
4. **The chrome serves the document.** The body of the document is the protagonist on every reading view. App chrome — header, nav, comment threads, version metadata — is supportive scaffolding, never a competing show.
5. **Strong enough to stand next to the real thing.** Open AT-RFC next to a rendered IETF RFC and it should feel like a respectful descendant, not a parody. Open it next to Notion and it should feel like a different category of artifact entirely.

## Accessibility & Inclusion

- WCAG 2.2 AA minimum. Body contrast meets AAA where possible; monospace at body sizes needs extra care since dense monospace can fatigue readers faster than proportional type.
- Honor `prefers-reduced-motion` — disable all non-essential transitions, never animate scroll-anchored elements without a reduced-motion fallback.
- Honor `prefers-color-scheme` for theme default; explicit toggle available.
- Focus states must be strongly visible (≥2px outline, high contrast against both light and dark themes). Keyboard navigation through document body, comment threads, and editor must be unobstructed.
- Color must never be the _only_ signal — comment indicators, diff markers, and version status all need a non-color cue (icon, symbol, weight).
- Body line length capped at 72ch (the RFC convention coincidentally matches modern readability research, 65–75ch).
