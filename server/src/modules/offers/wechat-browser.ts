import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { articleUrlSchema, parseWechatPage } from './wechat-articles';

const articleOrigin = 'https://mp.weixin.qq.com';
const staticOrigin = 'https://res.wx.qq.com';
const timeout = 12_000;
const pagePolicy = [
  "default-src 'none'",
  "script-src 'self' https://res.wx.qq.com 'unsafe-inline'",
  "style-src 'self' https://res.wx.qq.com 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts allow-same-origin',
].join('; ');

async function readArticle(browser: Browser, url: string) {
  const page = await browser.newPage({ serviceWorkers: 'block', acceptDownloads: false });
  try {
    const session = await page.context().newCDPSession(page);
    session.on('Fetch.requestPaused', async (event) => {
      const { requestId, request, resourceType, responseStatusCode, responseErrorReason, responseHeaders } = event;
      try {
        if (responseStatusCode === undefined && !responseErrorReason) {
          const origin = new URL(request.url).origin;
          const allowedStatic = (resourceType === 'Script' || resourceType === 'Stylesheet')
            && (origin === articleOrigin || origin === staticOrigin);
          if (request.method === 'GET' && (allowedStatic || resourceType === 'Document' && request.url === url)) {
            await session.send('Fetch.continueRequest', { requestId });
            return;
          }
        } else if (responseStatusCode === 200) {
          if (resourceType === 'Document') {
            await session.send('Fetch.continueResponse', {
              requestId, responseCode: 200, responseHeaders: [
                ...(responseHeaders ?? []),
                { name: 'Content-Security-Policy', value: pagePolicy },
              ],
            });
          } else await session.send('Fetch.continueResponse', { requestId });
          return;
        }
        // Stop redirects (including verification pages) and all unrelated requests.
        await session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      } catch { /* Navigation can finish before Chromium handles a cancelled request. */ }
    });
    await session.send('Fetch.enable', { patterns: [{ requestStage: 'Request' }, { requestStage: 'Response' }] });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const content = page.locator('#js_content').filter({ hasText: /\S/ });
    const html = await content.evaluate((body) => {
      const html = body.outerHTML;
      return html.length <= 1_500_000 ? html : '';
    }, undefined, { timeout: 4000 });
    return parseWechatPage(url, html);
  } finally {
    await page.context().close().catch(() => {});
  }
}

export function createWechatArticleBrowser() {
  let browser: Promise<Browser | undefined> | undefined;
  let unavailable = false;
  return {
    get unavailable() { return unavailable; },
    async read(value: string) {
      const parsed = articleUrlSchema.safeParse(value);
      if (!parsed.success) return;
      const executablePath = process.env.WECHAT_ARTICLE_CHROMIUM;
      if (!executablePath) { unavailable = true; return; }
      browser ??= chromium.launch({
        executablePath, chromiumSandbox: true, timeout,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG },
      }).catch(() => { unavailable = true; return undefined; });
      const running = await browser;
      if (running) return readArticle(running, parsed.data).catch(() => undefined);
    },
    async close() {
      await (await browser)?.close().catch(() => {});
    },
  };
}
