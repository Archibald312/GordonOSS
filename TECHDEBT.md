# Tech Debt & Follow-ups

Living list of issues surfaced during the CI / test-suite work that are
worth addressing but were not blocking the initial green build. Tighten
these one by one; check items off as they land.

When you fix an item, also remove the corresponding `eslint-disable` /
permissive rule / workaround it references.

---

## High priority

### Re-enable skipped Playwright specs once selectors are fixed
**Files:** `e2e/chat.spec.ts`, `e2e/documents.spec.ts`, `e2e/projects.spec.ts`, `e2e/tabular.spec.ts`

All four product-flow specs are wrapped in `test.describe.skip()`.  The
auth setup (`createAndLoginTestUser`) works — proven by all four auth
tests in `e2e/auth.spec.ts` passing.  Each spec then fails inside the
test body on selectors / flows that don't match the current frontend
(e.g. `createProject` helper in `documents.spec.ts`, the "new project"
button locator in `projects.spec.ts`, the chat input flow, etc.).

To re-enable:

1. Pull the most recent `playwright-report` artefact from a CI run
   (Actions → run → bottom of page → "Artifacts" → `playwright-report`).
2. Unzip and open `index.html`.
3. Pick one test, look at the screenshot / trace / video at the
   failure point.  Update the spec's selectors / flow to match the
   current UI.
4. Change `test.describe.skip(...)` → `test.describe(...)` for that
   file (or only un-skip individual tests with `test.only` while
   iterating).
5. Push; verify in CI.  Repeat for the next file.

Until these are re-enabled the e2e job is effectively a smoke test of
the auth stack only.  That is still a strict improvement over no e2e
in CI — the four passing auth tests catch the kinds of regressions
that broke us during initial bring-up (rate-limit blow-ups, race
conditions in login/logout, missing env vars).

### `auth › log-out returns the user to the marketing root` now fails
**File:** `e2e/auth.spec.ts:31`

This test passed previously and now times out: after sign-out the browser
lands at `/login` instead of the marketing root `/`. Likely the 100 ms
auth-guard debounce in `(pages)/layout.tsx` (documented below) is losing
the race differently now, OR the redirect-after-logout target was changed
without updating the spec. Confirm whether the intended post-logout
destination is `/` or `/login`, then either fix the redirect or update
the test expectation. Surfaced during the chatTools tool-registry refactor
e2e run; pre-existing — not caused by that change.

### Test Supabase project missing `public.user_profiles` migration
**Symptom:** During e2e signup the backend logs
`Could not find the table 'public.user_profiles' in the schema cache`,
and the signup helper warns
`failed to persist profile fields`.

Signup itself still completes (the user row in `auth.users` is created
and login works), but profile metadata isn't persisted. The test
Supabase project is behind on migrations relative to the codebase. Apply
the missing migration from `supabase/` to the test project. Cosmetic
today — surfaces in the e2e console but doesn't fail any test.

### Login & logout race conditions — patched, not properly fixed
**File:** `frontend/src/app/(pages)/layout.tsx`

The `(pages)` route group's auth guard does
`useEffect(() => { if (!authLoading && !isAuthenticated) router.push("/login") }, ...)`.
This races every other code path that does an explicit redirect:

- **Login:** `login/page.tsx::handleLogin` calls `router.push("/assistant")`
  immediately after `signInWithPassword` resolves. AuthContext's
  `onAuthStateChange` listener hasn't fired yet, so the layout sees
  `isAuthenticated:false` and pushes `/login` first.
- **Logout:** `account/page.tsx::handleLogout` calls `router.push("/")`
  after `signOut()`. AuthContext flips `isAuthenticated:false`, the
  layout pushes `/login`, which races the explicit push to `/`.

**Current workaround:** the layout's redirect is debounced by 100 ms so
explicit `router.push` calls win. The cleanup clears the timer if the
component unmounts or auth state changes again. Works, but a real fix
would coordinate the redirects properly — e.g. expose a `signingOut`
flag from `AuthContext`, or move the auth guard to a Next.js
middleware / `redirect()` call so the race window doesn't exist.

Anyone touching auth flow should be aware of this and either remove the
debounce + fix it properly, or preserve the debounce when adding new
redirect paths.

---

## Medium priority

### Frontend ESLint warnings (95)
**File:** `frontend/eslint.config.mjs`

The frontend config has day-one permissive overrides so CI doesn't block
on existing upstream code. Tighten these as the team cleans up:

| Rule | Current | Target | Notes |
|---|---|---|---|
| `react-hooks/set-state-in-effect` | warn | error | ~15 occurrences; real perf anti-pattern |
| `react-hooks/refs` | warn | error | 2 in `ChatView.tsx` |
| `react-hooks/immutability` | warn | error | 1 in `DocView.tsx` (`scrollToHighlightOnPage` accessed before declared) |
| `react-hooks/static-components` | warn | error | 1 in `WFColumnViewModal.tsx` (`const FormatIcon = formatIcon(...)`) |
| `react/no-unescaped-entities` | warn | error | 3 occurrences; trivial fix (`'` → `&apos;`) |
| `@typescript-eslint/no-explicit-any` | off | warn | Many occurrences across both backend and frontend |
| `@typescript-eslint/no-require-imports` | off | warn | Only used in `src/scripts/` and a few conditional loads |

### Backend ESLint warnings (7)
**File:** `backend/eslint.config.js`

Unused-vars warnings in `chatTools.ts`, `docxTrackedChanges.ts`,
`projects.ts`, `tabular.ts`. Either delete the dead code or prefix the
identifiers with `_` to silence the rule properly. Once cleaned up,
consider promoting `@typescript-eslint/no-unused-vars` from `warn` to
`error`.

### `@anthropic-ai/sdk` moderate vuln
**Source:** `npm audit` in `backend/`

`@anthropic-ai/sdk` 0.79.0–0.91.0 has a moderate insecure-file-perm
issue in the Local Filesystem Memory Tool. Fix requires `npm audit fix
--force`, which upgrades to 0.96.0 (breaking change). Schedule a
maintenance window to do the upgrade, smoke-test the LLM paths, and
ship. Below the `--audit-level=high` CI threshold so it does not block.

### Frontend `postcss` moderate vulns (4)
**Source:** `npm audit` in `frontend/`

`postcss` <8.5.10 has an XSS-via-unescaped-`</style>` issue. The only
`npm audit fix --force` available downgrades `next` to 9.3.3 — not
viable. Wait for Next.js to bump its transitive dependency, then
re-audit. Below the `--audit-level=high` CI threshold.

---

## Low priority / housekeeping

### Local Node version
**Symptom:** `npm warn EBADENGINE` on `eslint-visitor-keys@5.0.1` —
requires Node `^20.19 || ^22.13 || >=24`, local is `v23.9.0`.

CI uses Node 22 (LTS) and is unaffected. For local development, either:
- Switch local Node to a supported version (22 LTS recommended), or
- Add a `.nvmrc` / `.node-version` pinning Node 22 so contributors
  auto-switch.

### `frontend/src/scripts/convert-courts-to-ts.js`
One-off CJS conversion script. Currently in `globalIgnores` of the
frontend ESLint config. If the script is no longer needed, delete it
and remove the ignore entry. If it stays, port it to ESM so
`@typescript-eslint/no-require-imports` can be re-enabled.

### Branch protection on `main`
Once CI has run green at least once, lock `main` down:
**Settings → Branches → Branch protection rules → `main` →
Require status checks: `lint`, `test-unit`, `test-e2e`, `audit`**.

### Rotate exposed test secrets
During earlier debugging the Supabase test service-role key and the
Gemini test key were quoted in a transcript. Rotate both in the
respective dashboards and update the corresponding GitHub Actions
secrets when convenient — risk is low (test project only) but hygiene
matters.

---

## Done

<!-- Move items here as they're fixed. Include the commit SHA. -->
