import { defineConfig } from '@playwright/test';
import 'dotenv/config'; // loads .env (DATABASE_URL etc.) — Fieldglass creds still come from the environment

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    // Headed by default (project convention). Set FIELDGLASS_HEADLESS=1 for long
    // unattended scrape runs — a headed window that gets closed mid-run kills the scrape.
    headless: process.env.FIELDGLASS_HEADLESS === '1',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
