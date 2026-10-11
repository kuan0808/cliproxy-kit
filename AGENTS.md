# Working on cliproxy-kit

Rules for anyone, human or agent, changing this repo. Build and test commands: README "Develop". How the parts work: [docs/architecture.md](docs/architecture.md).

## Shipping a change
- A finished user-facing change ships as a release: bump `version` in `mod/.claude-plugin/plugin.json`, then tag `v<version>` on that commit. The tag must match the file; it triggers `.github/workflows/release.yml`.
- Update README.md, README.zh-TW.md and docs/architecture.md in the same change whenever user-facing behaviour changes.
- Commits are in English. A release subject is `<version>: <what users now get>`; a docs-only one starts with `README:` or `Docs:` (see `git log`).
- Restarting the CLIProxyAPI service interrupts every request in flight through it; ask before restarting or reloading it.

## Formatting ui/
- `ui/` has no Prettier config, several committed files are not Prettier-clean, and `bun run verify` does not run Prettier.
- Never run `prettier --write` over files. Format only the lines you write, in the repo style: single quotes, print width 100, ES5 trailing commas. To check a block, pipe it through `npx prettier --single-quote --print-width 100 --trailing-comma es5` and copy back only your lines.

## READMEs
- Showcase quality, but clean, short and easy to read.
- Keep the shape: centred hero (logo, pitch, badges, nav, language switch), screenshots early, a 3-step quick start, details in `<details>`, GitHub alerts, Update/uninstall, and a symptom-to-fix Troubleshooting table.
- In README.zh-TW.md put each paragraph or list item on one line (a hard wrap between Chinese characters renders as a stray space on GitHub), and keep a space between Chinese and Latin text.
- Screenshots show the current UI and no personal data: serve the real page through a mock that renames projects, titles, credential files and emails, and grep its output before shooting. One set per language (`docs/images/`, `docs/images/zh-TW/`).
- Preview the rendering with `gh api /markdown` and github-markdown-css before committing.
- No em dash in prose. The UI's "—" glyph for "no reading" is intended; leave it.

## UI claims
- Measure before saying a layout is aligned, centred or fixed: count pixel rows and columns in a screenshot or rendered preview and give the numbers. Otherwise say it is not yet verified.
- Previewing the band as the desktop app draws it: docs/architecture.md, "Desktop preview".
