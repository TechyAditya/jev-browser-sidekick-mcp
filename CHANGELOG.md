# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
