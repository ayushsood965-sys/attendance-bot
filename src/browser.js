const { connect } = require('puppeteer-real-browser');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

let browser = null;
let activePage = null;

/**
 * Launch a real browser instance using puppeteer-real-browser.
 * This bypasses Cloudflare Turnstile by using a real Chrome instance
 * with proper TLS fingerprint and anti-detection measures.
 * 
 * @returns {Promise<{browser: import('puppeteer').Browser, page: import('puppeteer').Page}>}
 */
async function launchBrowser() {
  if (browser && browser.connected) {
    logger.debug('Reusing existing browser instance');
    return { browser, page: activePage };
  }

  logger.info('Launching real browser instance (Cloudflare-compatible)...');

  const result = await connect({
    headless: config.headless === 'shell' ? 'auto' : config.headless,

    // Enable automatic Cloudflare Turnstile solving
    turnstile: true,

    // Ignore default experimental chrome-launcher flags that cause container crashes
    ignoreAllFlags: true,

    args: [
      '--window-size=1366,768',
      '--lang=en-IN',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--remote-debugging-address=0.0.0.0',
      '--disable-gpu',
      '--disable-software-rasterizer',
    ],

    customConfig: {
      logLevel: 'verbose',
      dumpio: true,
      ...(process.platform === 'linux' ? { chromePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium' } : {}),
    },

    // Stealth fingerprint settings
    fingerprint: true,

    // Connect timeout
    connectOption: {
      defaultViewport: {
        width: 1366,
        height: 768,
      },
    },
  });

  browser = result.browser;
  activePage = result.page;

  // Set timeouts on the page
  activePage.setDefaultNavigationTimeout(config.navigationTimeout);
  activePage.setDefaultTimeout(config.defaultTimeout);

  logger.info('Real browser launched successfully (Turnstile bypass enabled)');
  return { browser, page: activePage };
}

/**
 * Create a new page in the existing browser
 * @returns {Promise<import('puppeteer').Page>}
 */
async function newPage() {
  const { browser: b, page } = await launchBrowser();

  // Use the page from connect() for the first call (it has Turnstile solving)
  // For subsequent calls, create a new page
  if (activePage && !activePage.isClosed()) {
    const p = activePage;
    activePage = null; // Use it once, then create new pages
    return p;
  }

  const newP = await b.newPage();
  newP.setDefaultNavigationTimeout(config.navigationTimeout);
  newP.setDefaultTimeout(config.defaultTimeout);
  return newP;
}

/**
 * Take a screenshot and save it
 * @param {import('puppeteer').Page} page
 * @param {string} name - Screenshot name
 * @returns {Promise<string>} Path to saved screenshot
 */
async function takeScreenshot(page, name) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${name}_${timestamp}.png`;
    const filepath = path.resolve(config.screenshotDir, filename);

    await page.screenshot({ path: filepath, fullPage: true });
    logger.info(`Screenshot saved: ${filename}`);
    return filepath;
  } catch (error) {
    logger.warn(`Screenshot failed: ${error.message}`);
    return null;
  }
}

/**
 * Close the browser gracefully
 */
async function closeBrowser() {
  if (browser) {
    try {
      await browser.close();
      logger.info('Browser closed');
    } catch (error) {
      logger.warn('Error closing browser:', error.message);
    }
    browser = null;
    activePage = null;
  }
}

/**
 * Wait with a random human-like delay
 * @param {number} min - Minimum ms
 * @param {number} max - Maximum ms
 */
async function humanDelay(min = 500, max = 2000) {
  const delay = Math.floor(Math.random() * (max - min) + min);
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Wait for Cloudflare to clear (if challenge appears)
 * @param {import('puppeteer').Page} page
 * @param {number} maxWait - Maximum wait time in ms
 * @returns {Promise<boolean>} true if cleared
 */
async function waitForCloudflare(page, maxWait = 30000) {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    let pageContent = '';
    try {
      pageContent = await page.evaluate(() => document.body?.innerText || '');
    } catch (e) {
      logger.debug(`Navigation in progress or context destroyed (${e.message}), retrying...`);
      await humanDelay(1000, 2000);
      continue;
    }

    // Check if still on Cloudflare challenge
    if (
      pageContent.includes('Performing security verification') ||
      pageContent.includes('Verifying') ||
      pageContent.includes('Just a moment') ||
      pageContent.includes('Checking your browser')
    ) {
      logger.debug('Cloudflare challenge still active, waiting...');
      await humanDelay(2000, 4000);
      continue;
    }

    // Cloudflare cleared
    logger.info('Cloudflare verification passed ✅');
    return true;
  }

  logger.warn('Cloudflare verification timed out');
  return false;
}

module.exports = {
  launchBrowser,
  newPage,
  takeScreenshot,
  closeBrowser,
  humanDelay,
  waitForCloudflare,
};
