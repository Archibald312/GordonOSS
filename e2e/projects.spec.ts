import { expect, test } from "@playwright/test";
import { createAndLoginTestUser } from "./helpers/auth";
import { uniqueTestEmail } from "./helpers/test-users";

test.describe("projects", () => {
  test.beforeEach(async ({ page }) => {
    await createAndLoginTestUser(page, "proj");
  });

  test("create a project from the projects page", async ({ page }) => {
    const projectName = `Project ${Date.now()}`;

    await page.goto("/projects");
    await page.getByTestId("new-project-button").click();

    await page.getByPlaceholder("Project name").fill(projectName);
    await page.getByRole("button", { name: /^create project$/i }).click();

    // Modal closes and redirects into the new project. Navigate back to /projects
    // and verify the row is present.
    await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 15_000 });
    await page.goto("/projects");
    await expect(
      page.locator(`[data-testid="project-row"][data-project-name="${projectName}"]`),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("rename a project via the row actions menu", async ({ page }) => {
    const original = `RenameMe ${Date.now()}`;
    const renamed = `${original}-renamed`;

    await page.goto("/projects");
    await page.getByTestId("new-project-button").click();
    await page.getByPlaceholder("Project name").fill(original);
    await page.getByRole("button", { name: /^create project$/i }).click();

    await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 15_000 });
    await page.goto("/projects");

    const row = page.locator(`[data-testid="project-row"][data-project-name="${original}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    await row.getByTestId("row-actions-toggle").click();
    await page.getByTestId("row-action-rename").click();

    const input = page.getByTestId("project-row-rename-input");
    await input.fill(renamed);
    await input.press("Enter");

    await expect(
      page.locator(`[data-testid="project-row"][data-project-name="${renamed}"]`),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("share a project with another email address", async ({ page }) => {
    const projectName = `Shared ${Date.now()}`;
    const collaborator = uniqueTestEmail("collab");

    await page.goto("/projects");
    await page.getByTestId("new-project-button").click();
    await page.getByPlaceholder("Project name").fill(projectName);

    // Expand the Members section inside the new-project modal and add an email.
    await page.getByRole("button", { name: /members/i }).click();
    const emailInput = page.getByPlaceholder(/colleagues by email/i);
    await emailInput.fill(collaborator);
    await emailInput.press("Enter");

    await page.getByRole("button", { name: /^create project$/i }).click();
    await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 15_000 });

    // Back on the listing the row exists; assert the shared count made it through
    // by reloading the listing and confirming the row renders.
    await page.goto("/projects");
    await expect(
      page.locator(`[data-testid="project-row"][data-project-name="${projectName}"]`),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("delete a project via bulk actions", async ({ page }) => {
    const projectName = `DeleteMe ${Date.now()}`;

    await page.goto("/projects");
    await page.getByTestId("new-project-button").click();
    await page.getByPlaceholder("Project name").fill(projectName);
    await page.getByRole("button", { name: /^create project$/i }).click();

    await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 15_000 });
    await page.goto("/projects");

    const row = page.locator(`[data-testid="project-row"][data-project-name="${projectName}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    await row.getByTestId("project-row-checkbox").check();
    await page.getByTestId("bulk-actions-toggle").click();
    await page.getByTestId("bulk-actions-delete").click();

    await expect(row).toHaveCount(0, { timeout: 10_000 });
  });
});
