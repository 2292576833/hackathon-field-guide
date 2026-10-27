import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e", fullyParallel: false, workers: 1, retries: 0, timeout: 90_000,
  reporter: "line", outputDir: ".runtime/e2e-results",
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000", channel: "msedge", headless: true,
    viewport: { width: 1440, height: 1000 }, screenshot: "off", video: "off", trace: "off" },
});
