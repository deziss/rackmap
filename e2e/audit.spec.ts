import { test, expect, type Page } from "@playwright/test";

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "admin1234";

async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("/", { timeout: 10000 });
}

test.describe("Audit Log", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("audit page renders log entries", async ({ page }) => {
    await page.goto("/audit");
    await expect(page.getByRole("heading", { name: /audit log/i })).toBeVisible();
  });

  test("login creates auth.sign_in audit entry", async ({ page }) => {
    await page.goto("/audit");
    await expect(page.getByText("auth.sign_in")).toBeVisible({ timeout: 5000 });
  });

  test("action filter works", async ({ page }) => {
    await page.goto("/audit");
    await page.getByPlaceholder(/action filter/i).fill("auth.sign_in");
    await expect(page.getByText("auth.sign_in").first()).toBeVisible({ timeout: 5000 });
  });
});
