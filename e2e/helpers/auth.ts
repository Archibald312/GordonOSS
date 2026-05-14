import type { Page } from "@playwright/test";
import { DEFAULT_TEST_PASSWORD, uniqueTestEmail } from "./test-users";

export interface TestUser {
  email: string;
  password: string;
  name: string;
}

/**
 * Creates a pre-confirmed user directly via the Supabase admin REST API.
 *
 * Supabase rate-limits the /signup endpoint (default ~3-4 emails/hour even
 * with "Confirm email" turned off), which kills any e2e suite that uses the
 * public signup form to seed test users.  This helper bypasses the rate
 * limit by hitting POST /auth/v1/admin/users with the service role key.
 *
 * Use this for tests that just need an authenticated user.  Only the one
 * test that specifically verifies the signup flow itself should call
 * signUpNewUser() below.
 */
async function createConfirmedUserViaAdmin(email: string, password: string): Promise<void> {
  const url = process.env.TEST_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.TEST_SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      "createConfirmedUserViaAdmin: TEST_SUPABASE_URL and TEST_SUPABASE_SECRET_KEY must be set",
    );
  }

  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });

  if (!res.ok) {
    throw new Error(
      `Supabase admin createUser failed: ${res.status} ${await res.text()}`,
    );
  }
}

/**
 * Creates a confirmed user via the admin API and logs them in through the
 * normal /login form.  This is the helper that 99 % of tests want — it
 * proves the login UI works without burning a public-signup-rate-limit
 * quota per test.
 */
export async function createAndLoginTestUser(
  page: Page,
  prefix = "user",
): Promise<TestUser> {
  const user: TestUser = {
    email: uniqueTestEmail(prefix),
    password: DEFAULT_TEST_PASSWORD,
    name: `Test ${prefix}`,
  };
  await createConfirmedUserViaAdmin(user.email, user.password);
  await logInExistingUser(page, user);
  return user;
}

/**
 * Signs up a fresh user via the /signup form and waits for the post-signup
 * redirect to /assistant.  Returns the credentials so tests can re-use
 * them for log-in / log-out flows.
 *
 * Use sparingly — Supabase rate-limits the signup endpoint.  Most tests
 * should call createAndLoginTestUser() instead.  Only the one test that
 * specifically verifies the signup flow should use this helper.
 */
export async function signUpNewUser(page: Page, prefix = "user"): Promise<TestUser> {
  const user: TestUser = {
    email: uniqueTestEmail(prefix),
    password: DEFAULT_TEST_PASSWORD,
    name: `Test ${prefix}`,
  };

  await page.goto("/signup");
  await page.locator("#name").fill(user.name);
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  await page.locator("#confirmPassword").fill(user.password);
  await page.getByRole("button", { name: /sign up/i }).click();

  // Signup shows a success message for ~2s then redirects to /assistant
  await page.waitForURL(/\/assistant/, { timeout: 15_000 });
  return user;
}

export async function logInExistingUser(page: Page, user: Pick<TestUser, "email" | "password">): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(user.email);
  await page.locator("#password").fill(user.password);
  await page.getByRole("button", { name: /log in/i }).click();
  await page.waitForURL(/\/assistant/, { timeout: 15_000 });
}

export async function logOut(page: Page): Promise<void> {
  await page.goto("/account");
  await page.getByRole("button", { name: /sign out/i }).click();
  await page.waitForURL(/^https?:\/\/[^/]+\/?$/, { timeout: 10_000 });
}
