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

test.describe("Access Requests", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("access requests page loads for admin", async ({ page }) => {
    await page.goto("/access-requests");
    await expect(page.getByRole("heading", { name: /access requests/i })).toBeVisible();
  });

  test("sidebar shows Access Requests link for admin", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /access requests/i })).toBeVisible();
  });
});
