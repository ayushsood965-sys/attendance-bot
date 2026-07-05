/**
 * Explore the navigation structure after login.
 * Focus on: Masters menu → My Daily Task → form elements
 */
require('dotenv').config();
const config = require('./config');
const logger = require('./logger');
const { newPage, takeScreenshot, closeBrowser, humanDelay, waitForCloudflare } = require('./browser');
const { login } = require('./login');
const fs = require('fs');
const path = require('path');

config.headless = false;

async function exploreNav() {
  try {
    // Login first
    logger.info('Logging in...');
    const page = await login();

    logger.info('\n=== DASHBOARD EXPLORATION ===');
    logger.info(`URL: ${page.url()}`);

    // Dump ALL clickable elements
    const elements = await page.evaluate(() => {
      const result = { links: [], tabs: [], frames: [], menuItems: [] };

      // All links
      document.querySelectorAll('a').forEach(a => {
        result.links.push({
          text: a.textContent?.trim()?.substring(0, 80),
          href: a.href,
          id: a.id,
          className: a.className?.substring(0, 60),
          visible: a.offsetParent !== null,
        });
      });

      // All list items (nav items)
      document.querySelectorAll('li').forEach(li => {
        const text = li.textContent?.trim()?.substring(0, 80);
        if (text && text.length < 80) {
          result.menuItems.push({
            text,
            id: li.id,
            className: li.className?.substring(0, 60),
            childLinks: Array.from(li.querySelectorAll('a')).map(a => ({
              text: a.textContent?.trim(),
              href: a.href,
              id: a.id,
            })),
          });
        }
      });

      // Iframes
      document.querySelectorAll('iframe').forEach(f => {
        result.frames.push({
          id: f.id, name: f.name, src: f.src,
          width: f.width, height: f.height,
        });
      });

      return result;
    });

    logger.info(`\nLinks (${elements.links.length}):`);
    elements.links.filter(l => l.visible).forEach(l =>
      logger.info(`  🔗 "${l.text}" href=${l.href} id=${l.id} class=${l.className}`)
    );

    logger.info(`\nMenu items (${elements.menuItems.length}):`);
    elements.menuItems.forEach(m => {
      logger.info(`  📁 "${m.text}" id=${m.id} class=${m.className}`);
      m.childLinks.forEach(l => logger.info(`    └─ "${l.text}" href=${l.href} id=${l.id}`));
    });

    if (elements.frames.length > 0) {
      logger.info(`\nIframes (${elements.frames.length}):`);
      elements.frames.forEach(f => logger.info(`  📌 id=${f.id} src=${f.src} ${f.width}x${f.height}`));
    }

    // Now click on Masters tab
    logger.info('\n--- Clicking Masters ---');
    await page.evaluate(() => {
      const els = document.querySelectorAll('a, li, span');
      for (const el of els) {
        const text = el.textContent?.trim();
        if (text === 'Masters' || text === 'Masters ') {
          el.click();
          return el.tagName + '#' + el.id;
        }
      }
      return null;
    });

    await humanDelay(2000, 3000);
    await takeScreenshot(page, 'nav_after_masters_click');

    // Check what appeared after clicking Masters
    const afterMasters = await page.evaluate(() => {
      const visible = [];
      document.querySelectorAll('a, li, span, div').forEach(el => {
        if (el.offsetParent !== null) {
          const text = el.textContent?.trim();
          if (text && text.length < 50 && (
            text.toLowerCase().includes('daily') ||
            text.toLowerCase().includes('task') ||
            text.toLowerCase().includes('attendance') ||
            text.toLowerCase().includes('master')
          )) {
            visible.push({
              tag: el.tagName, id: el.id, text,
              className: el.className?.substring?.(0, 40),
              href: el.href || '',
            });
          }
        }
      });
      return visible;
    });

    logger.info('\nAfter Masters click - relevant elements:');
    afterMasters.forEach(e =>
      logger.info(`  ${e.tag} id="${e.id}" class="${e.className}" text="${e.text}" href=${e.href}`)
    );

    // Find and click My Daily Task
    const dailyTaskHref = await page.evaluate(() => {
      const links = document.querySelectorAll('a');
      for (const l of links) {
        const text = l.textContent?.trim()?.toLowerCase();
        if (text?.includes('daily task') || text?.includes('my daily') || text?.includes('mydailytask')) {
          return { href: l.href, text: l.textContent.trim(), id: l.id };
        }
      }
      // Check href patterns
      for (const l of links) {
        if (l.href?.toLowerCase()?.includes('daily') || l.href?.toLowerCase()?.includes('task')) {
          return { href: l.href, text: l.textContent.trim(), id: l.id };
        }
      }
      return null;
    });

    logger.info(`\nDaily Task link: ${JSON.stringify(dailyTaskHref)}`);

    if (dailyTaskHref?.href) {
      logger.info(`Navigating directly to: ${dailyTaskHref.href}`);
      await page.goto(dailyTaskHref.href, { waitUntil: 'networkidle2', timeout: 30000 });
      await waitForCloudflare(page, 15000);
      await humanDelay(3000, 5000);
    } else {
      logger.info('No direct link found. Trying to click...');
      await page.evaluate(() => {
        const links = document.querySelectorAll('a');
        for (const l of links) {
          if (l.textContent?.trim()?.toLowerCase()?.includes('daily')) {
            l.click();
            return;
          }
        }
      });
      await humanDelay(5000, 8000);
    }

    await takeScreenshot(page, 'nav_daily_task_page');
    logger.info(`URL after daily task click: ${page.url()}`);

    // Save the HTML
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    fs.writeFileSync(path.resolve(config.screenshotDir, 'daily_task_page.html'), html);
    logger.info('HTML saved');

    // Dump form elements
    const formElements = await page.evaluate(() => {
      const result = { selects: [], inputs: [], textareas: [], buttons: [], iframes: [] };

      document.querySelectorAll('select').forEach(el => {
        const opts = Array.from(el.options).map(o => ({ value: o.value, text: o.text.trim() }));
        result.selects.push({ id: el.id, name: el.name, options: opts, visible: el.offsetParent !== null });
      });

      document.querySelectorAll('input').forEach(el => {
        if (el.type !== 'hidden') {
          result.inputs.push({
            id: el.id, name: el.name, type: el.type,
            placeholder: el.placeholder, visible: el.offsetParent !== null,
          });
        }
      });

      document.querySelectorAll('textarea').forEach(el => {
        result.textareas.push({ id: el.id, name: el.name, visible: el.offsetParent !== null });
      });

      document.querySelectorAll('input[type="submit"], input[type="button"], button').forEach(el => {
        result.buttons.push({
          id: el.id, value: el.value || el.textContent?.trim(),
          visible: el.offsetParent !== null,
        });
      });

      document.querySelectorAll('iframe').forEach(f => {
        result.iframes.push({ id: f.id, src: f.src, name: f.name });
      });

      return result;
    });

    logger.info('\n📋 FORM ELEMENTS:');
    logger.info('Selects: ' + JSON.stringify(formElements.selects, null, 2));
    logger.info('Inputs: ' + JSON.stringify(formElements.inputs, null, 2));
    logger.info('Textareas: ' + JSON.stringify(formElements.textareas, null, 2));
    logger.info('Buttons: ' + JSON.stringify(formElements.buttons, null, 2));
    logger.info('Iframes: ' + JSON.stringify(formElements.iframes, null, 2));

    // Check iframes for form content
    if (formElements.iframes.length > 0) {
      logger.info('\nChecking iframe contents...');
      const frames = page.frames();
      for (let i = 0; i < frames.length; i++) {
        try {
          const fSelects = await frames[i].evaluate(() => {
            return Array.from(document.querySelectorAll('select')).map(s => ({
              id: s.id,
              options: Array.from(s.options).map(o => ({ value: o.value, text: o.text.trim() })),
            }));
          });
          if (fSelects.length > 0) {
            logger.info(`Frame ${i} has ${fSelects.length} selects:`);
            fSelects.forEach(s => {
              logger.info(`  #${s.id}: ${s.options.map(o => o.text).join(', ')}`);
            });
          }
        } catch (e) { /* cross-origin */ }
      }
    }

    logger.info('\n=== NAV EXPLORATION COMPLETE ===');

  } catch (e) {
    logger.error('Error:', e);
  } finally {
    logger.info('Waiting 60s...');
    await new Promise(r => setTimeout(r, 60000));
    await closeBrowser();
  }
}

exploreNav();
