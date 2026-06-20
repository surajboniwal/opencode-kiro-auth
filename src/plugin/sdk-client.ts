import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { KIRO_CONSTANTS } from '../constants.js'
import * as logger from './logger.js'
import type { Effort, KiroAuthDetails } from './types'

/**
 * Cache key includes effort to ensure separate clients for different effort levels,
 * since middleware is configured at client creation time.
 */
interface ClientCacheEntry {
  client: CodeWhispererStreamingClient
  token: string
  effort?: Effort
}

const clientCache = new Map<string, ClientCacheEntry>()
const KIRO_CLI_MAX_ATTEMPTS = 3

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  effort?: Effort
): CodeWhispererStreamingClient {
  const cacheKey = `${region}:${auth.email || 'default'}:${effort || 'none'}`
  const cached = clientCache.get(cacheKey)

  if (cached && cached.token === auth.access && cached.effort === effort) {
    return cached.client
  }

  const token = auth.access
  const client = new CodeWhispererStreamingClient({
    region,
    endpoint: `https://q.${region}.amazonaws.com`,
    token: () => Promise.resolve({ token }),
    maxAttempts: KIRO_CLI_MAX_ATTEMPTS,
    retryMode: 'standard',
    customUserAgent: [[KIRO_CONSTANTS.USER_AGENT]]
  })

  // Add Kiro-specific headers
  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  // Inject additionalModelRequestFields for effort-based thinking control
  if (effort) {
    logger.log(`[Effort] Adding middleware to inject effort: ${effort}`)
    client.middlewareStack.add(
      (next: any) => async (args: any) => {
        // The SDK serializes input to args.input, we need to modify the body
        // before it's sent. The body is in args.request.body as a string.
        if (args.request?.body) {
          try {
            const body = JSON.parse(args.request.body)
            body.additionalModelRequestFields = {
              output_config: {
                effort
              }
            }
            args.request.body = JSON.stringify(body)
            logger.log(`[Effort] Injected additionalModelRequestFields.output_config.effort=${effort}`)
            // Dump the top-level keys of final request body for verification
            logger.log(`[Effort] Final request body keys: ${Object.keys(body).join(', ')}`)
            logger.log(`[Effort] Final body.additionalModelRequestFields: ${JSON.stringify(body.additionalModelRequestFields)}`)
          } catch {
            // If body parsing fails, continue without modification
            logger.warn('[Effort] Failed to parse request body for effort injection')
          }
        } else {
          logger.warn('[Effort] No args.request.body found - checking args structure')
          logger.log(`[Effort] args keys: ${Object.keys(args || {}).join(', ')}`)
          logger.log(`[Effort] args.request keys: ${Object.keys(args?.request || {}).join(', ')}`)
          logger.log(`[Effort] args.input keys: ${Object.keys(args?.input || {}).join(', ')}`)
        }
        return next(args)
      },
      { step: 'build', name: 'addEffortConfig', priority: 'low' }
    )
  }

  clientCache.set(cacheKey, { client, token, effort })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}
