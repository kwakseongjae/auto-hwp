---
name: browser-qa
description: >
  Drive a real browser to verify UI work in this repo: upload public samples,
  click, type. Use when changing /bulk, workspace, layout, routing, or file
  pickers.
---

Prefer **chrome-devtools** (`navigate_page`, `take_snapshot`, `click`,
`upload_file`). Fall back to **agent-browser**.

Start `pnpm -C apps/hwp-lab dev` (port 3000; do not steal Playwright's 3100).
Clear `apps/hwp-lab/.next` after a wasm rebuild.

Public fixtures only:

- `apps/hwp-lab/public/samples/sample-8p.hwp`
- `apps/hwp-lab/public/samples/sample-18p.hwpx`
- `benchmarks/benchmark.hwp`
- `testdata/roster/ok.xlsx`

Never upload `corpus/private`, `benchmarks/local`, or user documents.

Upload, click, and type the changed flow. A screenshot is not enough. If the
browser tools cannot run, say so.
