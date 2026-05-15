import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createAndLoginTestUser } from "./helpers/auth";

const SAMPLE_PDF = resolve(__dirname, "fixtures", "sample.pdf");

// Chat depends on a real LLM provider. The frontend's default model is
// `gemini-3-flash-preview`, which is on the backend's free-tier list. The test
// env sets ALLOW_FREE_TIER_LLM=true and FREE_TIER_FIXTURE_ALLOWLIST=sample.pdf
// so the backend will route the call to Gemini's free tier — see
// `backend/src/lib/llm/freeTierGuard.ts`.

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

test.describe("chat", () => {
  test("ask a question about an uploaded PDF and receive a streamed answer with a citation", async ({
    page,
  }) => {
    test.setTimeout(240_000); // LLM round-trip on free tier can be slow

    await createAndLoginTestUser(page, "chat");
    await createProjectAndOpen(page, `Chat Project ${Date.now()}`);
    await uploadSamplePdf(page);

    // The project URL is the current path; the assistant tab lives at
    // /projects/{id}/assistant — switch to it explicitly rather than tab-click
    // so the test doesn't depend on the toolbar tab's accessible name.
    const projectPath = new URL(page.url()).pathname.replace(/\/$/, "");
    await page.goto(`${projectPath}/assistant`);

    // No chats yet — the empty-state "+ Create New" creates one and redirects
    // to /projects/{id}/assistant/chat/{chatId}.
    await page.getByTestId("new-chat-empty-state").click();
    await page.waitForURL(/\/assistant\/chat\/[a-f0-9-]+/, { timeout: 15_000 });

    const chatInput = page.getByTestId("chat-input");
    await chatInput.fill("What is this document about? Cite the source.");
    await chatInput.press("Enter");

    // Assistant message bubble appears as soon as streaming begins. Wait for
    // a citation marker to render inside it — that's how we know the model
    // grounded the answer against sample.pdf and finished at least one
    // citation token.
    const citation = page.getByTestId("citation-marker").first();
    await expect(citation).toBeVisible({ timeout: 180_000 });

    // Sanity: the assistant message exists and has substantive content.
    const assistantMessage = page.getByTestId("assistant-message").first();
    await expect(assistantMessage).toBeVisible();
    const text = await assistantMessage.innerText();
    expect(text.length).toBeGreaterThan(50);
  });
});
