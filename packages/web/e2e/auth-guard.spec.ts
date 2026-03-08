import { test, expect } from "@playwright/test";

/**
 * Auth guard tests run WITHOUT storageState (unauthenticated context).
 * They verify that protected routes redirect or reject unauthenticated users.
 */

test.describe("Unauthenticated access", () => {
  test("redirects to sign-in when accessing the home page without auth", async ({ page }) => {
    // Mock the auth session endpoint to return no session
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      })
    );

    await page.goto("/");

    // When unauthenticated, the home page should show "Sign in" messaging
    // rather than the prompt input
    await expect(page.getByText("Sign in to start a new session")).toBeVisible();
    await expect(page.getByPlaceholder("What do you want to build?")).not.toBeVisible();
  });

  test("sessions API returns 401 without auth", async ({ request }) => {
    // TODO: This test hits the real Next.js API route. It will only work
    // when a dev server is running. Consider using a lightweight test
    // server or mocking at the network level for CI.
    const response = await request.get("/api/sessions");
    expect(response.status()).toBe(401);
  });
});

test.describe("Non-admin access to secrets", () => {
  test("secrets API returns 401 without auth", async ({ request }) => {
    // TODO: To properly test admin-only 403 behavior, we need:
    //   1. A non-admin authenticated session cookie
    //   2. The secrets route to check admin status (currently it only checks auth)
    // For now, verify that unauthenticated access is rejected.
    const response = await request.get("/api/secrets");
    expect(response.status()).toBe(401);
  });

  test("repo-specific secrets API returns 401 without auth", async ({ request }) => {
    const response = await request.get("/api/repos/test-org/test-repo/secrets");
    expect(response.status()).toBe(401);
  });
});
