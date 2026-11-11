# Legacy root test snapshots — 2026-11-11

These four files preserve the pre-migration working tree, including its existing edits. They are historical source, not runnable acceptance suites: Node strip-types cannot resolve the split in-page modules, some assertions encode retired source layouts, and the old token test accesses the user token file.

The collected replacements, duplicate coverage and retired assertions are listed in the single [v4.2.0 release record](../../../releases/v4.2.0.md#historical-regression-disposition). Run `pnpm verify` for current acceptance. Do not execute these snapshots against a user's profile.
