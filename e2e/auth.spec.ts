import { test, expect, type Page, type Route } from '@playwright/test';

// The app under test is built with NEXT_PUBLIC_API_URL='' (see playwright.config.ts),
// so every API call goes to this origin under /api and is mocked per test.

const USER = {
  id: 'user-1',
  email: 'ada@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  role: 'user',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Answer any API call a test doesn't care about with an empty success payload */
async function stubRemainingApi(page: Page) {
  await page.route('**/api/**', (route) => json(route, 200, { success: true, data: [] }));
}

test.describe('public pages', () => {
  test('landing page renders with sign-in entry points', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/CloudDesk/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Your Cloud.');
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
  });

  test('login page shows the sign-in form', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});

test.describe('login', () => {
  test('shows the server error for wrong credentials instead of reloading', async ({ page }) => {
    await stubRemainingApi(page);
    await page.route('**/api/auth/login', (route) =>
      json(route, 401, {
        success: false,
        error: { message: 'Invalid email or password', code: 'INVALID_CREDENTIALS' },
      })
    );

    await page.goto('/login');
    await page.getByLabel('Email').fill(USER.email);
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('Invalid email or password')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('returns to the requested page after signing in', async ({ page }) => {
    await stubRemainingApi(page);
    await page.route('**/api/auth/login', (route) =>
      json(route, 200, {
        success: true,
        data: { user: USER, accessToken: 'access-token', refreshToken: 'refresh-token' },
      })
    );
    await page.route('**/api/auth/me', (route) => json(route, 200, { success: true, data: USER }));

    await page.goto('/login?redirect=%2Fsessions');
    await page.getByLabel('Email').fill(USER.email);
    await page.getByLabel('Password').fill('correct-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/sessions$/);
  });

  test('ignores off-site redirect targets', async ({ page }) => {
    await stubRemainingApi(page);
    await page.route('**/api/auth/login', (route) =>
      json(route, 200, {
        success: true,
        data: { user: USER, accessToken: 'access-token', refreshToken: 'refresh-token' },
      })
    );
    await page.route('**/api/auth/me', (route) => json(route, 200, { success: true, data: USER }));

    await page.goto('/login?redirect=%2F%2Fevil.example.com');
    await page.getByLabel('Email').fill(USER.email);
    await page.getByLabel('Password').fill('correct-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
  });
});

test.describe('signed-out access to protected pages', () => {
  test('dashboard sends the visitor to login and remembers where they were going', async ({ page }) => {
    await stubRemainingApi(page);

    await page.goto('/dashboard');

    await expect(page).toHaveURL(/\/login\?redirect=%2Fdashboard$/);
  });

  test('invite links survive the trip through login', async ({ page }) => {
    await stubRemainingApi(page);
    await page.route('**/api/sessions/invite-info/**', (route) =>
      json(route, 401, { success: false, error: { message: 'Authentication required', code: 'UNAUTHORIZED' } })
    );

    await page.goto('/join/invite-token-123');

    await expect(page).toHaveURL(/\/login\?redirect=%2Fjoin%2Finvite-token-123$/);
  });
});
