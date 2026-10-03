import { chromium } from 'playwright-core';
export function launchBrowser() {
  return chromium.launch({ ...(process.env.UI_BROWSER_EXECUTABLE
    ? { executablePath:process.env.UI_BROWSER_EXECUTABLE }
    : { channel:process.env.UI_BROWSER_CHANNEL || 'chrome' }), headless:true });
}
