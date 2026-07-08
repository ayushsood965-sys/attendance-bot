const config = require('./config');
const logger = require('./logger');
const { newPage, takeScreenshot, humanDelay, waitForCloudflare } = require('./browser');

/**
 * Login to HPU Backoffice.
 * 
 * The actual page has:
 *   - A Username input (placeholder "Username")
 *   - A Password input (placeholder "Password")  
 *   - A numeric captcha displayed as plain text (e.g. "41957")
 *   - A captcha input field to type the number
 *   - A LOGIN button
 * 
 * ASP.NET uses ContentPlaceHolder prefixes on IDs, so we use
 * flexible CSS selectors instead of exact IDs.
 */
async function login(geminiModel = null) {
  logger.info('Starting login process...');

  const page = await newPage();

  try {
    // 1. INJECT canvas text interceptor BEFORE navigating
    // The captcha is rendered on a <canvas> via fillText() — we intercept the call
    // to capture the text value directly from JavaScript (no OCR needed!)
    await page.evaluateOnNewDocument(() => {
      window.__capturedCanvasTexts = [];
      const originalFillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
        window.__capturedCanvasTexts.push(String(text));
        return originalFillText.apply(this, arguments);
      };
      // Also intercept strokeText just in case
      const originalStrokeText = CanvasRenderingContext2D.prototype.strokeText;
      CanvasRenderingContext2D.prototype.strokeText = function(text, x, y, maxWidth) {
        window.__capturedCanvasTexts.push(String(text));
        return originalStrokeText.apply(this, arguments);
      };
    });

    // 2. Navigate to login page
    logger.info(`Navigating to ${config.loginUrl}...`);
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });

    // 3. Wait for Cloudflare to clear
    logger.info('Waiting for Cloudflare verification...');
    await waitForCloudflare(page, 60000);

    // 4. Wait for the login form to actually render
    logger.info('Waiting for login form to render...');
    await waitForLoginForm(page);

    await takeScreenshot(page, 'login_page_loaded');
    logger.info(`Login page loaded: ${page.url()}`);

    // 4. Fill Username
    logger.info('Filling username...');
    const userFilled = await fillInputByStrategy(page, {
      strategies: [
        // By placeholder
        'input[placeholder*="User" i]',
        'input[placeholder*="user" i]',
        'input[placeholder*="Username" i]',
        // By ASP.NET ID patterns
        'input[id*="txtUserId" i]',
        'input[id*="txtUser" i]',
        'input[id*="UserId" i]',
        'input[id*="txtEmpCode" i]',
        'input[id*="UserName" i]',
        // By type: first visible text input
        'input[type="text"]:not([id*="captcha" i]):not([id*="Captcha"])',
      ],
      value: config.userId,
      fieldName: 'Username',
    });

    if (!userFilled) throw new Error('Could not find or fill Username field');

    await humanDelay(400, 800);

    // 5. Fill Password
    logger.info('Filling password...');
    const passFilled = await fillInputByStrategy(page, {
      strategies: [
        'input[type="password"]',
        'input[placeholder*="Password" i]',
        'input[id*="txtPassword" i]',
        'input[id*="Password" i]',
      ],
      value: config.password,
      fieldName: 'Password',
    });

    if (!passFilled) throw new Error('Could not find or fill Password field');

    await humanDelay(400, 800);

    // 6. Solve Captcha — read the displayed number and type it
    logger.info('Solving captcha...');
    await solveCaptchaOnPage(page, geminiModel);

    await humanDelay(600, 1200);
    await takeScreenshot(page, 'before_login_click');

    // 7. Click LOGIN button
    logger.info('Clicking LOGIN button...');
    const loginClicked = await clickLoginButton(page);

    if (!loginClicked) throw new Error('Could not find or click LOGIN button');

    // 8. Wait for navigation after login
    await humanDelay(3000, 5000);

    // Handle possible second Cloudflare challenge
    await waitForCloudflare(page, 20000);

    await takeScreenshot(page, 'post_login');

    // 9. Verify login success
    const currentUrl = page.url();
    logger.info(`Post-login URL: ${currentUrl}`);

    if (currentUrl.toLowerCase().includes('login')) {
      // Check for error messages
      const errorMsg = await page.evaluate(() => {
        // Look for any red/error text on page
        const selectors = [
          'span[style*="color:Red"]', 'span[style*="color: red"]', 'span[style*="color:red"]',
          '.text-danger', '.error', '.alert-danger',
          '#lblMessage', '#lblError', 'span[id*="lblMessage"]', 'span[id*="lblError"]',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim()) return el.textContent.trim();
        }
        // Scan all elements for red text
        const all = document.querySelectorAll('span, div, label, p');
        for (const el of all) {
          const color = window.getComputedStyle(el).color;
          if ((color === 'rgb(255, 0, 0)' || color === 'red') && el.textContent.trim().length > 3) {
            return el.textContent.trim();
          }
        }
        return null;
      });

      throw new Error(`Login failed: ${errorMsg || 'Still on login page after submission'}`);
    }

    logger.info('✅ Login successful! Dashboard loaded.');
    await takeScreenshot(page, 'dashboard');
    return page;

  } catch (error) {
    await takeScreenshot(page, 'login_error');
    logger.error('Login failed:', error);
    throw error;
  }
}

/**
 * Wait for the login form to render (after Cloudflare clears, 
 * the ASP.NET page still needs time to load its form elements).
 */
async function waitForLoginForm(page) {
  const maxWait = 30000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    // Check if any visible text or password input exists
    const hasForm = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="text"], input[type="password"]');
      for (const inp of inputs) {
        if (inp.offsetParent !== null || inp.offsetWidth > 0) return true;
      }
      // Also check for inputs with placeholders
      const placeholders = document.querySelectorAll('input[placeholder]');
      for (const inp of placeholders) {
        if (inp.type !== 'hidden') return true;
      }
      // Check for buttons (login button)
      const buttons = document.querySelectorAll('button, input[type="submit"], input[type="button"]');
      for (const btn of buttons) {
        if (btn.offsetParent !== null || btn.offsetWidth > 0) return true;
      }
      return false;
    });

    if (hasForm) {
      logger.info('Login form detected ✅');
      return true;
    }

    logger.debug('Waiting for form elements to render...');
    await humanDelay(1500, 2500);
  }

  // Last resort: dump what we can see
  const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500));
  logger.warn(`Form not detected after ${maxWait / 1000}s. Page text: ${bodyText}`);
  return false;
}

/**
 * Fill an input field using multiple selector strategies.
 * Tries each selector until one works.
 */
async function fillInputByStrategy(page, { strategies, value, fieldName }) {
  for (const selector of strategies) {
    try {
      const el = await page.$(selector);
      if (el) {
        // Check if element is visible
        const isVisible = await page.evaluate(el => {
          return el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0;
        }, el);

        if (!isVisible) continue;

        // Clear existing value and type new one
        await el.click({ clickCount: 3 });
        await el.type(value, { delay: 80 });

        const actualId = await page.evaluate(el => el.id, el);
        logger.info(`  ✅ ${fieldName} filled via "${selector}" (id: ${actualId})`);
        return true;
      }
    } catch (e) {
      // Try next strategy
    }
  }

  // Fallback: try finding by scanning all inputs
  const filled = await page.evaluate((val, field) => {
    const inputs = document.querySelectorAll('input');
    for (const inp of inputs) {
      const ph = (inp.placeholder || '').toLowerCase();
      const id = (inp.id || '').toLowerCase();
      const name = (inp.name || '').toLowerCase();
      const isVisible = inp.offsetParent !== null || inp.offsetWidth > 0;

      if (!isVisible || inp.type === 'hidden') continue;

      if (field === 'Username' && (inp.type === 'text') &&
          (ph.includes('user') || id.includes('user') || id.includes('emp') || name.includes('user'))) {
        inp.focus();
        inp.value = val;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return inp.id || 'found';
      }

      if (field === 'Password' && inp.type === 'password') {
        inp.focus();
        inp.value = val;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return inp.id || 'found';
      }
    }
    return null;
  }, value, fieldName);

  if (filled) {
    logger.info(`  ✅ ${fieldName} filled via DOM scan (id: ${filled})`);
    return true;
  }

  logger.error(`  ❌ ${fieldName} field not found with any strategy`);
  return false;
}

/**
 * Solve the captcha on the HPU login page.
 * 
 * The captcha is a <canvas> element (id="captcha") where a number is drawn
 * via fillText(). We intercept that call via evaluateOnNewDocument() to
 * capture the text directly — no OCR needed!
 * 
 * Fallback: screenshot the canvas and use Gemini Vision.
 */
async function solveCaptchaOnPage(page, geminiModel) {
  // STRATEGY 1: Read intercepted canvas fillText values
  const capturedTexts = await page.evaluate(() => window.__capturedCanvasTexts || []);
  logger.info(`  Intercepted canvas texts: ${JSON.stringify(capturedTexts)}`);

  // Find a numeric string among captured texts (the captcha number)
  const captchaValue = capturedTexts.find(t => /^\d{3,8}$/.test(t.trim()));

  if (captchaValue) {
    logger.info(`  ✅ Captcha value intercepted from canvas: "${captchaValue}"`);
    // Type it into the captcha input field
    const inputSel = '#cpatchaTextBox';
    try {
      await page.click(inputSel, { clickCount: 3 });
      await page.type(inputSel, captchaValue.trim(), { delay: 70 });
      logger.info(`  ✅ Captcha solved: typed "${captchaValue}" into ${inputSel}`);
      return true;
    } catch (e) {
      // Fallback: set value via DOM
      await page.evaluate((id, val) => {
        const el = document.getElementById(id);
        if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
      }, 'cpatchaTextBox', captchaValue.trim());
      logger.info(`  ✅ Captcha solved via DOM: "${captchaValue}"`);
      return true;
    }
  }

  // If characters were captured individually (e.g., "5", "1", "7", "8", "2")
  if (capturedTexts.length > 0) {
    const combined = capturedTexts.filter(t => /^\d$/.test(t.trim())).join('');
    if (combined.length >= 3 && combined.length <= 8) {
      logger.info(`  ✅ Captcha reconstructed from individual chars: "${combined}"`);
      const inputSel = '#cpatchaTextBox';
      await page.click(inputSel, { clickCount: 3 });
      await page.type(inputSel, combined, { delay: 70 });
      logger.info(`  ✅ Captcha solved: typed "${combined}" into ${inputSel}`);
      return true;
    }
  }
  const captchaInfo = await page.evaluate(() => {
    const result = { displayValue: null, displayId: null, inputId: null };

    // Collect ALL inputs to find the captcha display and input
    const inputs = document.querySelectorAll('input');
    const visibleTextInputs = [];

    for (const inp of inputs) {
      if (inp.type === 'hidden') continue;

      const id = (inp.id || '').toLowerCase();
      const val = (inp.value || '').trim();
      const isVisible = inp.offsetParent !== null || inp.offsetWidth > 0;

      if (!isVisible) continue;

      // Check if this is a captcha-related element (handles both "captcha" and "cpatcha")
      const isCaptchaRelated = id.includes('captcha') || id.includes('cpatcha') ||
                               id.includes('capcha') || id.includes('verify') || id.includes('code');

      // If it has a numeric value and is captcha-related, it's the display
      if (isCaptchaRelated && val && /^\d{3,8}$/.test(val)) {
        result.displayValue = val;
        result.displayId = inp.id;
      }
      // If it's captcha-related and empty (or has placeholder), it's the input
      else if (isCaptchaRelated && (!val || val.length === 0)) {
        result.inputId = inp.id;
      }

      // Track all visible text inputs
      if (inp.type === 'text' || inp.type === 'number' || inp.type === 'tel') {
        visibleTextInputs.push({
          id: inp.id,
          value: val,
          readonly: inp.readOnly,
          disabled: inp.disabled,
        });
      }
    }

    // If display not found by ID, look for any input with a 4-6 digit numeric value
    if (!result.displayValue) {
      for (const inp of visibleTextInputs) {
        if (inp.value && /^\d{3,8}$/.test(inp.value) && (inp.readonly || inp.disabled || inp.id.toLowerCase() !== 'username')) {
          result.displayValue = inp.value;
          result.displayId = inp.id;
          break;
        }
      }
    }

    // If input not found by ID, use the last empty text input (captcha answer is usually last)
    if (!result.inputId) {
      const emptyInputs = visibleTextInputs.filter(i => !i.value && !i.readonly && !i.disabled);
      if (emptyInputs.length > 0) {
        result.inputId = emptyInputs[emptyInputs.length - 1].id;
        result.inputGuessed = true;
      }
    }

    // Also check spans, labels, divs for displayed captcha text
    if (!result.displayValue) {
      const elements = document.querySelectorAll('span, label, div, td, strong, b, p');
      for (const el of elements) {
        const text = el.textContent?.trim();
        const id = (el.id || '').toLowerCase();
        if (text && /^\d{3,8}$/.test(text) && (el.offsetParent !== null)) {
          const isRelevant = id.includes('captcha') || id.includes('cpatcha') ||
                            id.includes('code') || text.length >= 4;
          if (isRelevant) {
            result.displayValue = text;
            result.displayId = el.id || 'text-element';
            break;
          }
        }
      }
    }

    return result;
  });

  logger.info(`  Captcha found: display="${captchaInfo.displayValue}" (${captchaInfo.displayId}), input="${captchaInfo.inputId}"`);

  if (captchaInfo.displayValue && captchaInfo.inputId) {
    // Type the captcha value into the input
    const inputSel = `#${CSS.escape(captchaInfo.inputId)}`;
    try {
      await page.click(inputSel, { clickCount: 3 });
    } catch (e) {
      // Try with escaped selector
      await page.evaluate(id => document.getElementById(id)?.focus(), captchaInfo.inputId);
    }
    await page.type(inputSel, captchaInfo.displayValue, { delay: 60 });
    logger.info(`  ✅ Captcha solved: typed "${captchaInfo.displayValue}" into #${captchaInfo.inputId}`);
    return true;
  }

  // Strategy 2: If we have the input but no display value, try reading via Gemini Vision
  if (captchaInfo.inputId && geminiModel) {
    logger.info('  Trying Gemini Vision to read captcha...');
    try {
      // Screenshot the captcha area (look for any element near the input)
      const captchaArea = await page.evaluate(inputId => {
        const input = document.getElementById(inputId);
        if (!input) return null;
        // Get the parent container that likely holds both the captcha display and input
        const parent = input.closest('div, tr, td, .form-group') || input.parentElement;
        if (parent) return parent.id || null;
        return null;
      }, captchaInfo.inputId);

      // Take screenshot of the whole login form area
      const screenshotBuffer = await page.screenshot({ encoding: 'base64', fullPage: false });
      const result = await geminiModel.generateContent([
        { inlineData: { mimeType: 'image/png', data: screenshotBuffer } },
        'Look at this login page. There is a captcha number displayed (a 4-6 digit number). What is the number? Return ONLY the number, nothing else.',
      ]);

      const answer = result.response.text().trim().replace(/\D/g, '');
      if (answer && answer.length >= 3) {
        const inputSel = `#${captchaInfo.inputId}`;
        await page.click(inputSel, { clickCount: 3 });
        await page.type(inputSel, answer, { delay: 60 });
        logger.info(`  ✅ Captcha solved via Gemini Vision: "${answer}"`);
        return true;
      }
    } catch (e) {
      logger.warn(`  Gemini Vision captcha failed: ${e.message}`);
    }
  }

  // Strategy 3: Brute force — find any 4-6 digit number on the page and any empty input
  logger.info('  Trying brute-force captcha detection...');
  const bruteForceSolved = await page.evaluate(() => {
    // Find ALL displayed numbers on the page
    const numbers = [];
    
    // Check input values
    document.querySelectorAll('input').forEach(inp => {
      const val = (inp.value || '').trim();
      if (val && /^\d{3,8}$/.test(val) && inp.type !== 'hidden' &&
          (inp.offsetParent !== null) && inp.id !== 'username') {
        numbers.push({ value: val, source: `input#${inp.id}` });
      }
    });

    // Check text content
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim();
      if (/^\d{4,6}$/.test(text) && walker.currentNode.parentElement?.offsetParent !== null) {
        numbers.push({ value: text, source: 'text-node' });
      }
    }

    // Find empty text inputs that could be the captcha answer field
    const emptyInputs = Array.from(document.querySelectorAll('input[type="text"]'))
      .filter(inp => !inp.value && !inp.readOnly && !inp.disabled &&
              (inp.offsetParent !== null) && inp.id !== 'username');

    if (numbers.length > 0 && emptyInputs.length > 0) {
      const captchaNum = numbers[0].value;
      const targetInput = emptyInputs[emptyInputs.length - 1]; // last empty input
      targetInput.focus();
      targetInput.value = captchaNum;
      targetInput.dispatchEvent(new Event('input', { bubbles: true }));
      targetInput.dispatchEvent(new Event('change', { bubbles: true }));
      return { value: captchaNum, inputId: targetInput.id, source: numbers[0].source };
    }

    return null;
  });

  if (bruteForceSolved) {
    logger.info(`  ✅ Captcha solved via brute-force: "${bruteForceSolved.value}" from ${bruteForceSolved.source} → #${bruteForceSolved.inputId}`);
    return true;
  }

  logger.warn('  ⚠️ Could not detect or solve captcha');
  return false;
}

/**
 * Click the LOGIN button using multiple strategies.
 */
async function clickLoginButton(page) {
  // Strategy 1: Click by text value (most reliable)
  const clicked = await page.evaluate(() => {
    const elements = document.querySelectorAll('input[type="submit"], button, input[type="button"], a');
    for (const el of elements) {
      const text = (el.value || el.textContent || '').trim().toUpperCase();
      if (text.includes('LOGIN')) {
        el.click();
        return true;
      }
    }
    return false;
  });
  
  if (clicked) {
    logger.info('  ✅ Login button clicked via text match');
    return true;
  }

  // Strategy 2: Click by common selectors
  const selectors = [
    'input[value*="Login" i]', 'input[value*="LOGIN"]',
    'button:has-text("LOGIN")', 'button:has-text("Login")',
    '#btnLogin', '#btnSubmit', '#Button1',
    'input[type="submit"]', 'button[type="submit"]',
    'input[id*="btnLogin" i]', 'input[id*="Login" i]',
    'a[id*="btnLogin" i]',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        // Check if visible
        const isVisible = await page.evaluate(el => el.offsetParent !== null || el.offsetWidth > 0, el);
        if (isVisible) {
          await el.click().catch(() => {});
          logger.info(`  ✅ Login button clicked via selector: ${sel}`);
          return true;
        }
      }
    } catch (e) { /* continue */ }
  }
  
  // Strategy 3: Try pressing Enter in the last input field
  logger.info('  Trying Enter key as fallback...');
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 3000));
  
  // Check if we navigated away from login page
  const currentUrl = page.url();
  if (!currentUrl.toLowerCase().includes('login')) {
    logger.info('  ✅ Login succeeded via Enter key fallback');
    return true;
  }

  return false;
}

module.exports = { login };
