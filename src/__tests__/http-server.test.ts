import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Express } from 'express'
import express from 'express'
import request from 'supertest'

// Mock the getMcpServer function
jest.mock('../mcp-server.js', () => ({
    getMcpServer: jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
    })),
}))

describe('HTTP Server', () => {
    let app: Express
    let server: Server
    const transports = new Map<string, StreamableHTTPServerTransport>()
    const validToken = 'test-todoist-token-123'

    function extractTodoistToken(req: express.Request): string | null {
        const customHeader = req.headers['x-todoist-token']
        if (customHeader && typeof customHeader === 'string') {
            return customHeader.trim()
        }

        const authHeader = req.headers.authorization
        if (authHeader && typeof authHeader === 'string') {
            const match = authHeader.match(/^Bearer\s+(.+)$/i)
            if (match?.[1]) {
                return match[1].trim()
            }
        }

        return null
    }

    beforeEach(() => {
        app = express()
        app.use(express.json())
        transports.clear()

        // Health check endpoint
        app.get('/', (_req, res) => {
            res.json({
                name: 'Todoist MCP Streaming HTTP Server',
                version: '4.14.0',
                status: 'running',
                endpoint: '/mcp',
                methods: ['GET', 'POST', 'DELETE'],
                activeSessions: transports.size,
            })
        })

        // MCP endpoint (simplified for testing)
        app.all('/mcp', express.json(), async (req, res) => {
            try {
                const sessionId = req.headers['mcp-session-id'] as string | undefined

                // For testing, we'll simulate basic behavior
                if (!sessionId && req.method === 'POST') {
                    // Check if this is an initialize request
                    const isInitialize = req.body?.method === 'initialize'

                    if (!isInitialize) {
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

                    // Initialization request
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

                    if (todoistApiKey.includes('{{') || todoistApiKey.includes('}}')) {
                        res.status(401).json({
                            jsonrpc: '2.0',
                            error: {
                                code: -32000,
                                message:
                                    'Configuration error: LibreChat customUserVars not working. The template variable was not substituted.',
                            },
                            id: null,
                        })
                        return
                    }

                    // Simulate successful initialization
                    const newSessionId = randomUUID()
                    res.setHeader('Mcp-Session-Id', newSessionId)
                    res.json({
                        jsonrpc: '2.0',
                        result: {
                            protocolVersion: '2025-03-26',
                            capabilities: {},
                            serverInfo: {
                                name: 'todoist-mcp-server',
                                version: '0.1.0',
                            },
                        },
                        id: 1,
                    })
                    return
                }

                if (sessionId && req.method === 'POST') {
                    // Existing session request
                    res.json({
                        jsonrpc: '2.0',
                        result: { success: true },
                        id: 1,
                    })
                    return
                }

                if (sessionId && req.method === 'DELETE') {
                    // Session termination
                    transports.delete(sessionId)
                    res.status(200).send()
                    return
                }

                res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message:
                            'Bad Request: No valid session ID provided or not an initialization request',
                    },
                    id: null,
                })
            } catch (error) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: error instanceof Error ? error.message : 'Internal server error',
                    },
                    id: null,
                })
            }
        })

        server = app.listen(0) // Random available port
    })

    afterEach((done) => {
        server.close(done)
        transports.clear()
    })

    describe('Health Check Endpoint', () => {
        it('should return server status', async () => {
            const response = await request(app).get('/')

            expect(response.status).toBe(200)
            expect(response.body).toEqual({
                name: 'Todoist MCP Streaming HTTP Server',
                version: '4.14.0',
                status: 'running',
                endpoint: '/mcp',
                methods: ['GET', 'POST', 'DELETE'],
                activeSessions: 0,
            })
        })

        it('should return correct content type', async () => {
            const response = await request(app).get('/')

            expect(response.headers['content-type']).toMatch(/application\/json/)
        })
    })

    describe('Authentication', () => {
        describe('X-Todoist-Token header', () => {
            it('should accept valid token via X-Todoist-Token header', async () => {
                const response = await request(app)
                    .post('/mcp')
                    .set('X-Todoist-Token', validToken)
                    .send({
                        jsonrpc: '2.0',
                        method: 'initialize',
                        params: {},
                        id: 1,
                    })

                expect(response.status).toBe(200)
                expect(response.headers['mcp-session-id']).toBeDefined()
                expect(response.body.jsonrpc).toBe('2.0')
                expect(response.body.result).toBeDefined()
            })

            it('should reject request without token', async () => {
                const response = await request(app).post('/mcp').send({
                    jsonrpc: '2.0',
                    method: 'initialize',
                    params: {},
                    id: 1,
                })

                expect(response.status).toBe(401)
                expect(response.body.error.message).toContain('Please provide a Todoist API token')
            })

            it('should trim whitespace from token', async () => {
                const response = await request(app)
                    .post('/mcp')
                    .set('X-Todoist-Token', `  ${validToken}  `)
                    .send({
                        jsonrpc: '2.0',
                        method: 'initialize',
                        params: {},
                        id: 1,
                    })

                expect(response.status).toBe(200)
            })
        })

        describe('Authorization Bearer header', () => {
            it('should accept valid token via Authorization header', async () => {
                const response = await request(app)
                    .post('/mcp')
                    .set('Authorization', `Bearer ${validToken}`)
                    .send({
                        jsonrpc: '2.0',
                        method: 'initialize',
                        params: {},
                        id: 1,
                    })

                expect(response.status).toBe(200)
                expect(response.headers['mcp-session-id']).toBeDefined()
            })

            it('should handle Bearer token case-insensitively', async () => {
                const response = await request(app)
                    .post('/mcp')
                    .set('Authorization', `bearer ${validToken}`)
                    .send({
                        jsonrpc: '2.0',
                        method: 'initialize',
                        params: {},
                        id: 1,
                    })

                expect(response.status).toBe(200)
            })

            it('should trim whitespace from Bearer token', async () => {
                const response = await request(app)
                    .post('/mcp')
                    .set('Authorization', `Bearer   ${validToken}  `)
                    .send({
                        jsonrpc: '2.0',
                        method: 'initialize',
                        params: {},
                        id: 1,
                    })

                expect(response.status).toBe(200)
            })
        })

        describe('LibreChat template variable validation', () => {
            it('should reject unsubstituted template variables', async () => {
                const response = await request(app)
                    .post('/mcp')
                    .set('X-Todoist-Token', '{{TODOIST_API_TOKEN}}')
                    .send({
                        jsonrpc: '2.0',
                        method: 'initialize',
                        params: {},
                        id: 1,
                    })

                expect(response.status).toBe(401)
                expect(response.body.error.message).toContain(
                    'LibreChat customUserVars not working',
                )
            })

            it('should reject partial template variables', async () => {
                const response = await request(app)
                    .post('/mcp')
                    .set('X-Todoist-Token', 'prefix-{{VAR}}-suffix')
                    .send({
                        jsonrpc: '2.0',
                        method: 'initialize',
                        params: {},
                        id: 1,
                    })

                expect(response.status).toBe(401)
            })
        })
    })

    describe('Session Management', () => {
        it('should generate unique session IDs', async () => {
            const response1 = await request(app)
                .post('/mcp')
                .set('X-Todoist-Token', validToken)
                .send({
                    jsonrpc: '2.0',
                    method: 'initialize',
                    params: {},
                    id: 1,
                })

            const response2 = await request(app)
                .post('/mcp')
                .set('X-Todoist-Token', validToken)
                .send({
                    jsonrpc: '2.0',
                    method: 'initialize',
                    params: {},
                    id: 1,
                })

            const sessionId1 = response1.headers['mcp-session-id']
            const sessionId2 = response2.headers['mcp-session-id']

            expect(sessionId1).toBeDefined()
            expect(sessionId2).toBeDefined()
            expect(sessionId1).not.toBe(sessionId2)
        })

        it('should accept requests with valid session ID', async () => {
            // Initialize session
            const initResponse = await request(app)
                .post('/mcp')
                .set('X-Todoist-Token', validToken)
                .send({
                    jsonrpc: '2.0',
                    method: 'initialize',
                    params: {},
                    id: 1,
                })

            const sessionId = initResponse.headers['mcp-session-id'] as string
            expect(sessionId).toBeDefined()

            // Make request with session ID
            const response = await request(app).post('/mcp').set('Mcp-Session-Id', sessionId).send({
                jsonrpc: '2.0',
                method: 'tools/list',
                params: {},
                id: 2,
            })

            expect(response.status).toBe(200)
        })

        it('should handle session termination', async () => {
            // Initialize session
            const initResponse = await request(app)
                .post('/mcp')
                .set('X-Todoist-Token', validToken)
                .send({
                    jsonrpc: '2.0',
                    method: 'initialize',
                    params: {},
                    id: 1,
                })

            const sessionId = initResponse.headers['mcp-session-id'] as string
            expect(sessionId).toBeDefined()

            // Terminate session
            const deleteResponse = await request(app)
                .delete('/mcp')
                .set('Mcp-Session-Id', sessionId)

            expect(deleteResponse.status).toBe(200)
        })
    })

    describe('Error Handling', () => {
        it('should return 400 for POST without session ID and not an initialize request', async () => {
            const response = await request(app)
                .post('/mcp')
                .set('X-Todoist-Token', validToken)
                .send({
                    jsonrpc: '2.0',
                    method: 'tools/list',
                    params: {},
                    id: 1,
                })

            expect(response.status).toBe(400)
            expect(response.body.error.message).toContain('Bad Request')
        })

        it('should handle invalid JSON gracefully', async () => {
            const response = await request(app)
                .post('/mcp')
                .set('X-Todoist-Token', validToken)
                .set('Content-Type', 'application/json')
                .send('invalid json{')

            expect(response.status).toBe(400)
        })

        it('should return proper JSON-RPC error format', async () => {
            const response = await request(app).post('/mcp').send({
                jsonrpc: '2.0',
                method: 'initialize',
                params: {},
                id: 1,
            })

            expect(response.status).toBe(401)
            expect(response.body).toHaveProperty('jsonrpc', '2.0')
            expect(response.body).toHaveProperty('error')
            expect(response.body.error).toHaveProperty('code')
            expect(response.body.error).toHaveProperty('message')
            expect(response.body).toHaveProperty('id', null)
        })
    })

    describe('HTTP Methods', () => {
        it('should handle POST requests', async () => {
            const response = await request(app)
                .post('/mcp')
                .set('X-Todoist-Token', validToken)
                .send({
                    jsonrpc: '2.0',
                    method: 'initialize',
                    params: {},
                    id: 1,
                })

            expect(response.status).toBe(200)
        })

        it('should handle DELETE requests with session ID', async () => {
            const sessionId = randomUUID()

            const response = await request(app).delete('/mcp').set('Mcp-Session-Id', sessionId)

            expect(response.status).toBe(200)
        })

        it('should handle unsupported methods on /mcp', async () => {
            const response = await request(app).put('/mcp')

            // PUT is handled by app.all, so it will process but likely return 400
            expect([400, 404, 405]).toContain(response.status)
        })
    })

    describe('Header Extraction', () => {
        it('should extract token from custom header', () => {
            const mockReq = {
                headers: {
                    'x-todoist-token': 'test-token-123',
                },
            } as unknown as express.Request

            const token = extractTodoistToken(mockReq)
            expect(token).toBe('test-token-123')
        })

        it('should extract token from Authorization header', () => {
            const mockReq = {
                headers: {
                    authorization: 'Bearer test-token-456',
                },
            } as unknown as express.Request

            const token = extractTodoistToken(mockReq)
            expect(token).toBe('test-token-456')
        })

        it('should prioritize X-Todoist-Token over Authorization', () => {
            const mockReq = {
                headers: {
                    'x-todoist-token': 'custom-token',
                    authorization: 'Bearer auth-token',
                },
            } as unknown as express.Request

            const token = extractTodoistToken(mockReq)
            expect(token).toBe('custom-token')
        })

        it('should return null when no token is provided', () => {
            const mockReq = {
                headers: {},
            } as unknown as express.Request

            const token = extractTodoistToken(mockReq)
            expect(token).toBeNull()
        })

        it('should handle array values for headers gracefully', () => {
            const mockReq = {
                headers: {
                    'x-todoist-token': ['token1', 'token2'],
                },
            } as unknown as express.Request

            const token = extractTodoistToken(mockReq)
            expect(token).toBeNull()
        })
    })
})
