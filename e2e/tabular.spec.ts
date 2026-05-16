import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createAndLoginTestUser } from "./helpers/auth";

const SAMPLE_PDF = resolve(__dirname, "fixtures", "sample.pdf");

// Tabular extraction depends on a real LLM provider. The backend's
// `tabular_model` defaults to `gemini-3-flash-preview`. The free-tier guard
// was removed (see CLAUDE.md "Future capabilities" for the planned
// reintroduction); the test calls Gemini directly on the public-domain
// fixture.

async function createProjectAndOpen(page: Page, name: string) {
  await page.goto("/projects");
  await page.getByTestId("new-project-button").click();
  await page.getByPlaceholder("Project name").fill(name);
  await page.getByRole("button", { name: /^create project$/i }).click();
  await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 15_000 });
}

async function uploadSamplePdf(page: Page) {
  await page.getByTestId("add-documents-button").click();
  await page.getByTestId("add-docs-file-input").setInputFiles(SAMPLE_PDF);
  const confirm = page.getByTestId("add-docs-confirm");
  await expect(confirm).toBeEnabled({ timeout: 60_000 });
  await confirm.click();
  await expect(
    page.locator('[data-testid="document-row"][data-doc-filename="sample.pdf"]'),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe("tabular review", () => {
  test("create a review, add a column, run, and see a cell populate with a citation", async ({
    page,
  }) => {
    test.setTimeout(300_000); // LLM extraction across rows × columns

    await createAndLoginTestUser(page, "tab");
    await createProjectAndOpen(page, `Tab Project ${Date.now()}`);
    await uploadSamplePdf(page);

    // Switch to the project's Tabular Reviews tab.  Going via URL is more
    // reliable than clicking the toolbar tab whose accessible name may drift.
    const projectPath = new URL(page.url()).pathname.replace(/\/$/, "");
    await page.goto(`${projectPath}/tabular-reviews`);

    // No reviews yet — the empty-state "+ Create New" opens AddNewTRModal.
    // When invoked from inside a project, the modal is in projectMode and
    // pre-selects all ready docs, so we only need to provide the title.
    await page.getByTestId("new-review-empty-state").click();
    await page.getByPlaceholder(/review name/i).fill(`Review ${Date.now()}`);
    await page.getByTestId("add-tr-create").click();
    await page.waitForURL(/\/tabular-reviews\/[a-f0-9-]+/, { timeout: 15_000 });

    // Add one column with an explicit prompt (skipping the "auto-generate prompt"
    // button, which would burn an extra LLM call).  The empty-state Add Columns
    // button only renders when both docs and columns are empty; once a doc is
    // attached (which it is, from the project), the toolbar's Add Columns
    // button is the canonical trigger.
    await page.getByTestId("add-column-button").click();
    await page.getByTestId("column-name-input").fill("Summary");
    await page
      .getByTestId("column-prompt-input")
      .fill(
        "In one sentence, summarize what this document is about. Cite the source.",
      );
    await page.getByTestId("add-column-submit").click();

    // Kick off generation.  Run is disabled while the columns_config save is in
    // flight after Add — wait for it to re-enable before clicking.
    const run = page.getByTestId("generate-cells");
    await expect(run).toBeEnabled({ timeout: 30_000 });
    await run.click();

    // Wait for at least one cell-citation chip to render inside any cell.
    const citation = page.getByTestId("cell-citation").first();
    await expect(citation).toBeVisible({ timeout: 240_000 });

    // Sanity: at least one cell is in the `ready` state.
    const readyCell = page
      .locator('[data-testid="tabular-cell"][data-cell-status="ready"]')
      .first();
    await expect(readyCell).toBeVisible();
  });
});
