/**
 * Numori CRDT — tiny levelled logger.
 *
 * The service is expected to run in a container where stdout/stderr is the log
 * sink, so there is no file handling or transport here. Everything goes through
 * console.warn/console.error (never console.log) so log output cannot be
 * confused with process output, and so the lint rule banning console.log holds
 * everywhere else in the codebase.
 *
 * Level is set once from CRDT_LOG_LEVEL (silent | error | warn | info | debug).
 * Default is "info", which is quiet enough for production but still records
 * every connection accept/reject decision.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }

function resolveLevel(raw) {
  const key = String(raw || 'info').toLowerCase()
  return Object.prototype.hasOwnProperty.call(LEVELS, key) ? LEVELS[key] : LEVELS.info
}

let threshold = resolveLevel(process.env.CRDT_LOG_LEVEL)

/** Override the active log level (used by tests to silence output). */
export function setLogLevel(level) {
  threshold = resolveLevel(level)
}

export function getLogLevel() {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === threshold) ?? 'info'
}

function emit(level, scope, args) {
  if (LEVELS[level] > threshold) return
  const prefix = scope ? `[crdt:${scope}]` : '[crdt]'
  if (level === 'error') console.error(prefix, ...args)
  else console.warn(prefix, ...args)
}

/**
 * Create a logger bound to a scope, e.g. `createLogger('notes')` for a tenant
 * or `createLogger('router')` for the HTTP layer.
 *
 * @param {string} [scope]
 * @returns {{error:Function,warn:Function,info:Function,debug:Function,child:Function}}
 */
export function createLogger(scope = '') {
  return {
    error: (...args) => emit('error', scope, args),
    warn: (...args) => emit('warn', scope, args),
    info: (...args) => emit('info', scope, args),
    debug: (...args) => emit('debug', scope, args),
    child: (sub) => createLogger(scope ? `${scope}:${sub}` : sub),
  }
}

export const log = createLogger()
