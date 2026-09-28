# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-09-28

### Fixed

- When a step's control is absent, return `rejected` with `no_control` / `no_match`
  instead of clicking an unrelated element. Click targets now carry a standing
  `none` option, and pick steps on a subject page that is not a result list
  refuse before calling Jev.
- Missing search box and empty "no operation returned" decisions report
  `rejected` / `no_control`, not `blocked` (which is reserved for credentials,
  captchas, and sign-in).
- Search recovers when the field is collapsed behind a Search control: click to
  reveal, then type.
- Non-JSON / HTML TypeSafe responses throw so OpenRouter fallback can run, and
  empty answers are no longer counted as a successful zero-token decision.
- Result candidates require the subject (`mentions`), and no longer fall back to
  every long link on the page.

### Added

- Decision state carries `motive`, `steps_done`, and `current_task` so Jev sees
  why the series exists and what earlier steps already did.
- Click / type option text includes a sentence of context (neighbouring title)
  rather than a bare label.

## [0.1.2] - 2026-09-27

### Fixed

- Declare the `bin` targets without a `./` prefix. npm 10 normalised the prefix away,
  but npm 11, which the publish workflow runs, calls it invalid and drops the entry.
  Both `jev-browser-sidekick-mcp` and `jev-bro` were removed from 0.1.1 this way, so
  install that version and neither command exists. Use 0.1.2 or 0.1.0.

### Added

- CI fails when npm rewrites the manifest while packing, and when a `bin` entry is
  missing or carries a `./` prefix. The publish workflow refuses to ship a rewritten
  manifest.

## [0.1.1] - 2026-09-27

### Fixed

- Report `verified` as false when a series carried `expect` and stopped before the
  check could run. It was left unset, which the top-level rollup could not tell apart
  from a series that never asked for proof, so a run where one group passed its check
  and another never reached its page reported `verified: true`.

### Added

- npm, CI, Node, and licence badges in the README.

## [0.1.0] - 2026-09-27

First release.

### Added

- `run_action`, which takes groups of plain-language steps, runs each group on its own
  tab in parallel, and reports a status for every step.
- `use_jev_raw`, which answers one typed question, or several, with no browser involved.
- The `jev://raw-decisions` and `jev://reading-a-result` resources.
- Step shapes for search, pick, goto, click, repeat, and read.
- `expect`, which reads the final page for the text that proves a run worked and quotes
  the words either side of the match in `proof`.
- A resumable `handoff` naming the tab, the URL, the step that stopped, and the steps left.
- `blocked` with a reason for a sign-in wall, a password, a one-time code, or a captcha.
  The server never types into those fields.
- Exact token totals summed from every API response, with `costUsd` when the provider
  returns a price.
- A `--debug` server flag and a per-call `debug` option that write every browser call and
  Jev decision to `~/.jev/traces`.
- A CLI (`jev-sidekick`) with `setup`, `doctor`, and `run`.
