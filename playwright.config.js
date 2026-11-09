import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', workers: 1,
  use: { headless: true, viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {} },
});
