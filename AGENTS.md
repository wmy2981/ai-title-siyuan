# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run typecheck` — `tsc --noEmit`. Run after touching `src/`.
- `npm run build` — `vite build && node scripts/build-package.mjs`. Emits `package.zip` at the repo root. Run after typecheck for anything that could affect bundling.
- `npm run dev` — watch build.
- `npm run icon` — re-renders `assets/icon.png`, then re-shoots and quantizes `assets/preview.png`.
- `npm run preview` — re-shoots `assets/preview.png` from `assets/preview.html` alone.

There is no test framework and no linter in this repo. Do not add one unprompted — verification is `npm run typecheck` plus `npm run build`, and loading the plugin in SiYuan.

## Build constraints

The bundle must stay **CommonJS**. SiYuan's plugin loader wraps plugin code in `(function anonymous(require, module, exports){...})` and `eval`s it, so ESM output dies at runtime with `SyntaxError: Cannot use import statement outside a module`. Keep `formats: ["cjs"]` and the `index.js` entry in `vite.config.ts`, and keep `siyuan` external — the host injects it.

`dist/`, `package.zip`, `index.js`, `index.css`, `kernel.js` and `i18n/` are build outputs and gitignored. Never edit or commit them. `scripts/build-package.mjs` performs the packaging renames (`README.zh-CN.md` → `README_zh_CN.md`, `src/i18n/` → `i18n/`).

`scripts/render-icon.mjs` writes `assets/icon.png` at the marketplace's 160x160 and fails above 64 KiB. `scripts/render-preview.mjs` drives the Playwright CLI to screenshot `assets/preview.html` into a temp file, then writes a quantized `assets/preview.png` at 1024x768; it fails on any other size or above 512 KiB, and leaves the existing file untouched when it fails. Its Chromium comes from `npx playwright install chromium` (once per machine).

## Release

`.github/workflows/cd.yml` runs on every push to `main`. Bump `plugin.json` and `package.json` to the *same* version — CI errors out if they differ — and it must be higher than the latest `v*` tag. Pushing to `main` tags and publishes the release automatically.

## Conventions

- Conventional Commits in English, imperative, lowercase description (e.g. `fix(api): disable thinking with reasoning_effort`). Commit in separate logical points, not one lump.
- Code comments are in Chinese. User-facing strings are never hardcoded — put them in both `src/i18n/en.json` and `src/i18n/zh-CN.json`, which must keep identical key sets.
- Strict TypeScript with `noUnusedLocals`, `noUnusedParameters` and `verbatimModuleSyntax`. An unreferenced local or function is a build error, not a warning — export deliberately-retained code rather than leaving it dead.
- Deprecated settings fields are cleared in `mergeSettings` (`src/config.ts`) and must never be reintroduced into the request body.
