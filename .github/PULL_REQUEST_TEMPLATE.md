## What changed

<!-- Describe the user-visible outcome and the narrowest reason for this change. -->

## Contract and risk

- [ ] I read `AGENTS.md` and the relevant issue's invariants and traps.
- [ ] I did not add, remove, or expose user document content in fixtures, logs, screenshots, or CI artifacts.
- [ ] Intent schema changes are additive and unknown fields still fail explicitly.
- [ ] Geometry remains px (= HWPUNIT/75); edit commits remain HWPUNIT.
- [ ] If layout changed, `place_doc` and `NaiveLayout` remain lockstep and the page gates are unchanged or explained.
- [ ] If Rust/core code changed, I rebuilt the wasm package before testing the web surface.

## Verification

<!-- Paste commands and concise results. Do not paste document text. -->

- [ ] `scripts/verify-local.sh` passed, or the reason a narrower command is sufficient is explained below.
- [ ] Relevant unit/regression tests were added or updated.
- [ ] Public behavior or limitations are reflected in README/docs/CHANGELOG where needed.

## Screenshots or fixture provenance

<!-- UI changes only. State that every attached asset is synthetic, public, or explicitly redistributable. -->
