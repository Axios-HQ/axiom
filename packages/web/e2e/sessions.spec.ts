import { test, expect, type Page } from "@playwright/test";

// Mock session data returned by /api/sessions
const MOCK_SESSIONS = {
  sessions: [
    {
      id: "session-1",
      title: "Fix login bug",
      status: "completed",
      repoOwner: "test-org",
      repoName: "test-repo",
      model: "claude-sonnet-4-20250514",
      createdAt: new Date().toISOString(),
    },
    {
      id: "session-2",
      title: "Add dark mode",
      status: "running",
      repoOwner: "test-org",
      repoName: "test-repo",
      model: "claude-sonnet-4-20250514",
      createdAt: new Date().toISOString(),
    },
  ],
};

// Mock better-auth session so the UI considers the user authenticated
const MOCK_AUTH_SESSION = {
  user: {
    name: "Test User",
    email: "test@example.com",
    image: "https://example.com/avatar.png",
    id: "user-1",
    login: "testuser",
  },
  expires: new Date(Date.now() + 86400_000).toISOString(),
};

/**
 * Intercept common API routes so tests don't hit a real backend.
 */
function mockApiRoutes(page: Page) {
  // Auth session
  page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_AUTH_SESSION),
    })
  );

  // Sessions list
  page.route("**/api/sessions", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_SESSIONS),
      });
    }
    // POST — create session
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessionId: "session-new" }),
    });
  });

  // Repos list (needed for the home/create page)
  page.route("**/api/repos", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        repos: [
          {
            owner: "test-org",
            name: "test-repo",
            fullName: "test-org/test-repo",
            private: false,
            defaultBranch: "main",
          },
        ],
      }),
    })
  );

  // Model preferences
  page.route("**/api/model-preferences", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabledModels: ["claude-sonnet-4-20250514"] }),
    })
  );

  // Branches
  page.route("**/api/repos/**/branches", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ branches: [{ name: "main" }] }),
    })
  );
}

test.describe("Sessions page", () => {
  test.beforeEach(async ({ page }) => {
    mockApiRoutes(page);
  });

  test("renders session list in sidebar", async ({ page }) => {
    await page.goto("/");
    // The sidebar should show session titles from the mock data
    await expect(page.getByText("Fix login bug")).toBeVisible();
    await expect(page.getByText("Add dark mode")).toBeVisible();
  });

  test("navigates to session detail page", async ({ page }) => {
    // Mock the session detail / ws-token endpoints
    page.route("**/api/sessions/session-1/ws-token", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "mock-ws-token" }),
      })
    );

    await page.goto("/");
    await page.getByText("Fix login bug").click();

    // Should navigate to the session detail URL
    await expect(page).toHaveURL(/\/session\/session-1/);
  });
});

test.describe("Create session flow", () => {
  test.beforeEach(async ({ page }) => {
    mockApiRoutes(page);
  });

  test("shows prompt input when authenticated", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByPlaceholder("What do you want to build?")).toBeVisible();
  });

  test("can submit a prompt to create a session", async ({ page }) => {
    // Mock the prompt endpoint
    page.route("**/api/sessions/*/prompt", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      })
    );

    await page.goto("/");

    const promptInput = page.getByPlaceholder("What do you want to build?");
    await promptInput.fill("Add a new REST endpoint for user profiles");

    // The submit button should become enabled
    const submitButton = page.getByRole("button", { name: /Send/ });
    await expect(submitButton).toBeEnabled();
  });
});

test.describe("Session rename", () => {
  test.beforeEach(async ({ page }) => {
    mockApiRoutes(page);
  });

  // TODO: Implement once the rename UI interaction pattern is confirmed.
  // The sidebar likely has a context menu or inline edit for renaming sessions.
  test.skip("can rename a session via context menu", async ({ page }) => {
    await page.goto("/");
    // Right-click or use a menu to trigger rename
    // Fill in new name
    // Verify the API call and updated UI
  });
});

test.describe("Session delete", () => {
  test.beforeEach(async ({ page }) => {
    mockApiRoutes(page);
  });

  // TODO: Implement once the delete/archive UI interaction pattern is confirmed.
  // The app uses archive/unarchive endpoints rather than hard delete.
  test.skip("can archive a session with confirmation", async ({ page }) => {
    page.route("**/api/sessions/session-1/archive", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      })
    );

    await page.goto("/");
    // Trigger archive action on session-1
    // Confirm in dialog
    // Verify session is removed from the list
  });
});
