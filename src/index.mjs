#!/usr/bin/env node
/**
 * Numori CRDT — CLI entrypoint.
 *
 * Reads configuration from the environment, starts the service, and shuts down
 * gracefully on SIGTERM/SIGINT so in-flight documents are flushed before exit.
 *
 * See README.md for the full environment reference, or .env.example for a
 * copy-paste starting point.
 */
import { loadConfig, describeConfig, ConfigError } from './config.mjs'
import { createService } from './service.mjs'
import { createLogger } from './log.mjs'

const log = createLogger()

async function main() {
  let config
  try {
    config = loadConfig(process.env)
  } catch (err) {
    if (err instanceof ConfigError) {
      // Configuration mistakes are the most common startup failure, so print
      // the problem plainly rather than a stack trace.
      log.error('Configuration error:', err.message)
      log.error('See README.md or .env.example for the expected settings.')
      process.exit(78) // EX_CONFIG
    }
    throw err
  }

  log.info('starting numori-crdt with config:', JSON.stringify(describeConfig(config), null, 2))

  const service = await createService(config)
  await service.start()

  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) {
      log.warn(`${signal} received again — forcing exit`)
      process.exit(1)
    }
    shuttingDown = true
    log.info(`${signal} received, shutting down…`)

    // Bound the graceful window: an orchestrator will SIGKILL eventually, and
    // exiting cleanly on our own terms produces better logs.
    const forceTimer = setTimeout(() => {
      log.error(`shutdown exceeded ${config.shutdownGraceMs}ms — forcing exit`)
      process.exit(1)
    }, config.shutdownGraceMs)
    forceTimer.unref()

    try {
      await service.stop()
      clearTimeout(forceTimer)
      process.exit(0)
    } catch (err) {
      log.error('error during shutdown:', err?.message)
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // Never leave the process in an unknown state after an unhandled failure —
  // let the supervisor restart it cleanly.
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection:', reason instanceof Error ? reason.stack : reason)
  })
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception:', err?.stack || err?.message)
    shutdown('uncaughtException')
  })
}

main().catch((err) => {
  log.error('fatal:', err?.stack || err?.message || err)
  process.exit(1)
})
