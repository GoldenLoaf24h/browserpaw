# BrowserPaw verification

Run `pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm release:check`, and `git diff --check` for a local candidate. The gate includes syntax, type checking, lint, script tests, extension and Native tests, a non-deploy build, package smoke, documentation checks, and artifact consistency.

Run `pnpm test:e2e` with `BROWSERPAW_TEST_CHROME` set to Chrome for Testing. The runner correlates the installed extension with the identity reported by the live Chrome profile, drives CLI commands against a self-hosted fixture, and cleans its test-owned resources.

Keep the verification JSON, live runtime report, and packaged SHA-256 values as generated evidence. Run the final gate after source or documentation changes. The npm tarball smoke should use a clean directory outside the workspace dependency tree.

Remote CI verifies clean builds on Linux, Windows and macOS. Linux also runs the isolated Chrome fixture. Record the completed workflow runs and actual release asset hashes before publication. See [release procedure](releases/RELEASING.md).
