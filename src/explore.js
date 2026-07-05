/**
 * Exploration script v2 - with extended waits for dynamic content loading
 * and iframe detection after Cloudflare bypass.
 * 
 * Usage: node src/explore.js
 */
require('dotenv').config();

const config = require('./config');
const logger = require('./logger');
const { newPage, takeScreenshot, closeBrowser, humanDelay, waitForCloudflare } = require('./browser');
const fs = require('fs');
const path = require('path');

// Force non-headless for exploration
config.headless = false;

async function explore() {
  let page;

  try {
    logger.info('=== EXPLORATION MODE v2 (Real Browser) ===\n');

    page = await newPage();

    // ========== STEP 1: NAVIGATE & BYPASS CLOUDFLARE ==========
    logger.info('--- Step 1: Navigate to Login Page ---');
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    logger.info('Waiting for Cloudflare verification...');
    const cfCleared = await waitForCloudflare(page, 60000);

    if (!cfCleared) {
      logger.warn('Cloudflare may still be active');
      await takeScreenshot(page, 'cf_stuck');
    }

    // CRITICAL: Wait much longer for the actual page to render after CF clears
    logger.info('Waiting for page to fully render after Cloudflare...');
    await new Promise(resolve => setTimeout(resolve, 8000));

    // Try waiting for a form element or any input to appear
    try {
      await page.waitForSelector('input:not([type="hidden"])', { timeout: 15000 });
      logger.info('✅ Form input elements detected!');
    } catch {
      logger.warn('No visible input elements found after 15s, checking page state...');
    }

    await takeScreenshot(page, 'explore_page_loaded');
    logger.info(`Current URL: ${page.url()}`);

    // ========== DUMP FULL PAGE STATE ==========
    logger.info('\n--- Page Structure Analysis ---');

    const pageState = await page.evaluate(() => {
      const state = {
        url: window.location.href,
        title: document.title,
        bodyTextPreview: document.body?.innerText?.substring(0, 1500),
        iframeCount: document.querySelectorAll('iframe').length,
        iframes: [],
        allInputs: [],
        allSelects: [],
        allButtons: [],
        allForms: [],
        allLinks: [],
        htmlLength: document.documentElement?.outerHTML?.length,
      };

      // Check for iframes
      document.querySelectorAll('iframe').forEach(iframe => {
        state.iframes.push({
          id: iframe.id,
          name: iframe.name,
          src: iframe.src,
          width: iframe.width,
          height: iframe.height,
        });
      });

      // Check all forms
      document.querySelectorAll('form').forEach(form => {
        state.allForms.push({
          id: form.id,
          name: form.name,
          action: form.action,
          method: form.method,
          childCount: form.children.length,
        });
      });

      // Get ALL inputs (including hidden)
      document.querySelectorAll('input').forEach(el => {
        state.allInputs.push({
          id: el.id,
          name: el.name,
          type: el.type,
          placeholder: el.placeholder,
          value: el.type === 'password' ? '***' : el.value?.substring(0, 50),
          visible: el.offsetParent !== null || el.offsetWidth > 0,
          parentId: el.parentElement?.id || '',
        });
      });

      document.querySelectorAll('select').forEach(el => {
        const options = Array.from(el.options).map(o => ({
          value: o.value,
          text: o.text.trim(),
        }));
        state.allSelects.push({
          id: el.id,
          name: el.name,
          options,
          visible: el.offsetParent !== null,
        });
      });

      document.querySelectorAll('input[type="submit"], input[type="button"], button, a.btn').forEach(el => {
        state.allButtons.push({
          id: el.id,
          name: el.name || '',
          type: el.type || el.tagName,
          value: el.value || el.textContent?.trim()?.substring(0, 50),
          visible: el.offsetParent !== null,
        });
      });

      // Get all links
      document.querySelectorAll('a').forEach(a => {
        const text = a.textContent?.trim();
        if (text && text.length > 0 && text.length < 100) {
          state.allLinks.push({
            text,
            href: a.href,
            id: a.id,
          });
        }
      });

      return state;
    });

    logger.info(`Page title: "${pageState.title}"`);
    logger.info(`HTML size: ${pageState.htmlLength} chars`);
    logger.info(`Iframe count: ${pageState.iframeCount}`);
    logger.info(`Forms: ${pageState.allForms.length}`);
    logger.info(`Inputs: ${pageState.allInputs.length}`);
    logger.info(`Selects: ${pageState.allSelects.length}`);
    logger.info(`Buttons: ${pageState.allButtons.length}`);
    logger.info(`Links: ${pageState.allLinks.length}`);
    logger.info(`\nBody text preview:\n${pageState.bodyTextPreview}\n`);

    if (pageState.iframes.length > 0) {
      logger.info('📌 IFRAMES DETECTED:');
      pageState.iframes.forEach(f => logger.info(`  iframe: id="${f.id}" name="${f.name}" src="${f.src}"`));
    }

    if (pageState.allForms.length > 0) {
      logger.info('\n📌 FORMS:');
      pageState.allForms.forEach(f => logger.info(`  form: id="${f.id}" action="${f.action}" children=${f.childCount}`));
    }

    if (pageState.allInputs.length > 0) {
      logger.info('\n📌 ALL INPUTS:');
      pageState.allInputs.forEach(i => {
        logger.info(`  input: id="${i.id}" name="${i.name}" type="${i.type}" visible=${i.visible} value="${i.value}"`);
      });
    }

    // Save full HTML for analysis
    const fullHtml = await page.evaluate(() => document.documentElement.outerHTML);
    const htmlPath = path.resolve(config.screenshotDir, 'page_source.html');
    fs.writeFileSync(htmlPath, fullHtml);
    logger.info(`\n📄 Full page HTML saved to: ${htmlPath}`);

    // ========== CHECK FOR IFRAMES AND SWITCH CONTEXT ==========
    if (pageState.iframeCount > 0) {
      logger.info('\n--- Checking iframe contents ---');
      const frames = page.frames();
      logger.info(`Total frames: ${frames.length}`);

      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const frameUrl = frame.url();
        logger.info(`Frame ${i}: url="${frameUrl}"`);

        if (frameUrl && !frameUrl.includes('about:blank') && !frameUrl.includes('cloudflare')) {
          try {
            const frameInputs = await frame.evaluate(() => {
              return Array.from(document.querySelectorAll('input')).map(el => ({
                id: el.id,
                name: el.name,
                type: el.type,
                visible: el.offsetParent !== null,
              }));
            });

            if (frameInputs.length > 0) {
              logger.info(`  Frame ${i} has ${frameInputs.length} inputs:`);
              frameInputs.forEach(inp =>
                logger.info(`    input: id="${inp.id}" type="${inp.type}" visible=${inp.visible}`)
              );
            }
          } catch (e) {
            logger.debug(`  Could not access frame ${i}: ${e.message}`);
          }
        }
      }
    }

    // ========== IF WE HAVE VISIBLE INPUTS, TRY TO LOGIN ==========
    const visibleInputs = pageState.allInputs.filter(i => i.visible && i.type !== 'hidden');

    if (visibleInputs.length === 0) {
      logger.warn('\n⚠️ No visible form inputs found on main page!');
      logger.info('The login form may be loading via AJAX or inside a frame.');
      logger.info('Waiting 15 more seconds and trying again...');

      await new Promise(resolve => setTimeout(resolve, 15000));
      await takeScreenshot(page, 'explore_after_extra_wait');

      // Check again
      const retryInputs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(el => ({
          id: el.id, name: el.name, type: el.type,
          visible: el.offsetParent !== null || el.offsetWidth > 0,
        }));
      });

      logger.info(`After extra wait - found ${retryInputs.length} non-hidden inputs:`);
      retryInputs.forEach(i => logger.info(`  input: id="${i.id}" type="${i.type}" visible=${i.visible}`));

      if (retryInputs.length === 0) {
        // Dump updated HTML
        const updatedHtml = await page.evaluate(() => document.documentElement.outerHTML);
        const htmlPath2 = path.resolve(config.screenshotDir, 'page_source_retry.html');
        fs.writeFileSync(htmlPath2, updatedHtml);
        logger.info(`Updated HTML saved to: ${htmlPath2}`);

        logger.info('\n❌ Could not find login form elements.');
        logger.info('The page may require JavaScript to render the form.');
        logger.info('Check the saved HTML files for the page structure.');
        logger.info('\nBrowser will stay open for 120 seconds for manual inspection...');
        await new Promise(resolve => setTimeout(resolve, 120000));
        return;
      }
    }

    // ========== ATTEMPT LOGIN ==========
    logger.info('\n--- Step 2: Attempting Login ---');

    // Find user ID field
    const userField = pageState.allInputs.find(i =>
      i.type === 'text' && i.visible && (
        i.id.toLowerCase().includes('user') ||
        i.id.toLowerCase().includes('emp') ||
        i.name.toLowerCase().includes('user') ||
        i.id.toLowerCase().includes('login')
      )
    ) || pageState.allInputs.find(i => i.type === 'text' && i.visible);

    if (userField) {
      const sel = userField.id ? `#${userField.id}` : `input[name="${userField.name}"]`;
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, config.userId, { delay: 100 });
      logger.info(`✅ User ID entered in: ${sel}`);
    }

    await humanDelay(500, 1000);

    // Find password field
    const passField = pageState.allInputs.find(i => i.type === 'password');
    if (passField) {
      const sel = passField.id ? `#${passField.id}` : 'input[type="password"]';
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, config.password, { delay: 100 });
      logger.info(`✅ Password entered in: ${sel}`);
    }

    await humanDelay(500, 1000);

    // Check for captcha
    const captchaSpan = await page.evaluate(() => {
      const elements = document.querySelectorAll('span, label, div');
      for (const el of elements) {
        const text = el.textContent?.trim();
        if (text && /^\s*\d+\s*[+\-*x×]\s*\d+\s*[=]?\s*[?]?\s*$/.test(text)) {
          return { id: el.id, text, tag: el.tagName };
        }
      }
      // Also check for captcha by ID
      for (const el of elements) {
        if (el.id && el.id.toLowerCase().includes('captcha')) {
          return { id: el.id, text: el.textContent?.trim(), tag: el.tagName };
        }
      }
      return null;
    });

    if (captchaSpan) {
      logger.info(`📝 Captcha found: "${captchaSpan.text}" (id: ${captchaSpan.id}, tag: ${captchaSpan.tag})`);

      const match = captchaSpan.text.match(/(\d+)\s*([+\-*x×])\s*(\d+)/);
      if (match) {
        const [, n1, op, n2] = match;
        let answer;
        switch (op) {
          case '+': answer = parseInt(n1) + parseInt(n2); break;
          case '-': answer = parseInt(n1) - parseInt(n2); break;
          case '*': case 'x': case '×': answer = parseInt(n1) * parseInt(n2); break;
        }
        logger.info(`Captcha answer: ${n1} ${op} ${n2} = ${answer}`);

        const captchaInput = pageState.allInputs.find(i =>
          (i.id && i.id.toLowerCase().includes('captcha')) ||
          (i.name && i.name.toLowerCase().includes('captcha'))
        );
        if (captchaInput) {
          const sel = `#${captchaInput.id}`;
          await page.click(sel, { clickCount: 3 });
          await page.type(sel, answer.toString(), { delay: 80 });
          logger.info(`✅ Captcha answer entered in: ${sel}`);
        }
      }
    } else {
      // Check for image captcha
      const captchaImg = await page.evaluate(() => {
        const imgs = document.querySelectorAll('img');
        for (const img of imgs) {
          if (img.id?.toLowerCase().includes('captcha') || img.src?.toLowerCase().includes('captcha')) {
            return { id: img.id, src: img.src };
          }
        }
        return null;
      });
      if (captchaImg) {
        logger.info(`🖼️ Image captcha: id="${captchaImg.id}", src="${captchaImg.src}"`);
      } else {
        logger.info('ℹ️ No captcha detected');
      }
    }

    await humanDelay(1000, 2000);
    await takeScreenshot(page, 'explore_filled');

    // Click login button
    const loginBtnSel = await page.evaluate(() => {
      // Try multiple strategies
      const strategies = [
        () => document.querySelector('input[type="submit"]'),
        () => document.querySelector('button[type="submit"]'),
        () => document.querySelector('input[value*="Login" i]'),
        () => document.querySelector('input[value*="Sign" i]'),
        () => document.querySelector('#btnLogin'),
        () => document.querySelector('#btnSubmit'),
        () => {
          const btns = document.querySelectorAll('input[type="button"], button');
          for (const b of btns) {
            if ((b.value || b.textContent || '').toLowerCase().includes('login')) return b;
          }
          return null;
        },
      ];

      for (const strategy of strategies) {
        const el = strategy();
        if (el) {
          return el.id ? `#${el.id}` : (el.name ? `[name="${el.name}"]` : null);
        }
      }
      return null;
    });

    if (loginBtnSel) {
      logger.info(`Clicking login button: ${loginBtnSel}`);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {}),
        page.click(loginBtnSel),
      ]);
    } else {
      logger.warn('Could not find login button via selector. Trying Enter key...');
      await page.keyboard.press('Enter');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    await humanDelay(3000, 5000);
    await waitForCloudflare(page, 20000);
    await takeScreenshot(page, 'explore_post_login');
    logger.info(`Post-login URL: ${page.url()}`);

    // ========== DASHBOARD EXPLORATION ==========
    if (!page.url().toLowerCase().includes('login')) {
      logger.info('\n✅ LOGIN SUCCESSFUL!\n--- Step 3: Dashboard ---');

      // Save dashboard HTML
      const dashHtml = await page.evaluate(() => document.documentElement.outerHTML);
      fs.writeFileSync(path.resolve(config.screenshotDir, 'dashboard.html'), dashHtml);

      const allLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a')).map(a => ({
          text: a.textContent?.trim()?.substring(0, 80),
          href: a.href,
          id: a.id,
        })).filter(a => a.text && a.text.length > 0);
      });

      logger.info(`Dashboard has ${allLinks.length} links:`);
      allLinks.forEach(l => logger.info(`  🔗 "${l.text}" => ${l.href} (id: ${l.id})`));

      // Navigate to Outsource Management → Masters → My Daily Task
      const outsource = allLinks.find(l => l.text.toLowerCase().includes('outsource'));
      if (outsource) {
        logger.info(`\nClicking Outsource Management...`);
        await page.evaluate(text => {
          const links = document.querySelectorAll('a');
          for (const l of links) {
            if (l.textContent.trim().toLowerCase().includes('outsource')) { l.click(); break; }
          }
        });
        await new Promise(resolve => setTimeout(resolve, 3000));
        await waitForCloudflare(page, 10000);
        await takeScreenshot(page, 'explore_outsource');
      }

      // Try Masters
      logger.info('Looking for Masters menu...');
      await page.evaluate(() => {
        const els = document.querySelectorAll('a, span, li, div');
        for (const el of els) {
          if (el.textContent?.trim() === 'Masters') { el.click(); break; }
        }
      });
      await new Promise(resolve => setTimeout(resolve, 2000));
      await takeScreenshot(page, 'explore_masters');

      // Try My Daily Task
      logger.info('Looking for My Daily Task...');
      const clicked = await page.evaluate(() => {
        const links = document.querySelectorAll('a');
        for (const l of links) {
          const text = l.textContent?.trim()?.toLowerCase();
          if (text?.includes('daily task') || text?.includes('my daily')) {
            l.click();
            return l.textContent.trim();
          }
        }
        return null;
      });

      if (clicked) {
        logger.info(`Clicked: "${clicked}"`);
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 8000)),
        ]);
        await waitForCloudflare(page, 10000);
        await new Promise(resolve => setTimeout(resolve, 3000));
        await takeScreenshot(page, 'explore_daily_task');

        // DUMP ALL FORM ELEMENTS ON DAILY TASK PAGE
        logger.info('\n--- Step 4: Daily Task Form Elements ---');

        const formData = await page.evaluate(() => {
          const result = { inputs: [], selects: [], textareas: [], buttons: [], labels: [] };

          document.querySelectorAll('input').forEach(el => {
            if (el.type !== 'hidden') {
              result.inputs.push({
                id: el.id, name: el.name, type: el.type,
                placeholder: el.placeholder, value: el.value,
              });
            }
          });

          document.querySelectorAll('select').forEach(el => {
            const options = Array.from(el.options).map(o => ({ value: o.value, text: o.text.trim() }));
            result.selects.push({ id: el.id, name: el.name, options });
          });

          document.querySelectorAll('textarea').forEach(el => {
            result.textareas.push({ id: el.id, name: el.name });
          });

          document.querySelectorAll('input[type="submit"], input[type="button"], button, a.btn').forEach(el => {
            result.buttons.push({
              id: el.id, type: el.type, value: el.value || el.textContent?.trim(),
            });
          });

          document.querySelectorAll('label').forEach(el => {
            const text = el.textContent?.trim();
            if (text) result.labels.push({ for: el.htmlFor, text });
          });

          return result;
        });

        logger.info('📋 FORM INPUTS:\n' + JSON.stringify(formData.inputs, null, 2));
        logger.info('📋 SELECT DROPDOWNS:\n' + JSON.stringify(formData.selects, null, 2));
        logger.info('📋 TEXTAREAS:\n' + JSON.stringify(formData.textareas, null, 2));
        logger.info('📋 BUTTONS:\n' + JSON.stringify(formData.buttons, null, 2));
        logger.info('📋 LABELS:\n' + JSON.stringify(formData.labels, null, 2));

        // Save form page HTML
        const formHtml = await page.evaluate(() => document.documentElement.outerHTML);
        fs.writeFileSync(path.resolve(config.screenshotDir, 'daily_task_form.html'), formHtml);
        logger.info('📄 Form page HTML saved to: daily_task_form.html');
      }
    } else {
      logger.warn('Still on login page - login may have failed');
      const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500));
      logger.info(`Page text: ${bodyText}`);
    }

    logger.info('\n=== EXPLORATION COMPLETE ===');

  } catch (error) {
    logger.error('Exploration failed:', error);
    if (page) await takeScreenshot(page, 'explore_error');
  } finally {
    logger.info('\nBrowser will stay open for 120 seconds for manual inspection...');
    await new Promise(resolve => setTimeout(resolve, 120000));
    await closeBrowser();
  }
}

explore();
