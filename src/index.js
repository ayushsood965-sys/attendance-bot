require('dotenv').config();

const config = require('./config');
const logger = require('./logger');
const { startScheduler, executeTask } = require('./scheduler');
const { closeBrowser } = require('./browser');

// Parse CLI arguments
const args = process.argv.slice(2);
const runNow = args.includes('--run-now');
const dryRun = args.includes('--dry-run');
const runMorning = args.includes('--morning');
const runEvening = args.includes('--evening');

// Override dry run from CLI
if (dryRun) {
  config.dryRun = true;
  logger.info('🔧 DRY RUN mode enabled via CLI flag');
}

/**
 * Main application entry point
 */
async function main() {
  logger.info('');
  logger.info('╔══════════════════════════════════════════════════╗');
  logger.info('║     HPU Backoffice - Attendance Autoloader       ║');
  logger.info('║     Daily Task Form Automation                   ║');
  logger.info('╠══════════════════════════════════════════════════╣');
  logger.info(`║  User ID:     ${config.userId.padEnd(35)}║`);
  logger.info(`║  Timezone:    ${config.timezone.padEnd(35)}║`);
  logger.info(`║  Dry Run:     ${String(config.dryRun).padEnd(35)}║`);
  logger.info(`║  Headless:    ${String(config.headless).padEnd(35)}║`);
  logger.info(`║  AI:          ${(config.geminiApiKey && config.geminiApiKey !== 'your_gemini_api_key_here' ? 'Gemini ✅' : 'Fallback (no API key)').padEnd(35)}║`);
  logger.info('╚══════════════════════════════════════════════════╝');
  logger.info('');

  if (runNow || runMorning || runEvening) {
    // Immediate execution mode
    const shift = runEvening ? 'evening' : 'morning';
    logger.info(`🏃 Running ${shift} shift task immediately...`);

    try {
      const success = await executeTask(shift);

      // If --run-now, run both shifts
      if (runNow && !runMorning && !runEvening) {
        logger.info('Running evening shift as well (--run-now mode)...');
        await executeTask('evening');
      }

      process.exit(success ? 0 : 1);
    } catch (error) {
      logger.error('Immediate execution failed:', error);
      process.exit(1);
    }
  } else {
    // Scheduler mode (default)
    startScheduler();

    // Keep the process alive
    logger.info('Process running. Press Ctrl+C to stop.');
  }
}

// Graceful shutdown
async function shutdown(signal) {
  logger.info(`\n${signal} received. Shutting down gracefully...`);
  await closeBrowser();
  logger.info('Goodbye! 👋');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

// Start the application
main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
