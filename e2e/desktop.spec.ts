import { test, expect, type Page, type Route } from '@playwright/test';

// The app is built with NEXT_PUBLIC_API_URL='' (see playwright.config.ts), so the
// API and the VNC WebSocket are on this origin and are mocked here.

const SESSION_ID = '65f0c0ffee0000000000abcd';
const ACCESS_TOKEN = 'e2e-access-token';
const WS_TICKET = 'e2e-single-use-ticket';

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

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function openDesktop(
  page: Page,
  session: { isOwner: boolean; permissions?: 'view' | 'control' },
  options: { ticketsSupported?: boolean } = {}
) {
  await page.addInitScript((token) => {
    localStorage.setItem('clouddesk_access_token', token);
    localStorage.setItem('clouddesk_refresh_token', 'e2e-refresh-token');
  }, ACCESS_TOKEN);

  await page.route('**/api/**', (route) => json(route, { success: true, data: [] }));
  await page.route('**/api/auth/me', (route) => json(route, { success: true, data: USER }));
  await page.route(`**/api/sessions/${SESSION_ID}`, (route) =>
    json(route, {
      success: true,
      data: { id: SESSION_ID, status: 'connected', isActive: true, ...session },
    })
  );
  await page.route(`**/api/sessions/${SESSION_ID}/viewers`, (route) =>
    json(route, { success: true, data: { viewerCount: 1, viewers: [] } })
  );
  await page.route(`**/api/sessions/${SESSION_ID}/ws-ticket`, (route) =>
    options.ticketsSupported === false
      ? json(route, { success: false, error: { message: 'Route not found', code: 'NOT_FOUND' } }, 404)
      : json(route, { success: true, data: { ticket: WS_TICKET, expiresInMs: 30000 } })
  );

  // Capture the VNC WebSocket the frame opens instead of letting it hit the network
  const vncUrls: string[] = [];
  await page.routeWebSocket(/\/vnc\?/, (ws) => {
    vncUrls.push(ws.url());
    ws.close();
  });

  await page.goto(`/desktop/${SESSION_ID}`);
  return vncUrls;
}

test.describe('remote desktop viewer', () => {
  test('opens the VNC socket with a single-use ticket, never the access token', async ({ page }) => {
    const vncUrls = await openDesktop(page, { isOwner: true });

    const frame = page.locator('iframe');
    await expect(frame).toHaveAttribute('src', '/vnc.html?resize=1');
    await expect.poll(() => vncUrls.length).toBeGreaterThan(0);

    const url = new URL(vncUrls[0]);
    expect(url.protocol).toBe('ws:');
    expect(url.pathname).toBe('/vnc');
    expect(url.searchParams.get('sessionId')).toBe(SESSION_ID);
    expect(url.searchParams.get('ticket')).toBe(WS_TICKET);
    expect(url.searchParams.has('token')).toBe(false);
  });

  test('falls back to the access token against a backend without tickets', async ({ page }) => {
    const vncUrls = await openDesktop(page, { isOwner: true }, { ticketsSupported: false });

    await expect.poll(() => vncUrls.length).toBeGreaterThan(0);
    expect(new URL(vncUrls[0]).searchParams.get('token')).toBe(ACCESS_TOKEN);
  });

  test('opens view-only participants in view-only mode with a Leave button', async ({ page }) => {
    await openDesktop(page, { isOwner: false, permissions: 'view' });

    await expect(page.locator('iframe')).toHaveAttribute('src', '/vnc.html?viewOnly=1');
    await expect(page.getByText('View only')).toBeVisible();
    await expect(page.getByTitle('Leave session')).toBeVisible();
    await expect(page.getByTitle('Send Ctrl+Alt+Del')).toHaveCount(0);
  });
});
