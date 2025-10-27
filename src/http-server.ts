#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import dotenv from 'dotenv'
import type { Request, Response } from 'express'
import express from 'express'
import { getMcpServer } from './mcp-server.js'

dotenv.config()

const app = express()
const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000
const TODOIST_BASE_URL = process.env.TODOIST_BASE_URL
const USE_HTTPS = process.env.USE_HTTPS === 'true'
const HTTPS_KEY_PATH = process.env.HTTPS_KEY_PATH
const HTTPS_CERT_PATH = process.env.HTTPS_CERT_PATH

// Store active transports by session ID
const transports = new Map<string, StreamableHTTPServerTransport>()

/**
 * Extract Todoist API token from request headers.
 * Supports both X-Todoist-Token header and Authorization Bearer token.
 */
function extractTodoistToken(req: Request): string | null {
    // Try X-Todoist-Token header first
    const customHeader = req.headers['x-todoist-token']
    if (customHeader && typeof customHeader === 'string') {
        return customHeader.trim()
    }

    // Fallback to Authorization Bearer token
    const authHeader = req.headers.authorization
    if (authHeader && typeof authHeader === 'string') {
        const match = authHeader.match(/^Bearer\s+(.+)$/i)
        if (match?.[1]) {
            return match[1].trim()
        }
    }

    return null
}

/**
 * ALL /mcp - Handle MCP Streamable HTTP requests (GET, POST, DELETE)
 */
app.all('/mcp', express.json(), async (req: Request, res: Response) => {
    try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined

        if (sessionId) {
            console.error(`[INFO] Received ${req.method} request for session: ${sessionId}`)
        } else {
            console.error(`[INFO] Received ${req.method} request without session ID`)
        }

        let transport: StreamableHTTPServerTransport | undefined

        if (sessionId && transports.has(sessionId)) {
            // Reuse existing transport
            transport = transports.get(sessionId)
        } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
            // New initialization request - extract token from headers
            const todoistApiKey = extractTodoistToken(req)

            if (!todoistApiKey) {
                res.status(401).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message:
                            'Unauthorized: Please provide a Todoist API token via X-Todoist-Token header or Authorization: Bearer <token>',
                    },
                    id: null,
                })
                return
            }

            // Check if LibreChat didn't substitute the customUserVar
            if (todoistApiKey.includes('{{') || todoistApiKey.includes('}}')) {
                console.error(
                    '[ERROR] LibreChat customUserVars not substituted - received template variable instead of token',
                )
                res.status(401).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message:
                            'Configuration error: LibreChat customUserVars not working. The template variable was not substituted. Please check your LibreChat configuration and ensure the user has entered their Todoist API token.',
                    },
                    id: null,
                })
                return
            }

            console.error('[INFO] Initializing new MCP session with Todoist authentication')

            // Create new transport with session management
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (newSessionId: string) => {
                    // Store the transport by session ID when session is initialized
                    console.error(`[INFO] Session initialized with ID: ${newSessionId}`)
                    transports.set(newSessionId, transport as StreamableHTTPServerTransport)
                },
                onsessionclosed: (closedSessionId: string) => {
                    // Clean up when session is explicitly closed
                    console.error(`[INFO] Session closed: ${closedSessionId}`)
                    transports.delete(closedSessionId)
                },
            })

            // Set up onclose handler to clean up transport when connection closes
            transport.onclose = () => {
                const sid = transport?.sessionId
                if (sid && transports.has(sid)) {
                    console.error(`[INFO] Transport closed for session ${sid}, cleaning up`)
                    transports.delete(sid)
                }
            }

            transport.onerror = (error: Error) => {
                console.error('[ERROR] Transport error:', error.message)
                const sid = transport?.sessionId
                if (sid) {
                    transports.delete(sid)
                }
            }

            // Create per-user MCP server instance
            const server = getMcpServer({ todoistApiKey, baseUrl: TODOIST_BASE_URL })

            // Connect the transport to the MCP server BEFORE handling the request
            await server.connect(transport)
        } else {
            // Invalid request - no session ID or not initialization request
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message:
                        'Bad Request: No valid session ID provided or not an initialization request',
                },
                id: null,
            })
            return
        }

        // Handle the request with the transport
        if (transport) {
            await transport.handleRequest(req, res, req.body)
        }
    } catch (error) {
        console.error('[ERROR] Error handling MCP request:', error)
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: error instanceof Error ? error.message : 'Internal server error',
                },
                id: null,
            })
        }
    }
})

/**
 * GET / - Health check endpoint
 */
app.get('/', (_req: Request, res: Response) => {
    res.json({
        name: 'Todoist MCP Streaming HTTP Server',
        version: '4.14.0',
        status: 'running',
        endpoint: '/mcp',
        methods: ['GET', 'POST', 'DELETE'],
        activeSessions: transports.size,
    })
})

/**
 * Start the Express server (HTTP or HTTPS based on configuration)
 */
function main() {
    if (USE_HTTPS) {
        // HTTPS mode
        if (!HTTPS_KEY_PATH || !HTTPS_CERT_PATH) {
            console.error('[ERROR] HTTPS enabled but HTTPS_KEY_PATH or HTTPS_CERT_PATH not set')
            process.exit(1)
        }

        try {
            const httpsOptions = {
                key: readFileSync(HTTPS_KEY_PATH),
                cert: readFileSync(HTTPS_CERT_PATH),
            }

            const httpsServer = createHttpsServer(httpsOptions, app)
            httpsServer.listen(PORT, '::', () => {
                const addr = httpsServer.address()
                console.error('='.repeat(60))
                console.error('Todoist MCP Streaming HTTP Server (HTTPS)')
                console.error('='.repeat(60))
                console.error(`Port: ${PORT}`)
                console.error(`Listening on: ${typeof addr === 'object' ? addr?.address : addr}`)
                console.error('IPv6: ✓ (binding to ::)')
                console.error('IPv4: ✓ (via IPv4-mapped IPv6 addresses)')
                console.error(`MCP endpoint: https://localhost:${PORT}/mcp`)
                console.error(`Health check: https://localhost:${PORT}/`)
                console.error('='.repeat(60))
            })
        } catch (error) {
            console.error('[ERROR] Failed to start HTTPS server:', error)
            process.exit(1)
        }
    } else {
        // HTTP mode (default)
        const httpServer = createHttpServer(app)
        httpServer.listen(PORT, '::', () => {
            const addr = httpServer.address()
            console.error('='.repeat(60))
            console.error('Todoist MCP Streaming HTTP Server (HTTP)')
            console.error('='.repeat(60))
            console.error(`Port: ${PORT}`)
            console.error(`Listening on: ${typeof addr === 'object' ? addr?.address : addr}`)
            console.error('IPv6: ✓ (binding to ::)')
            console.error('IPv4: ✓ (via IPv4-mapped IPv6 addresses)')
            console.error(`MCP endpoint: http://localhost:${PORT}/mcp`)
            console.error(`Health check: http://localhost:${PORT}/`)
            if (process.env.RAILWAY_PRIVATE_DOMAIN) {
                console.error(`Internal URL: http://${process.env.RAILWAY_PRIVATE_DOMAIN}/mcp`)
            }
            console.error('='.repeat(60))
        })
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.error('[INFO] Shutting down server...')
    // Close all active transports to properly clean up resources
    for (const [sessionId, transport] of transports.entries()) {
        try {
            console.error(`[INFO] Closing transport for session ${sessionId}`)
            await transport.close()
            transports.delete(sessionId)
        } catch (error) {
            console.error(`[ERROR] Error closing transport for session ${sessionId}:`, error)
        }
    }
    console.error('[INFO] Server shutdown complete')
    process.exit(0)
})

main()
