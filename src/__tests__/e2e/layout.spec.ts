import { test, expect } from '@playwright/test';
import {
  goToChat,
  goToExtensions,
  goToSettings,
  navRail,
  navRailItem,
  chatsToggle,
  themeToggle,
  chatListPanel,
  newChatButton,
  chatInput,
  rightPanel,
  panelCloseButton,
  bottomNav,
  bottomNavThemeToggle,
  collectConsoleErrors,
  filterCriticalErrors,
  waitForPageReady,
} from '../helpers';

test.describe('Layout', () => {
  test.describe('NavRail', () => {
    test('NavRail is visible on desktop', async ({ page }) => {
      await goToChat(page);
      await expect(navRail(page)).toBeVisible();
      const box = await navRail(page).boundingBox();
      expect(box).not.toBeNull();
      // NavRail is 56px (w-14) wide
      expect(box!.width).toBe(56);
    });

    test('NavRail has navigation items', async ({ page }) => {
      await goToChat(page);
      await expect(navRailItem(page, 'Chats')).toBeVisible();
      await expect(navRailItem(page, 'Extensions')).toBeVisible();
      await expect(navRailItem(page, 'Settings')).toBeVisible();
    });

    test('NavRail has theme toggle', async ({ page }) => {
      await goToChat(page);
      await expect(themeToggle(page)).toBeVisible();
    });
  });

  test.describe('ChatListPanel', () => {
    test('ChatListPanel opens when Chats button is clicked', async ({ page }) => {
      await goToChat(page);

      // On desktop at default viewport, ChatListPanel may auto-open
      // Ensure it's closed first by toggling if needed
      const panelVisible = await chatListPanel(page).isVisible().catch(() => false);
      if (panelVisible) {
        await chatsToggle(page).click();
        await page.waitForTimeout(300);
      }

      // Now open it
      await chatsToggle(page).click();
      await page.waitForTimeout(300);

      await expect(chatListPanel(page)).toBeVisible();
    });

    test('ChatListPanel has New Chat button', async ({ page }) => {
      await goToChat(page);

      // Ensure ChatListPanel is open
      if (!(await chatListPanel(page).isVisible().catch(() => false))) {
        await chatsToggle(page).click();
        await page.waitForTimeout(300);
      }

      await expect(newChatButton(page)).toBeVisible();
    });

    test('ChatListPanel has Threads heading', async ({ page }) => {
      await goToChat(page);

      // Ensure ChatListPanel is open
      if (!(await chatListPanel(page).isVisible().catch(() => false))) {
        await chatsToggle(page).click();
        await page.waitForTimeout(300);
      }

      await expect(chatListPanel(page).locator('text=Threads')).toBeVisible();
    });

    test('clicking Chats toggle closes ChatListPanel', async ({ page }) => {
      await goToChat(page);

      // Ensure ChatListPanel is open
      if (!(await chatListPanel(page).isVisible().catch(() => false))) {
        await chatsToggle(page).click();
        await page.waitForTimeout(300);
      }
      await expect(chatListPanel(page)).toBeVisible();

      // Close it
      await chatsToggle(page).click();
      await page.waitForTimeout(300);

      await expect(chatListPanel(page)).toBeHidden();
    });

    test('main content adjusts when ChatListPanel toggles', async ({ page }) => {
      await goToChat(page);

      // Ensure ChatListPanel is open
      if (!(await chatListPanel(page).isVisible().catch(() => false))) {
        await chatsToggle(page).click();
        await page.waitForTimeout(300);
      }

      const mainBefore = await page.locator('main').boundingBox();

      // Close ChatListPanel
      await chatsToggle(page).click();
      await page.waitForTimeout(300);

      const mainAfter = await page.locator('main').boundingBox();
      expect(mainAfter!.width).toBeGreaterThan(mainBefore!.width);
    });
  });

  test.describe('Theme Switch', () => {
    test('theme toggle is in the NavRail', async ({ page }) => {
      await goToChat(page);
      await expect(themeToggle(page)).toBeVisible();
    });

    test('clicking toggle switches to dark mode', async ({ page }) => {
      await goToChat(page);

      await expect(page.locator('html')).toHaveClass(/light/);

      await themeToggle(page).click();
      await page.waitForTimeout(300);

      await expect(page.locator('html')).toHaveClass(/dark/);
    });

    test('clicking toggle again switches back to light mode', async ({ page }) => {
      await goToChat(page);

      await themeToggle(page).click();
      await page.waitForTimeout(300);

      await themeToggle(page).click();
      await page.waitForTimeout(300);

      await expect(page.locator('html')).toHaveClass(/light/);
    });

    test('dark mode applies correct color scheme', async ({ page }) => {
      await goToChat(page);
      await themeToggle(page).click();
      await page.waitForTimeout(300);

      await expect(page.locator('html')).toHaveAttribute(
        'style',
        'color-scheme: dark;'
      );
    });
  });

  test.describe('Navigation Highlight', () => {
    test('Chats nav is highlighted on /chat', async ({ page }) => {
      await goToChat(page);
      const chatsNav = navRailItem(page, 'Chats');
      // The active item (button or its parent) has bg-sidebar-accent
      const classes = await chatsNav.getAttribute('class');
      expect(classes).toContain('bg-sidebar-accent');
    });

    test('Extensions nav is highlighted on /extensions', async ({ page }) => {
      await goToExtensions(page);
      const extensionsNav = navRailItem(page, 'Extensions');
      const classes = await extensionsNav.getAttribute('class');
      expect(classes).toContain('bg-sidebar-accent');
    });

    test('Settings nav is highlighted on /settings', async ({ page }) => {
      await goToSettings(page);
      const settingsNav = navRailItem(page, 'Settings');
      const classes = await settingsNav.getAttribute('class');
      expect(classes).toContain('bg-sidebar-accent');
    });
  });

  test.describe('Mobile Responsive', () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test('BottomNav is visible on mobile', async ({ page }) => {
      await goToChat(page);
      await expect(bottomNav(page)).toBeVisible();
    });

    test('NavRail is hidden on mobile', async ({ page }) => {
      await goToChat(page);
      await expect(navRail(page)).toBeHidden();
    });

    test('BottomNav has navigation items', async ({ page }) => {
      await goToChat(page);
      await expect(bottomNav(page).locator('text=Chats')).toBeVisible();
      await expect(bottomNav(page).locator('text=Extensions')).toBeVisible();
      await expect(bottomNav(page).locator('text=Settings')).toBeVisible();
      await expect(bottomNav(page).locator('text=Theme')).toBeVisible();
    });

    test('ChatListPanel opens as full-screen overlay on mobile', async ({ page }) => {
      await goToChat(page);

      // Close ChatListPanel if it's open
      if (await chatListPanel(page).isVisible().catch(() => false)) {
        // On mobile there's a "Back" button to close the panel
        const backBtn = chatListPanel(page).locator('button:has-text("Back")');
        if (await backBtn.isVisible().catch(() => false)) {
          await backBtn.click();
          await page.waitForTimeout(300);
        }
      }

      // Open ChatListPanel via BottomNav Chats button
      await bottomNav(page).locator('button:has-text("Chats")').click();
      await page.waitForTimeout(300);

      // ChatListPanel should be visible as full-screen overlay (fixed inset-0)
      await expect(chatListPanel(page)).toBeVisible();
      const box = await chatListPanel(page).boundingBox();
      expect(box).not.toBeNull();
      // On mobile it's fixed inset-0, so it should cover the viewport
      expect(box!.x).toBe(0);
      expect(box!.y).toBe(0);
    });

    test('mobile theme toggle in BottomNav works', async ({ page }) => {
      await goToChat(page);

      await expect(page.locator('html')).toHaveClass(/light/);

      await bottomNavThemeToggle(page).click();
      await page.waitForTimeout(300);

      await expect(page.locator('html')).toHaveClass(/dark/);
    });

    test('chat page renders correctly on mobile', async ({ page }) => {
      await goToChat(page);

      // Close ChatListPanel if it's open (it may auto-open)
      if (await chatListPanel(page).isVisible().catch(() => false)) {
        const backBtn = chatListPanel(page).locator('button:has-text("Back")');
        if (await backBtn.isVisible().catch(() => false)) {
          await backBtn.click();
          await page.waitForTimeout(300);
        }
      }

      // Chat input should be visible
      await expect(chatInput(page)).toBeVisible();

      // BottomNav should be visible
      await expect(bottomNav(page)).toBeVisible();
    });
  });

  test.describe('Three-Column Layout', () => {
    test('right panel is visible on /chat/[id]', async ({ page }) => {
      await page.goto('/chat/test-session');
      await waitForPageReady(page);

      // Three columns: NavRail + main + right panel
      await expect(navRail(page)).toBeVisible();
      await expect(page.locator('main')).toBeVisible();
      await expect(rightPanel(page)).toBeVisible();
    });

    test('right panel is hidden on non-chat routes', async ({ page }) => {
      await goToSettings(page);
      await expect(rightPanel(page)).toHaveCount(0);

      await goToExtensions(page);
      await expect(rightPanel(page)).toHaveCount(0);
    });

    test('main content adjusts width when panel collapses', async ({ page }) => {
      await page.goto('/chat/test-session');
      await waitForPageReady(page);

      const mainBefore = await page.locator('main').boundingBox();

      // Collapse the right panel
      await panelCloseButton(page).click();
      await page.waitForTimeout(300);

      const mainAfter = await page.locator('main').boundingBox();
      expect(mainAfter!.width).toBeGreaterThan(mainBefore!.width);
    });
  });
});
