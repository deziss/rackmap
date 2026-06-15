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

test.describe("Servers", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("servers page loads", async ({ page }) => {
    await page.goto("/servers");
    await expect(page.getByRole("heading", { name: /servers/i })).toBeVisible();
  });

  test("can search servers", async ({ page }) => {
    await page.goto("/servers");
    const search = page.getByPlaceholder(/search/i);
    await search.fill("nonexistent-hostname-xyz");
    await expect(page.getByText(/no servers|0 results/i)).toBeVisible({ timeout: 5000 });
  });

  test("add server dialog opens", async ({ page }) => {
    await page.goto("/servers");
    await page.getByRole("button", { name: /add server/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByLabel(/hostname/i)).toBeVisible();
  });
});
