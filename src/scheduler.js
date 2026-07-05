const cron = require('node-cron');
const config = require('./config');
const logger = require('./logger');
const { login } = require('./login');
const { navigateToForm, fillForm } = require('./formFiller');
const { generateTask, getModel } = require('./taskGenerator');
const { closeBrowser, takeScreenshot } = require('./browser');

/**
 * Execute the daily task filling for a given shift
 * @param {'morning' | 'evening'} shift
 * @returns {Promise<boolean>}
 */
async function executeTask(shift) {
  const startTime = Date.now();
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`Starting ${shift.toUpperCase()} shift task execution`);
  logger.info(`Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
  logger.info(`${'='.repeat(60)}`);

  let page = null;
  let attempt = 0;

  while (attempt < config.maxRetries) {
    attempt++;
    logger.info(`Attempt ${attempt}/${config.maxRetries}`);

    try {
      // Step 1: Generate task description with AI
      logger.info('Step 1: Generating task description...');
      const taskData = await generateTask(shift);
      logger.info(`Task generated: ${JSON.stringify(taskData)}`);

      // Step 2: Login
      logger.info('Step 2: Logging in...');
      const geminiModel = getModel();
      page = await login(geminiModel);

      // Step 3: Navigate to form
      logger.info('Step 3: Navigating to Daily Task form...');
      await navigateToForm(page);

      // Step 4: Fill and submit form
      logger.info('Step 4: Filling form...');
      const success = await fillForm(page, shift, taskData);

      if (success) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        logger.info(`\n✅ ${shift.toUpperCase()} shift completed successfully in ${duration}s`);
        return true;
      } else {
        throw new Error('Form submission verification failed');
      }

    } catch (error) {
      logger.error(`Attempt ${attempt} failed:`, error);

      if (attempt < config.maxRetries) {
        const delay = config.retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
        logger.info(`Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } finally {
      // Close browser after each attempt
      await closeBrowser();
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.error(`\n❌ ${shift.toUpperCase()} shift FAILED after ${config.maxRetries} attempts (${duration}s)`);
  return false;
}

/**
 * Start the cron scheduler
 */
function startScheduler() {
  logger.info('\n🚀 Starting Attendance Autoloader Scheduler');
  logger.info(`   Morning schedule: ${config.morningCron} (IST)`);
  logger.info(`   Evening schedule: ${config.eveningCron} (IST)`);
  logger.info(`   Skip weekends: ${config.skipWeekends}`);
  logger.info(`   Dry run: ${config.dryRun}`);
  logger.info(`   Headless: ${config.headless}`);
  logger.info('');

  // Morning shift job
  cron.schedule(config.morningCron, async () => {
    logger.info('⏰ Morning shift cron triggered');

    // Add random delay to appear human-like
    const delay = randomDelay();
    logger.info(`Adding random delay: ${(delay / 1000).toFixed(0)}s`);
    await new Promise(resolve => setTimeout(resolve, delay));

    await executeTask('morning');
  }, {
    timezone: config.timezone,
  });

  // Evening shift job
  cron.schedule(config.eveningCron, async () => {
    logger.info('⏰ Evening shift cron triggered');

    // Add random delay
    const delay = randomDelay();
    logger.info(`Adding random delay: ${(delay / 1000).toFixed(0)}s`);
    await new Promise(resolve => setTimeout(resolve, delay));

    await executeTask('evening');
  }, {
    timezone: config.timezone,
  });

  logger.info('✅ Scheduler started. Waiting for next scheduled execution...');
  logger.info(`   Next morning run: ~11:00 AM IST (Mon-Fri)`);
  logger.info(`   Next evening run: ~2:30 PM IST (Mon-Fri)`);
}

/**
 * Generate a random delay between configured min and max
 * @returns {number} delay in milliseconds
 */
function randomDelay() {
  return Math.floor(
    Math.random() * (config.maxRandomDelay - config.minRandomDelay) + config.minRandomDelay
  );
}

module.exports = { startScheduler, executeTask };
