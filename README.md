# Accessify

An agent that finds web accessibility bugs, fixes them **in your source files**, proves each fix with a re-scan, and prepares (or opens) a pull request.

    npm install
    npm start            # http://127.0.0.1:8787, click "Try the demo site"
    npm run demo         # same loop in the terminal
    npm test

Needs Node 22.18+. Google Chrome is needed for live websites and `.html` pages (set `CHROME_PATH` to use another build).

## What you can point it at

| Target | What happens |
|---|---|
| **A live website** (`https://example.com`, `example.com`, `localhost:3000`) | Up to 6 same-origin pages are rendered in Chrome (so React/Vue apps are captured after they hydrate) and saved as static copies. Scripts are switched off in the copy, not removed, so element positions match the live page. Accessify scans, fixes and re-verifies the copies, then ships the result as **`accessify-fixes.js`** (a drop-in script that applies each fix to your live page by URL path and CSS selector), plus a patch and a report. |
| **A GitHub repo** (`https://github.com/owner/repo`) | Real source edits, a clean commit and a pull request. |
| **A local folder** | Same, and you name the `owner/repo` to raise the PR against. |

A website has no repository, so there is no PR step for it: the Pull request tab becomes **Ship fixes**. The script matches elements by CSS selector, so re-run Accessify after big layout changes. Pages behind a login, bot protection or Shadow DOM are not captured.

## The loop

1. **Crawl** every `.html` page in the folder (or a cloned GitHub repo) with Playwright + axe-core (WCAG 2.0/2.1 A and AA, plus `tabindex`).
2. **Classify** each violating element as auto-fixable or "needs a human".
3. **Fix** with one agent per issue. Edits are made by exact source offsets from a parse5 parse, so diffs stay minimal. The scan and the parser walk the DOM the same way, which is how a browser element maps back to a line of source. If the tag does not match, the edit is refused.
4. **Re-test**: a fresh scan must no longer report that element. If a file's fixes cause any *new* violation, the file is rolled back. Failed contrast fixes get one retry with a stricter strategy.
5. **Review and PR**: you edit and approve; then it commits to `accessify/a11y-fixes` and opens the PR. `PR.md` and `fixes.patch` are kept under `runs/<id>/`.

| Rule | Fix |
|---|---|
| image-alt | Gemini describes the element screenshot (file-name heuristic as fallback); decorative images get `alt=""` |
| button-name, link-name, label, select-name | `aria-label` from Gemini, or from markup hints |
| color-contrast | hue-preserving lightness shift (darkens the background instead for white text on a coloured button) |
| html-has-lang, document-title, meta-viewport, tabindex, link-in-text-block, frame-title | deterministic |
| anything else (e.g. heading order) | reported, never guessed |

## Gemini + heuristics

Fixes are a mix. Rule-based fixers handle contrast, `lang`, viewport, tabindex and underlines. **Gemini** looks at the element screenshot to write alt text, names buttons and links, writes page titles, and suggests how a developer should handle issues the agent will not touch. If Gemini is missing, rate limited or fails, that fix falls back to markup heuristics and is labelled with its confidence.

Click **Connect Gemini** / **Connect GitHub** in the dashboard (or set `GEMINI_API_KEY` and `GITHUB_TOKEN`). Keys entered in the dashboard are verified, then saved to a gitignored `.env` here. The newest Flash model your key can use is picked automatically; override with `ACCESSIFY_MODEL`.

## Review, then raise the PR

Nothing is pushed until you say so. After the re-test the dashboard opens the **Fixes & issues** tab:

- edit the value of any fix (alt text, accessible name, title, language, colour),
- switch fixes off to leave them out,
- press **Re-verify changes**: everything is re-applied from the original source and re-scanned, so a bad edit is caught and rolled back,
- edit the PR title, branch and description, then **Raise pull request**.

The PR is pushed to the repo when your token can write there, otherwise from your fork. A local-folder run asks for the `owner/repo` to target and applies the reviewed patch to a fresh clone of its default branch. Token scopes: Contents and Pull requests write (classic: `repo`).

## Beyond HTML

- **Rendered pages** (`.html`): Chrome + axe-core, screenshots with a pin on every changed element, colour and screen-reader before/after.
- **Template and component files** (`.jsx .tsx .vue .svelte .astro .php .hbs .njk .ejs .erb .liquid .twig`): scanned from source with a tolerant tag scanner, so React, Next, Vue, Svelte and PHP projects need no build and no Chrome. Covers `image-alt` (Gemini looks at the real image file when `src` points into the repo), `button-name`, `link-name`, `label`, `select-name`, `frame-title`, `html-has-lang`, `meta-viewport`, `tabindex`, and flags clickable `div`/`span` with no keyboard access for a human (Gemini suggests the fix). Edits are minimal attribute insertions at exact source offsets, and each file is re-scanned after fixing, with rollback on any regression.

## Limits

- Static analysis of templates cannot judge contrast or anything that depends on runtime data: dynamic `alt={x}`, spread props and computed content are assumed correct. Colour fixes need a rendered `.html` page and are added as `a11y-*` classes with `!important`, to be moved into your stylesheet.
- axe-core finds roughly a third of WCAG problems automatically. A score of 100 is not a compliance claim.
- Cloning a GitHub URL is unauthenticated, so private repos do not work yet.
