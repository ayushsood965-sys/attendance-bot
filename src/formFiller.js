const config = require('./config');
const logger = require('./logger');
const { takeScreenshot, humanDelay } = require('./browser');

// Track the context where the form is located (main page or frame)
let formFrame = null;

/**
 * Navigate from Dashboard → Outsource Management → Masters → My Daily Task
 */
async function navigateToForm(page) {
  logger.info('Navigating to Daily Task form...');
  formFrame = page; // Reset to page initially

  // Step 1: Click "Outsource Management" card
  logger.info('  Looking for Outsource Management card...');
  
  const cardClicked = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('*'));
    for (const el of elements) {
      if (el.children.length === 0 && el.textContent?.trim() === 'Outsource Management') {
        let container = el.parentElement;
        while (container && container !== document.body) {
          const isCard = container.className?.toLowerCase()?.includes('card') || 
                         container.className?.toLowerCase()?.includes('box') ||
                         container.className?.toLowerCase()?.includes('more') ||
                         container.tagName === 'DIV' && (container.style.border || container.style.boxShadow);
                         
          if (isCard) {
            const btn = container.querySelector('a, button, .btn, [class*="btn" i]');
            if (btn) {
              btn.click();
              return true;
            }
          }
          container = container.parentElement;
        }
        el.click();
        return true;
      }
    }
    return false;
  });

  if (cardClicked) {
    logger.info('  ✅ Outsource Management card action clicked');
  } else {
    logger.warn('  Outsource Management card button not found via container walk. Trying link click...');
    let clicked = await clickLinkByText(page, 'Outsource Management');
    if (!clicked) clicked = await clickLinkByText(page, 'Outsource');
    if (clicked) {
      logger.info('  ✅ Outsource Management link clicked');
    }
  }

  // Wait for the new page / frame navigation to complete
  await humanDelay(3000, 5000);
  await takeScreenshot(page, 'nav_outsource_loaded');

  // Step 2: Wait for "Masters" menu item to render
  logger.info('  Waiting for Masters menu item to load...');
  const mastersLoaded = await waitForMastersMenu(page);
  if (!mastersLoaded) {
    throw new Error('Timeout waiting for Masters menu to load');
  }

  // Step 3: Find "Masters" menu element
  logger.info('  Finding Masters element...');
  let mastersHandle = null;
  let targetContext = page;

  // Try main page first
  const pageMasters = await page.evaluateHandle(() => {
    const els = document.querySelectorAll('a, li, span, div, button');
    for (const el of els) {
      const text = el.textContent?.trim() || '';
      if (text === 'Masters' || text === 'Masters ') return el;
    }
    return null;
  });

  if (pageMasters && pageMasters.asElement()) {
    mastersHandle = pageMasters.asElement();
    targetContext = page;
  } else {
    // Try frames
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const frameMasters = await frame.evaluateHandle(() => {
          const els = document.querySelectorAll('a, li, span, div, button');
          for (const el of els) {
            const text = el.textContent?.trim() || '';
            if (text === 'Masters' || text === 'Masters ') return el;
          }
          return null;
        });
        if (frameMasters && frameMasters.asElement()) {
          mastersHandle = frameMasters.asElement();
          targetContext = frame;
          break;
        }
      } catch (e) {}
    }
  }

  if (!mastersHandle) {
    throw new Error('Masters menu item not found');
  }

  formFrame = targetContext;

  // Step 4: Hover over Masters to reveal the submenu
  logger.info('  Hovering over Masters menu...');
  const mastersBox = await mastersHandle.boundingBox();
  if (!mastersBox) {
    throw new Error('Could not get bounding box for Masters menu');
  }
  
  // Move mouse to the center of Masters menu item
  const mx = mastersBox.x + mastersBox.width / 2;
  const my = mastersBox.y + mastersBox.height / 2;
  await page.mouse.move(mx, my);
  await humanDelay(500, 1000);

  // Click it as well (some submenus expand on click instead of hover)
  await page.mouse.click(mx, my);
  await humanDelay(1500, 2500);
  await takeScreenshot(page, 'nav_masters_interacted');

  // Step 5: Wait for "My Daily Task" to be visible / clickable
  logger.info('  Waiting for My Daily Task link to appear...');
  const taskHandle = await targetContext.waitForFunction(() => {
    const links = document.querySelectorAll('a');
    for (const l of links) {
      const text = l.textContent?.trim()?.toLowerCase();
      if (text?.includes('daily task') || text?.includes('my daily') || text?.includes('mydailytask')) {
        // Must be visible
        if (l.offsetParent !== null || l.offsetWidth > 0 || l.offsetHeight > 0) return l;
      }
    }
    return null;
  }, { timeout: 10000 }).then(h => h.asElement()).catch(() => null);

  if (!taskHandle) {
    throw new Error('Submenu "My Daily Task" not visible after expanding Masters');
  }

  // Step 6: Smoothly slide the mouse from Masters to My Daily Task so hover stays active
  const taskBox = await taskHandle.boundingBox();
  if (!taskBox) {
    throw new Error('Could not get bounding box for My Daily Task submenu item');
  }

  const tx = taskBox.x + taskBox.width / 2;
  const ty = taskBox.y + taskBox.height / 2;
  
  logger.info(`  Sliding mouse from (${mx}, ${my}) to (${tx}, ${ty})...`);
  // Move mouse in small steps to prevent leaving the active hover zone
  await page.mouse.move(tx, ty, { steps: 15 });
  await humanDelay(300, 600);

  // Step 7: Click My Daily Task
  logger.info('  Clicking My Daily Task...');
  await page.mouse.click(tx, ty);
  await handleNavigation(page);

  // Wait for form to load
  await waitForFormElements(formFrame);
  await takeScreenshot(page, 'daily_task_form_loaded');
  logger.info('Daily Task form loaded successfully ✅');
}

/**
 * Wait for "Masters" menu to appear in the DOM (page or frames)
 */
async function waitForMastersMenu(page) {
  const maxWait = 25000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const foundOnPage = await page.evaluate(() => {
      const els = document.querySelectorAll('a, li, span, div, button');
      for (const el of els) {
        const text = el.textContent?.trim() || '';
        if (text === 'Masters' || text === 'Masters ') return true;
      }
      return false;
    });

    if (foundOnPage) return true;

    // Check frames
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const foundInFrame = await frame.evaluate(() => {
          const els = document.querySelectorAll('a, li, span, div, button');
          for (const el of els) {
            const text = el.textContent?.trim() || '';
            if (text === 'Masters' || text === 'Masters ') return true;
          }
          return false;
        });
        if (foundInFrame) return true;
      } catch (e) { /* ignore cross-origin */ }
    }

    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Find the Masters element, hover over it to show submenus, and click it
 */
async function findAndInteractWithMasters(page) {
  let targetContext = page;
  let mastersHandle = null;

  // Try page
  const pageMasters = await page.evaluateHandle(() => {
    const els = document.querySelectorAll('a, li, span, div, button');
    for (const el of els) {
      const text = el.textContent?.trim() || '';
      if (text === 'Masters' || text === 'Masters ') return el;
    }
    return null;
  });
  
  if (pageMasters && pageMasters.asElement()) {
    mastersHandle = pageMasters.asElement();
    targetContext = page;
  } else {
    // Try frames
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const frameMasters = await frame.evaluateHandle(() => {
          const els = document.querySelectorAll('a, li, span, div, button');
          for (const el of els) {
            const text = el.textContent?.trim() || '';
            if (text === 'Masters' || text === 'Masters ') return el;
          }
          return null;
        });
        if (frameMasters && frameMasters.asElement()) {
          mastersHandle = frameMasters.asElement();
          targetContext = frame;
          break;
        }
      } catch (e) { /* ignore */ }
    }
  }

  if (!mastersHandle) {
    throw new Error('Masters menu item not found in any context');
  }

  logger.info('  Found Masters element. Hovering and clicking...');
  // Hover to trigger CSS hover submenus
  await mastersHandle.hover().catch(() => {});
  await humanDelay(500, 1000);
  
  // Click to trigger click-based dropdown expand
  await mastersHandle.click().catch(() => {});
  await humanDelay(1500, 2500);

  return targetContext;
}

/**
 * Fill and submit the Daily Task form.
 */
async function fillForm(page, shift, taskData) {
  const context = formFrame || page;
  logger.info(`Filling form in context: ${context === page ? 'main page' : 'iframe'} for ${shift} shift...`);

  try {
    // 1. Select Shift dropdown
    const shiftText = shift === 'morning'
      ? config.dropdownValues.shift.morning
      : config.dropdownValues.shift.evening;

    const shiftSelected = await selectDropdown(context, 'Shift', shiftText);
    if (!shiftSelected) {
      // Check if it's because no options are available (time constraints)
      const optionsCount = await context.evaluate(() => {
        const sel = document.querySelector('select[id*="Shift" i], select[id*="shift" i]');
        return sel ? sel.options.length : 0;
      });
      
      if (optionsCount <= 1) {
        logger.warn(`  ⚠️ Shift option "${shiftText}" is not visible in the dropdown. HPU time constraints: Morning shift is only active between 11 AM - 1 PM, Evening shift between 2 PM - 5 PM. Current time is outside these windows.`);
        logger.info('  ℹ️ Skipping submission successfully due to portal time constraints.');
        return true; // Exit cleanly
      }
      throw new Error(`Failed to select Shift dropdown (option "${shiftText}" not found)`);
    }
    await humanDelay(500, 1000);
    // Wait for possible ASP.NET postback after shift change
    await waitForPostback(context);

    // 2. Select Work Type dropdown
    const workSelected = await selectDropdown(context, 'Work', config.dropdownValues.workType);
    if (!workSelected) {
      throw new Error(`Failed to select Work Type dropdown (option "${config.dropdownValues.workType}" not found)`);
    }
    await humanDelay(500, 1000);

    // 3. Fill Maximum Hours
    await fillTextField(context, 'Hour', taskData.maxHours);
    await humanDelay(300, 600);

    // 4. Fill Description of Activity
    let descFilled = await fillTextField(context, 'Description', taskData.description);
    if (!descFilled) descFilled = await fillTextField(context, 'Activity', taskData.description);
    if (!descFilled) {
      await fillTextarea(context, taskData.description);
    }
    await humanDelay(300, 600);

    // 5. Select Activity Status
    await selectDropdown(context, 'Status', config.dropdownValues.activityStatus);
    await humanDelay(300, 600);

    // 6. Fill Remarks
    await fillTextField(context, 'Remark', taskData.remarks);
    await humanDelay(300, 600);

    await takeScreenshot(page, `form_filled_${shift}`);

    // 7. Check dry run
    if (config.dryRun) {
      logger.info('[DRY RUN] Form filled but NOT submitted');
      return true;
    }

    // 8. Click ADD button
    logger.info('Clicking ADD button...');
    let addClicked = await clickButtonByText(context, 'ADD');
    if (!addClicked) addClicked = await clickButtonByText(context, 'Save');
    if (!addClicked) addClicked = await clickButtonByText(context, 'Submit');

    if (!addClicked) {
      throw new Error('Could not find ADD/Save/Submit button');
    }

    // Wait for AJAX postback to update the GridView after adding
    await handleNavigation(page);
    await waitForPostback(context);
    await humanDelay(1500, 2500);

    // 9. Tick the "Final Submit" checkbox
    logger.info('Checking the "Final Submit" checkbox...');
    const finalSubmitChecked = await context.evaluate(() => {
      const chk = document.querySelector('input[type="checkbox"][id*="Submit" i], input[type="checkbox"][id*="submit" i]');
      if (chk) {
        if (!chk.checked) {
          chk.click();
        }
        return true;
      }
      return false;
    });

    if (finalSubmitChecked) {
      logger.info('  ✅ "Final Submit" checkbox checked');
    } else {
      logger.warn('  ⚠️ "Final Submit" checkbox not found on page');
    }
    await humanDelay(800, 1500);

    // 10. Click the "SAVE" button to final submit
    logger.info('Clicking final SAVE button...');
    let saveClicked = await clickButtonByText(context, 'SAVE');
    if (!saveClicked) saveClicked = await clickButtonByText(context, 'Save');
    
    if (saveClicked) {
      logger.info('  ✅ final SAVE button clicked');
    } else {
      throw new Error('Could not find final SAVE button');
    }

    await handleNavigation(page);
    await waitForPostback(context);
    await humanDelay(2000, 3000);

    await takeScreenshot(page, `form_submitted_${shift}`);

    // 11. Verify success
    const success = await verifySubmission(context);
    if (success) {
      logger.info(`✅ ${shift.toUpperCase()} shift task submitted and saved successfully!`);
    } else {
      logger.warn(`⚠️ ${shift} shift submission may have issues — check screenshot`);
    }

    return success;

  } catch (error) {
    await takeScreenshot(page, `form_error_${shift}`);
    logger.error(`Form filling failed for ${shift} shift:`, error);
    throw error;
  }
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Select a dropdown option
 */
async function selectDropdown(frame, labelHint, optionText) {
  logger.info(`  Selecting dropdown "${labelHint}" → "${optionText}"...`);

  // Wait until the target select has options populated (> 1)
  const populated = await frame.waitForFunction((hint) => {
    const selects = document.querySelectorAll('select');
    for (const select of selects) {
      const id = (select.id || '').toLowerCase();
      const name = (select.name || '').toLowerCase();
      
      let isMatch = id.includes(hint.toLowerCase()) || name.includes(hint.toLowerCase());
      
      if (!isMatch) {
        const parent = select.closest('tr, div, .form-group, td');
        if (parent) {
          const parentText = parent.textContent.toLowerCase();
          isMatch = parentText.includes(hint.toLowerCase());
        }
      }
      
      if (isMatch && select.options.length > 1) {
        return true;
      }
    }
    return false;
  }, { timeout: 10000 }, labelHint).then(() => true).catch(() => false);

  if (!populated) {
    logger.warn(`  ⚠️ Dropdown matching hint "${labelHint}" options did not populate in time.`);
  }

  const selected = await frame.evaluate((hint, text) => {
    const selects = document.querySelectorAll('select');

    for (const select of selects) {
      const id = (select.id || '').toLowerCase();
      const name = (select.name || '').toLowerCase();

      let isMatch = id.includes(hint.toLowerCase()) || name.includes(hint.toLowerCase());

      if (!isMatch) {
        const parent = select.closest('tr, div, .form-group, td');
        if (parent) {
          const parentText = parent.textContent.toLowerCase();
          isMatch = parentText.includes(hint.toLowerCase());
        }
      }

      if (!isMatch) {
        const label = document.querySelector(`label[for="${select.id}"]`);
        if (label && label.textContent.toLowerCase().includes(hint.toLowerCase())) {
          isMatch = true;
        }
      }

      if (isMatch) {
        const options = select.options;
        for (let i = 0; i < options.length; i++) {
          const optText = options[i].text.trim().toLowerCase();
          if (optText.includes(text.toLowerCase())) {
            select.selectedIndex = i;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return { selectId: select.id, optionText: options[i].text, optionValue: options[i].value };
          }
        }
        const available = Array.from(options).map(o => o.text.trim());
        return { error: `Option "${text}" not found`, available, selectId: select.id };
      }
    }

    return { error: `No select element found matching hint "${hint}"` };
  }, labelHint, optionText);

  if (selected.error) {
    logger.warn(`  ⚠️ Dropdown "${labelHint}": ${selected.error} (available: ${selected.available?.join(', ')})`);
    return false;
  }

  logger.info(`  ✅ Selected "${selected.optionText}" in #${selected.selectId}`);
  return true;
}

/**
 * Fill a text input field
 */
async function fillTextField(frame, hint, value) {
  const filled = await frame.evaluate((h, val) => {
    const inputs = document.querySelectorAll('input[type="text"], input[type="number"]');

    for (const input of inputs) {
      const id = (input.id || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      const isVisible = input.offsetParent !== null || input.offsetWidth > 0;

      if (!isVisible) continue;

      let isMatch = id.includes(h.toLowerCase()) || name.includes(h.toLowerCase());

      if (!isMatch) {
        const parent = input.closest('tr, div, .form-group, td');
        if (parent) {
          const parentText = parent.textContent.toLowerCase();
          isMatch = parentText.includes(h.toLowerCase());
        }
      }

      if (isMatch) {
        input.focus();
        input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return input.id;
      }
    }
    return null;
  }, hint, value);

  if (filled) {
    logger.info(`  ✅ Filled text field #${filled} (hint: "${hint}")`);
    return true;
  }
  return false;
}

/**
 * Fill the first visible textarea
 */
async function fillTextarea(frame, value) {
  const filled = await frame.evaluate((val) => {
    const textareas = document.querySelectorAll('textarea');
    for (const ta of textareas) {
      if (ta.offsetParent !== null || ta.offsetWidth > 0) {
        ta.focus();
        ta.value = val;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        return ta.id;
      }
    }
    return null;
  }, value);

  if (filled) {
    logger.info(`  ✅ Filled textarea #${filled}`);
    return true;
  }
  return false;
}

/**
 * Click a link by its visible text
 */
async function clickLinkByText(frame, text) {
  if (!frame) return false;
  return await frame.evaluate((txt) => {
    const links = document.querySelectorAll('a, span[onclick], div[onclick], li, button');
    for (const el of links) {
      const elText = el.textContent?.trim();
      if (elText && elText.toLowerCase().includes(txt.toLowerCase())) {
        el.click();
        return true;
      }
    }
    return false;
  }, text);
}

/**
 * Click a button by text
 */
async function clickButtonByText(frame, text) {
  const clicked = await frame.evaluate((txt) => {
    const elements = document.querySelectorAll('input[type="submit"], input[type="button"], button, a.btn');
    for (const el of elements) {
      const val = (el.value || el.textContent || '').trim();
      if (val.toLowerCase().includes(txt.toLowerCase())) {
        el.click();
        return val;
      }
    }
    return null;
  }, text);

  if (clicked) {
    logger.info(`  ✅ Button clicked: "${clicked}"`);
    return true;
  }
  return false;
}

/**
 * Handle navigation
 */
async function handleNavigation(page) {
  try {
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
      new Promise(r => setTimeout(r, 8000)),
    ]);
  } catch (e) { /* ignore timeout */ }
  await humanDelay(1000, 2000);
}

/**
 * Wait for postback
 */
async function waitForPostback(frame) {
  logger.info('  Waiting for ASP.NET postback to complete...');
  try {
    await frame.waitForFunction(() => {
      // Check if Sys (ASP.NET AJAX client-side framework) is defined
      if (typeof Sys !== 'undefined' && Sys.WebForms && Sys.WebForms.PageRequestManager) {
        const prm = Sys.WebForms.PageRequestManager.getInstance();
        return !prm.get_isInAsyncPostBack();
      }
      // Fallback: check progress indicators
      const progress = document.querySelector('[id*="UpdateProgress"]');
      if (progress && progress.style.display !== 'none') return false;
      return true;
    }, { timeout: 15000 });
  } catch (e) {
    logger.warn('  Postback wait timed out or failed');
  }
  await humanDelay(1500, 2500);
}

/**
 * Wait for form elements
 */
async function waitForFormElements(frame) {
  if (!frame) return;
  try {
    await frame.waitForFunction(() => {
      const selects = document.querySelectorAll('select');
      return selects.length >= 2;
    }, { timeout: 15000 });
  } catch (e) {
    logger.warn('Form elements may not have loaded fully');
  }
  await humanDelay(1000, 2000);
}

/**
 * Verify form submission
 */
async function verifySubmission(frame) {
  const result = await frame.evaluate(() => {
    const allText = document.body?.innerText || '';
    if (allText.toLowerCase().includes('success') || allText.toLowerCase().includes('added') ||
        allText.toLowerCase().includes('saved') || allText.toLowerCase().includes('record')) {
      return { success: true, message: 'Success indicator found in page text' };
    }

    const spans = document.querySelectorAll('span, div, label');
    for (const el of spans) {
      const color = window.getComputedStyle(el).color;
      const text = el.textContent?.trim();
      if (text && (color === 'rgb(0, 128, 0)' || color === 'green')) {
        return { success: true, message: text };
      }
    }

    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      if (rows.length > 1) {
        return { success: true, message: `Task list has ${rows.length - 1} entries` };
      }
    }

    for (const el of spans) {
      const color = window.getComputedStyle(el).color;
      const text = el.textContent?.trim();
      if (text && (color === 'rgb(255, 0, 0)' || color === 'red') && text.length > 3) {
        return { success: false, message: text };
      }
    }

    return { success: true, message: 'No error detected (assumed success)' };
  });

  logger.info(`  Verification: ${result.success ? '✅' : '❌'} ${result.message}`);
  return result.success;
}

module.exports = { navigateToForm, fillForm };
