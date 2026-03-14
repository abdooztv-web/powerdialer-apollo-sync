/**
 * Simple logger utility
 * Formats log messages with timestamps and emoji for easy reading
 */

const LOG_LEVELS = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR'
};

function formatTimestamp() {
  return new Date().toISOString();
}

function log(level, message, data = {}) {
  const timestamp = formatTimestamp();
  const logEntry = {
    timestamp,
    level,
    message,
    ...data
  };

  if (level === LOG_LEVELS.ERROR) {
    console.error(JSON.stringify(logEntry, null, 2));
  } else if (level === LOG_LEVELS.WARN) {
    console.warn(JSON.stringify(logEntry, null, 2));
  } else {
    console.log(JSON.stringify(logEntry, null, 2));
  }
}

const logger = {
  info: (message, data) => log(LOG_LEVELS.INFO, message, data),
  warn: (message, data) => log(LOG_LEVELS.WARN, message, data),
  error: (message, data) => log(LOG_LEVELS.ERROR, message, data)
};

module.exports = logger;
