/**
 * Centralized Logger Module
 *
 * Bridges frontend logging to the Go backend via Wails bindings.
 * All logs are sent to the backend where they are:
 * - Written to rotating log files (~/.cyberlife/logs/)
 * - Output to stdout in development mode
 * - Structured as JSON for easy analysis
 * - Sanitized to remove sensitive data (passwords, tokens, etc.)
 *
 * Usage:
 *   import { log } from './logger.js';
 *
 *   await log.info('ModuleName', 'Something happened', { key: 'value' });
 *   await log.error('ModuleName', 'Something failed', { error: err.message });
 *   log.debug('ModuleName', 'Debug info', { data: someData }); // fire-and-forget
 *   log.warn('ModuleName', 'Warning message', { context: 'details' });
 */

import { Log, IsDevMode } from '../../wailsjs/go/main/App.js';

// Cache for dev mode status (fetched once from backend)
let devModeCache = null;
let devModePromise = null;

// Console styling for different log levels
const CONSOLE_STYLES = {
    debug: 'color: #888',
    info: 'color: #2196F3',
    warn: 'color: #FF9800; font-weight: bold',
    error: 'color: #F44336; font-weight: bold'
};

// Valid log levels
const VALID_LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * Get dev mode status from backend (cached)
 * @returns {Promise<boolean>}
 */
async function getDevMode() {
    if (devModeCache !== null) {
        return devModeCache;
    }

    if (devModePromise === null) {
        devModePromise = IsDevMode()
            .then(value => {
                devModeCache = value;
                return value;
            })
            .catch(() => {
                // Default to true if we can't get the value
                devModeCache = true;
                return true;
            });
    }

    return devModePromise;
}

/**
 * Sanitize data to remove potentially sensitive information on frontend side
 * (Backend also sanitizes, but this provides defense in depth)
 * @param {Object} data - Data object to sanitize
 * @returns {Object} Sanitized data
 */
function sanitizeData(data) {
    if (!data || typeof data !== 'object') {
        return data;
    }

    const sensitivePatterns = [
        /password/i, /passwd/i, /pwd/i,
        /token/i, /secret/i, /api[_-]?key/i,
        /auth/i, /credential/i, /private/i,
        /session/i, /cookie/i
    ];

    const result = {};
    for (const [key, value] of Object.entries(data)) {
        const isSensitive = sensitivePatterns.some(pattern => pattern.test(key));
        if (isSensitive) {
            result[key] = '[REDACTED]';
        } else if (typeof value === 'string' && value.length > 1000) {
            result[key] = value.substring(0, 1000) + '...[truncated]';
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Internal function to send log to backend
 * @param {string} level - Log level (debug, info, warn, error)
 * @param {string} module - Module name (e.g., 'ToolsPanel', 'Terminal')
 * @param {string} message - Log message
 * @param {Object} data - Additional data to log
 * @returns {Promise<void>}
 */
async function sendLog(level, module, message, data = {}) {
    // Validate level
    const normalizedLevel = VALID_LEVELS.includes(level.toLowerCase())
        ? level.toLowerCase()
        : 'info';

    // Sanitize data on frontend side (defense in depth)
    const sanitizedData = sanitizeData(data);

    // Log to console in dev mode for immediate feedback
    const isDevMode = await getDevMode();
    if (isDevMode) {
        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${normalizedLevel.toUpperCase()}] [${module}]`;

        switch (normalizedLevel) {
            case 'error':
                console.error(`%c${prefix}`, CONSOLE_STYLES[normalizedLevel], message, sanitizedData);
                break;
            case 'warn':
                console.warn(`%c${prefix}`, CONSOLE_STYLES[normalizedLevel], message, sanitizedData);
                break;
            case 'debug':
                console.debug(`%c${prefix}`, CONSOLE_STYLES[normalizedLevel], message, sanitizedData);
                break;
            default:
                console.log(`%c${prefix}`, CONSOLE_STYLES[normalizedLevel], message, sanitizedData);
        }
    }

    // Send to backend
    try {
        await Log(normalizedLevel, module, message, sanitizedData || {});
    } catch (err) {
        // Only log to console if we haven't already (avoid duplicate logs)
        if (!isDevMode) {
            console.error('[Logger] Failed to send log to backend:', err);
        }
    }
}

/**
 * Logger object with methods for each log level.
 * All methods return Promises that resolve when the log is sent.
 */
export const log = {
    /**
     * Log debug message (verbose, for development)
     * @param {string} module - Module name
     * @param {string} message - Log message
     * @param {Object} [data] - Additional data
     * @returns {Promise<void>}
     */
    debug: (module, message, data) => sendLog('debug', module, message, data),

    /**
     * Log info message (general information)
     * @param {string} module - Module name
     * @param {string} message - Log message
     * @param {Object} [data] - Additional data
     * @returns {Promise<void>}
     */
    info: (module, message, data) => sendLog('info', module, message, data),

    /**
     * Log warning message (potential issues)
     * @param {string} module - Module name
     * @param {string} message - Log message
     * @param {Object} [data] - Additional data
     * @returns {Promise<void>}
     */
    warn: (module, message, data) => sendLog('warn', module, message, data),

    /**
     * Log error message (failures, exceptions)
     * @param {string} module - Module name
     * @param {string} message - Log message
     * @param {Object} [data] - Additional data
     * @returns {Promise<void>}
     */
    error: (module, message, data) => sendLog('error', module, message, data),
};

/**
 * Create a module-specific logger (for convenience)
 * @param {string} moduleName - The module name to use for all logs
 * @returns {Object} Logger with module pre-bound
 *
 * Usage:
 *   const logger = createModuleLogger('ToolsPanel');
 *   await logger.info('Loading prompts');
 *   logger.error('Failed to load', { error: err.message }); // fire-and-forget
 */
export function createModuleLogger(moduleName) {
    return {
        debug: (message, data) => log.debug(moduleName, message, data),
        info: (message, data) => log.info(moduleName, message, data),
        warn: (message, data) => log.warn(moduleName, message, data),
        error: (message, data) => log.error(moduleName, message, data),
    };
}

/**
 * Initialize the logger (pre-fetch dev mode status)
 * Call this early in app startup for better performance
 * @returns {Promise<void>}
 */
export async function initLogger() {
    await getDevMode();
}

// Export default for simple import
export default log;
