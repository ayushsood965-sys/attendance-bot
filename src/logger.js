const winston = require('winston');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// Ensure directories exist
const logDir = path.resolve(config.logDir);
const screenshotDir = path.resolve(config.screenshotDir);
[logDir, screenshotDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
      let log = `${timestamp} [${level.toUpperCase().padEnd(5)}] ${message}`;
      if (stack) log += `\n${stack}`;
      if (Object.keys(meta).length > 0) {
        log += ` ${JSON.stringify(meta)}`;
      }
      return log;
    })
  ),
  transports: [
    // Console output (colorized)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message, stack }) => {
          let log = `${timestamp} ${level} ${message}`;
          if (stack) log += `\n${stack}`;
          return log;
        })
      ),
    }),
    // Daily file rotation
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 10,
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 20,
    }),
  ],
});

module.exports = logger;
