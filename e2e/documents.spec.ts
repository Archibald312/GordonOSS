import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createAndLoginTestUser } from "./helpers/auth";

const SAMPLE_PDF = resolve(__dirname, "fixtures", "sample.pdf");

async function createProjectAndOpen(page: Page, name: string) {
  await page.goto("/projects");
  await page.getByTestId("new-project-button").click();
  await page.getByPlaceholder("Project name").fill(name);
  await page.getByRole("button", { name: /^create project$/i }).click();
  await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 15_000 });
}

async function uploadSamplePdf(page: Page) {
  await page.getByTestId("add-documents-button").click();
  // The hidden file input is inside the modal — mounted only when open.
  await page.getByTestId("add-docs-file-input").setInputFiles(SAMPLE_PDF);
  // Upload posts to R2 via the backend; the modal auto-selects the new doc.
  // Confirm stays disabled while `uploading` is true.
  const confirm = page.getByTestId("add-docs-confirm");
  await expect(confirm).toBeEnabled({ timeout: 60_000 });
  await confirm.click();
  // The document table on ProjectPage should render the new row.
  await expect(
    page.locator('[data-testid="document-row"][data-doc-filename="sample.pdf"]'),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe("documents", () => {
  test.beforeEach(async ({ page }) => {
    await createAndLoginTestUser(page, "docs");
    await createProjectAndOpen(page, `Docs Project ${Date.now()}`);
  });

  test("upload sample.pdf and see it in the project's document list", async ({ page }) => {
    await uploadSamplePdf(page);
  });

  test("download sample.pdf via the row action", async ({ page }) => {
    await uploadSamplePdf(page);

    const row = page.locator('[data-testid="document-row"][data-doc-filename="sample.pdf"]');
    await row.getByTestId("row-actions-toggle").click();

    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await page.getByTestId("row-action-download").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().toLowerCase()).toContain("sample");
  });

  test("delete sample.pdf via the row action", async ({ page }) => {
    await uploadSamplePdf(page);

    const row = page.locator('[data-testid="document-row"][data-doc-filename="sample.pdf"]');
    await row.getByTestId("row-actions-toggle").click();
    await page.getByTestId("row-action-delete").click();

    await expect(row).toHaveCount(0, { timeout: 15_000 });
  });
});
