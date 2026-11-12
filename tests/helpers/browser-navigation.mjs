import { setTimeout as delay } from 'node:timers/promises';

const socketRetryDelays = [250, 1000];

export async function gotoLocalPage(page, url) {
  for (const wait of socketRetryDelays) {
    try {
      return await page.goto(url);
    } catch (error) {
      // Chromium can transiently fail to allocate a local socket on Windows.
      if (!(error instanceof Error) || !error.message.includes('net::ERR_NO_BUFFER_SPACE'))
        throw error;
      console.warn(
        `Local Chromium navigation reported ERR_NO_BUFFER_SPACE, retrying in ${wait} ms`,
      );
      await delay(wait);
    }
  }
  return page.goto(url);
}
