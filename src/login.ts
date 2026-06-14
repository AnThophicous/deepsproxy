/*
 * File: login.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { initPlaywright, closePlaywright, activePage, getDeepSeekHeaders } from './services/playwright.ts';

async function main() {
  console.log('Opening DeepSeek to allow login...');
  await initPlaywright(false); // false = not headless
  if (activePage) {
    await activePage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
  } else {
    console.error('Failed to get active page');
    process.exit(1);
  }
  console.log('Browser opened. Please login to chat.deepseek.com.');
  console.log('Waiting until the chat input is available, then DeepsProxy will capture the session cache automatically.');

  try {
    await activePage.waitForSelector('textarea, [role="textbox"], [contenteditable="true"]', { timeout: 0 });
    console.log('Login detected. Capturing DeepSeek session headers...');
    await getDeepSeekHeaders(true, { allowBrowser: true });
    console.log('Session cache saved. You can now run npm start without keeping Playwright open.');
  } finally {
    await closePlaywright();
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await closePlaywright();
  process.exit(1);
});
