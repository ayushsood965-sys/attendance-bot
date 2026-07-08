require('dotenv').config();

const config = {
  // Login
  loginUrl: 'https://backoffice.hpushimla.in/Loginpage.aspx',
  userId: process.env.LOGIN_USER_ID || 'SM4113',
  password: process.env.LOGIN_PASSWORD || 'hpu@321',

  // AI
  geminiApiKey: process.env.GEMINI_API_KEY,

  // Timezone
  timezone: 'Asia/Kolkata',

  // Schedule (cron expressions in IST)
  morningCron: '0 11 * * 1-6',   // 11:00 AM Mon-Sat
  eveningCron: '30 14 * * 1-6',  // 2:30 PM Mon-Sat

  // Random delay range (ms) to appear human-like
  minRandomDelay: 0,
  maxRandomDelay: 15 * 60 * 1000,

  // Retry
  maxRetries: 3,
  retryDelay: 30000,

  // Behavior
  skipWeekends: process.env.SKIP_WEEKENDS === 'true',
  dryRun: process.env.DRY_RUN === 'true',
  logLevel: process.env.LOG_LEVEL || 'info',

  // Puppeteer
  headless: process.env.NODE_ENV === 'production' ? 'auto' : false,
  navigationTimeout: 60000,
  defaultTimeout: 30000,

  // Paths
  screenshotDir: './screenshots',
  logDir: './logs',

  // Shift hours
  shiftHours: {
    morning: '4',
    evening: '3',
  },

  // Dropdown visible text values (from screenshot)
  dropdownValues: {
    shift: {
      morning: 'Morning',
      evening: 'Evening',
      extra: 'Extra work',
    },
    workType: 'Programmer',
    activityStatus: 'Completed',
  },
};

module.exports = config;
