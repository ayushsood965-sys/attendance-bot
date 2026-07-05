const logger = require('./logger');

/**
 * Captcha Solver Module
 * 
 * Handles detection and solving of various captcha types:
 * - Math captchas (e.g., "5 + 3 = ?")
 * - Simple text captchas
 * - Image-based captchas (via screenshot + Gemini Vision)
 */

/**
 * Detect captcha type and solve it on the login page.
 * @param {import('puppeteer').Page} page - Puppeteer page instance
 * @param {object} selectors - Login page selectors
 * @param {object} [geminiModel] - Optional Gemini model for image captcha solving
 * @returns {Promise<boolean>} true if captcha was solved successfully
 */
async function solveCaptcha(page, selectors, geminiModel = null) {
  logger.info('Attempting to detect and solve captcha...');

  try {
    // Strategy 1: Check for a text/math captcha label (e.g., "5 + 3 = ?")
    const mathCaptchaSolved = await tryMathCaptcha(page, selectors);
    if (mathCaptchaSolved) return true;

    // Strategy 2: Check for an image-based captcha and solve with AI vision
    const imageCaptchaSolved = await tryImageCaptcha(page, selectors, geminiModel);
    if (imageCaptchaSolved) return true;

    // Strategy 3: Try generic text extraction from any captcha element
    const genericSolved = await tryGenericCaptcha(page, selectors);
    if (genericSolved) return true;

    logger.warn('Could not detect or solve captcha automatically');
    return false;

  } catch (error) {
    logger.error('Captcha solving failed:', error);
    return false;
  }
}

/**
 * Try to solve a math-based captcha (e.g., "12 + 5 = ?", "8 - 3 = ?")
 */
async function tryMathCaptcha(page, selectors) {
  try {
    // Look for captcha text in various possible elements
    const captchaSelectors = [
      selectors.captchaText,
      '#lblCaptcha',
      '#CaptchaLabel',
      '#lblcaptcha',
      'label[for*="captcha" i]',
      'span[id*="captcha" i]',
      'span[id*="Captcha"]',
      '#lblMessage',
    ];

    let captchaText = null;

    for (const sel of captchaSelectors) {
      try {
        const element = await page.$(sel);
        if (element) {
          captchaText = await page.evaluate(el => el.textContent.trim(), element);
          if (captchaText && captchaText.length > 0) {
            logger.debug(`Found captcha text with selector "${sel}": "${captchaText}"`);
            break;
          }
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    if (!captchaText) {
      logger.debug('No math captcha text found');
      return false;
    }

    // Parse math expression: supports +, -, *, x patterns
    // Matches patterns like: "5 + 3 = ?", "What is 12 + 7?", "12+5=", "5 x 3"
    const mathMatch = captchaText.match(/(\d+)\s*([+\-*x×])\s*(\d+)/i);
    if (!mathMatch) {
      logger.debug(`Captcha text "${captchaText}" is not a math expression`);
      return false;
    }

    const num1 = parseInt(mathMatch[1]);
    const operator = mathMatch[2];
    const num2 = parseInt(mathMatch[3]);

    let answer;
    switch (operator) {
      case '+': answer = num1 + num2; break;
      case '-': answer = num1 - num2; break;
      case '*':
      case 'x':
      case '×': answer = num1 * num2; break;
      default:
        logger.warn(`Unknown operator: ${operator}`);
        return false;
    }

    logger.info(`Math captcha: ${num1} ${operator} ${num2} = ${answer}`);

    // Find and fill the captcha input
    const inputSel = await findCaptchaInput(page, selectors);
    if (!inputSel) {
      logger.warn('Could not find captcha input field');
      return false;
    }

    await page.click(inputSel, { clickCount: 3 }); // Select all existing text
    await page.type(inputSel, answer.toString(), { delay: 50 });
    logger.info(`Captcha answer "${answer}" entered successfully`);
    return true;

  } catch (error) {
    logger.debug('Math captcha solving failed:', error.message);
    return false;
  }
}

/**
 * Try to solve an image-based captcha using Gemini Vision API
 */
async function tryImageCaptcha(page, selectors, geminiModel) {
  try {
    const imageSelectors = [
      selectors.captchaImage,
      '#imgCaptcha',
      '#CaptchaImage',
      '#imgcaptcha',
      'img[id*="captcha" i]',
      'img[id*="Captcha"]',
      'img[src*="captcha" i]',
      'img[src*="Captcha"]',
    ];

    let captchaElement = null;

    for (const sel of imageSelectors) {
      try {
        captchaElement = await page.$(sel);
        if (captchaElement) {
          logger.debug(`Found captcha image with selector "${sel}"`);
          break;
        }
      } catch (e) {
        // Continue
      }
    }

    if (!captchaElement) {
      logger.debug('No captcha image found');
      return false;
    }

    // If we have Gemini model, use vision to solve
    if (geminiModel) {
      const screenshotBuffer = await captchaElement.screenshot({ encoding: 'base64' });

      const result = await geminiModel.generateContent([
        {
          inlineData: {
            mimeType: 'image/png',
            data: screenshotBuffer,
          },
        },
        'This is a CAPTCHA image. Read the text/numbers shown in the image and return ONLY the exact characters visible. No explanation, just the captcha text.',
      ]);

      const captchaAnswer = result.response.text().trim();
      logger.info(`AI solved image captcha: "${captchaAnswer}"`);

      const inputSel = await findCaptchaInput(page, selectors);
      if (!inputSel) return false;

      await page.click(inputSel, { clickCount: 3 });
      await page.type(inputSel, captchaAnswer, { delay: 50 });
      return true;
    }

    logger.warn('Image captcha found but no AI model available for solving');
    return false;

  } catch (error) {
    logger.debug('Image captcha solving failed:', error.message);
    return false;
  }
}

/**
 * Try generic captcha solving - look for any captcha-related text on page
 */
async function tryGenericCaptcha(page, selectors) {
  try {
    // Try to find any element that looks like a captcha challenge
    const captchaText = await page.evaluate(() => {
      const elements = document.querySelectorAll('span, label, div, p');
      for (const el of elements) {
        const text = el.textContent.trim();
        // Look for math-like patterns anywhere on the page
        if (/\d+\s*[+\-*x×]\s*\d+/.test(text) && text.length < 30) {
          return text;
        }
      }
      return null;
    });

    if (captchaText) {
      logger.info(`Found generic captcha text: "${captchaText}"`);
      const mathMatch = captchaText.match(/(\d+)\s*([+\-*x×])\s*(\d+)/);
      if (mathMatch) {
        const num1 = parseInt(mathMatch[1]);
        const operator = mathMatch[2];
        const num2 = parseInt(mathMatch[3]);

        let answer;
        switch (operator) {
          case '+': answer = num1 + num2; break;
          case '-': answer = num1 - num2; break;
          case '*':
          case 'x':
          case '×': answer = num1 * num2; break;
          default: return false;
        }

        const inputSel = await findCaptchaInput(page, selectors);
        if (!inputSel) return false;

        await page.click(inputSel, { clickCount: 3 });
        await page.type(inputSel, answer.toString(), { delay: 50 });
        logger.info(`Generic captcha solved: ${captchaText} = ${answer}`);
        return true;
      }
    }

    return false;
  } catch (error) {
    logger.debug('Generic captcha solving failed:', error.message);
    return false;
  }
}

/**
 * Find the captcha input field
 */
async function findCaptchaInput(page, selectors) {
  const inputSelectors = [
    selectors.captchaInput,
    '#txtCaptcha',
    '#txtcaptcha',
    '#CaptchaInput',
    'input[id*="captcha" i]',
    'input[id*="Captcha"]',
    'input[name*="captcha" i]',
    'input[placeholder*="captcha" i]',
  ];

  for (const sel of inputSelectors) {
    try {
      const element = await page.$(sel);
      if (element) {
        logger.debug(`Found captcha input: ${sel}`);
        return sel;
      }
    } catch (e) {
      // Continue
    }
  }

  logger.warn('Captcha input field not found');
  return null;
}

module.exports = { solveCaptcha };
