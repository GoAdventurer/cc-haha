import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleApiRequest } from '../router.js'
import {
  clearTraceCaptureStateForTests,
  createTraceCallId,
  createTraceBodySnapshot,
  traceCaptureService,
  updateTraceCaptureSettings,
} from '../services/traceCaptureService.js'
import { sessionService } from '../services/sessionService.js'
import { createDumpPromptsFetch } from '../../services/api/dumpPrompts.js'

let tmpDir: string
let originalConfigDir: string | undefined

async function waitForTrace(
  sessionId: string,
  predicate: (trace: Awaited<ReturnType<typeof traceCaptureService.getSessionTrace>>) => boolean,
) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const trace = await traceCaptureService.getSessionTrace(sessionId)
    if (predicate(trace)) return trace
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return traceCaptureService.getSessionTrace(sessionId)
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-capture-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  clearTraceCaptureStateForTests()
})

afterEach(async () => {
  clearTraceCaptureStateForTests()
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('trace capture service', () => {
  test('stores session scoped API calls with redacted headers and capped bodies', async () => {
    const body = {
      model: 'deepseek-v4-pro',
      api_key: 'sk-body-secret',
      messages: [
        { role: 'user', content: 'explain the failed provider response' },
      ],
      padding: 'x'.repeat(3000),
    }

    await traceCaptureService.recordCall({
      sessionId: 'session-trace-1',
      source: 'proxy',
      querySource: 'repl_main_thread',
      provider: {
        id: 'provider-deepseek',
        name: 'DeepSeek',
        format: 'openai_chat',
      },
      model: 'deepseek-v4-pro',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.047Z',
      durationMs: 47,
      request: {
        method: 'POST',
        url: 'https://api.deepseek.com/v1/chat/completions',
        headers: {
          Authorization: 'Bearer sk-header-secret',
          'Content-Type': 'application/json',
        },
        body,
      },
      response: {
        status: 200,
        headers: {
          'x-request-id': 'req-742',
        },
        body: {
          id: 'chatcmpl-742',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 31, completion_tokens: 7 },
        },
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-trace-1')

    expect(trace.summary.apiCalls).toBe(1)
    expect(trace.summary.failedCalls).toBe(0)
    expect(trace.summary.totalDurationMs).toBe(47)
    expect(trace.summary.models).toEqual([{ model: 'deepseek-v4-pro', calls: 1 }])
    expect(trace.calls[0].request.headers.Authorization).toBe('[redacted]')
    expect(trace.calls[0].request.body.preview).toContain('explain the failed provider response')
    expect(trace.calls[0].request.body.preview).not.toContain('sk-body-secret')
    expect(trace.calls[0].request.body.truncated).toBe(true)
    expect(trace.calls[0].response.body.preview).toContain('chatcmpl-742')
  })

  test('builds stable body snapshots without throwing on non-json input', () => {
    const snapshot = createTraceBodySnapshot('plain text response', { maxPreviewChars: 20 })

    expect(snapshot.contentType).toBe('text')
    expect(snapshot.preview).toBe('plain text response')
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('skips malformed trace jsonl entries when reading a session', async () => {
    const traceDir = path.join(tmpDir, 'cc-haha', 'traces')
    await fs.mkdir(traceDir, { recursive: true })
    await fs.writeFile(path.join(traceDir, 'session-corrupt.jsonl'), [
      'not-json',
      'null',
      '{}',
      JSON.stringify({
        type: 'event',
        event: {
          id: 'event-valid',
          sessionId: 'session-corrupt',
          timestamp: '2026-06-09T08:00:00.001Z',
          phase: 'api_call_started',
          severity: 'info',
        },
      }),
      JSON.stringify({
        type: 'call',
        record: {
          id: 'call-valid',
          sessionId: 'session-corrupt',
          source: 'proxy',
          status: 'ok',
          startedAt: '2026-06-09T08:00:00.000Z',
          completedAt: '2026-06-09T08:00:00.020Z',
          durationMs: 20,
          request: {
            method: 'POST',
            url: 'https://api.example.test/v1/chat/completions',
            headers: {},
            body: createTraceBodySnapshot({ model: 'gpt-5.5' }),
          },
          response: {
            status: 200,
            headers: {},
            body: createTraceBodySnapshot({ ok: true }),
          },
        },
      }),
    ].join('\n'))

    const trace = await traceCaptureService.getSessionTrace('session-corrupt')

    expect(trace.calls.map((call) => call.id)).toEqual(['call-valid'])
    expect(trace.events.map((event) => event.id)).toEqual(['event-valid'])
    expect(trace.summary.apiCalls).toBe(1)
  })

  test('upserts pending calls and preserves lifecycle events', async () => {
    const callId = createTraceCallId()
    await traceCaptureService.recordCall({
      id: callId,
      sessionId: 'session-trace-upsert',
      source: 'anthropic',
      model: 'gpt-5.5',
      status: 'pending',
      startedAt: '2026-06-09T08:00:00.000Z',
      request: {
        method: 'POST',
        url: 'https://sub2api.example.test/v1/messages',
        body: { model: 'gpt-5.5', messages: [{ role: 'user', content: 'pending' }] },
      },
    })
    await traceCaptureService.recordEvent({
      sessionId: 'session-trace-upsert',
      callId,
      phase: 'api_call_started',
      source: 'anthropic',
      model: 'gpt-5.5',
    })
    await traceCaptureService.recordCall({
      id: callId,
      sessionId: 'session-trace-upsert',
      source: 'anthropic',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.120Z',
      durationMs: 120,
      request: {
        method: 'POST',
        url: 'https://sub2api.example.test/v1/messages',
        body: { model: 'gpt-5.5', messages: [{ role: 'user', content: 'pending' }] },
      },
      response: {
        status: 200,
        body: { id: 'msg-upsert' },
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-trace-upsert')

    expect(trace.summary.apiCalls).toBe(1)
    expect(trace.calls).toHaveLength(1)
    expect(trace.calls[0].id).toBe(callId)
    expect(trace.calls[0].status).toBe('ok')
    expect(trace.events).toHaveLength(1)
    expect(trace.events[0]).toMatchObject({
      phase: 'api_call_started',
      callId,
      source: 'anthropic',
    })
  })

  test('respects managed trace capture settings before writing new records', async () => {
    await updateTraceCaptureSettings({ enabled: false })

    const result = await traceCaptureService.recordCall({
      sessionId: 'session-trace-disabled',
      source: 'proxy',
      model: 'gpt-5.5',
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        body: { model: 'gpt-5.5' },
      },
    })
    const trace = await traceCaptureService.getSessionTrace('session-trace-disabled')
    const settingsFile = JSON.parse(await fs.readFile(path.join(tmpDir, 'cc-haha', 'settings.json'), 'utf-8')) as {
      traceCapture?: { enabled?: boolean }
    }

    expect(result).toBeNull()
    expect(trace.summary.apiCalls).toBe(0)
    expect(settingsFile.traceCapture?.enabled).toBe(false)
  })

  test('captures direct Anthropic-compatible provider calls from desktop fetch override', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.CC_HAHA_TRACE_API_CALLS
    const originalProviderId = process.env.CC_HAHA_TRACE_PROVIDER_ID
    const originalProviderName = process.env.CC_HAHA_TRACE_PROVIDER_NAME
    const originalProviderFormat = process.env.CC_HAHA_TRACE_PROVIDER_FORMAT
    process.env.CC_HAHA_TRACE_API_CALLS = '1'
    process.env.CC_HAHA_TRACE_PROVIDER_ID = 'provider-sub2api'
    process.env.CC_HAHA_TRACE_PROVIDER_NAME = 'Sub2API-ChatGPT'
    process.env.CC_HAHA_TRACE_PROVIDER_FORMAT = 'anthropic'
    try {
      globalThis.fetch = (async () => new Response(
        JSON.stringify({ id: 'msg-direct-trace', content: [{ type: 'text', text: 'ok' }] }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )) as typeof fetch

      const traceFetch = createDumpPromptsFetch('agent-direct', {
        traceSessionId: 'session-direct-provider',
        querySource: 'test_query',
      })
      await traceFetch('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'trace me' }] }),
      })

      const trace = await waitForTrace(
        'session-direct-provider',
        (snapshot) => Boolean(snapshot.calls[0]?.response) && snapshot.events.length >= 2,
      )
      expect(trace.summary.apiCalls).toBe(1)
      expect(trace.calls[0]).toMatchObject({
        source: 'anthropic',
        model: 'gpt-5.5',
        querySource: 'test_query',
        provider: {
          id: 'provider-sub2api',
          name: 'Sub2API-ChatGPT',
          format: 'anthropic',
        },
      })
      expect(trace.calls[0].request.body.preview).toContain('trace me')
      expect(trace.calls[0].response.body.preview).toContain('msg-direct-trace')
      expect(trace.events.map((event) => event.phase)).toEqual(['api_call_started', 'api_call_completed'])
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.CC_HAHA_TRACE_API_CALLS
      else process.env.CC_HAHA_TRACE_API_CALLS = originalTraceEnv
      if (originalProviderId === undefined) delete process.env.CC_HAHA_TRACE_PROVIDER_ID
      else process.env.CC_HAHA_TRACE_PROVIDER_ID = originalProviderId
      if (originalProviderName === undefined) delete process.env.CC_HAHA_TRACE_PROVIDER_NAME
      else process.env.CC_HAHA_TRACE_PROVIDER_NAME = originalProviderName
      if (originalProviderFormat === undefined) delete process.env.CC_HAHA_TRACE_PROVIDER_FORMAT
      else process.env.CC_HAHA_TRACE_PROVIDER_FORMAT = originalProviderFormat
    }
  })

  test('captures direct provider fetch failures without changing thrown behavior', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.CC_HAHA_TRACE_API_CALLS
    process.env.CC_HAHA_TRACE_API_CALLS = '1'
    try {
      globalThis.fetch = (async () => {
        throw new Error('network down for trace')
      }) as typeof fetch

      const traceFetch = createDumpPromptsFetch('agent-direct-fail', {
        traceSessionId: 'session-direct-provider-fail',
        querySource: 'test_query',
      })
      await expect(traceFetch('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'trace failure' }] }),
      })).rejects.toThrow('network down for trace')

      const trace = await waitForTrace(
        'session-direct-provider-fail',
        (snapshot) => Boolean(snapshot.calls[0]?.error) && snapshot.events.length >= 2,
      )
      expect(trace.summary.apiCalls).toBe(1)
      expect(trace.summary.failedCalls).toBe(1)
      expect(trace.calls[0]).toMatchObject({
        source: 'anthropic',
        model: 'gpt-5.5',
        status: 'error',
        error: {
          name: 'Error',
          message: 'network down for trace',
        },
      })
      expect(trace.calls[0].request.body.preview).toContain('trace failure')
      expect(trace.events.map((event) => event.phase)).toEqual(['api_call_started', 'api_call_failed'])
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.CC_HAHA_TRACE_API_CALLS
      else process.env.CC_HAHA_TRACE_API_CALLS = originalTraceEnv
    }
  })

  test('passes session id to local provider proxy without duplicating client-side trace', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.CC_HAHA_TRACE_API_CALLS
    let seenHeader: string | null = null
    process.env.CC_HAHA_TRACE_API_CALLS = '1'
    try {
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenHeader = new Headers(init?.headers).get('x-claude-code-session-id')
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      const traceFetch = createDumpPromptsFetch('agent-proxy', {
        traceSessionId: 'session-local-proxy',
        querySource: 'test_query',
      })
      await traceFetch('http://127.0.0.1:3456/proxy/providers/provider-1/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'proxy trace' }] }),
      })

      expect(seenHeader).toBe('session-local-proxy')
      const trace = await traceCaptureService.getSessionTrace('session-local-proxy')
      expect(trace.summary.apiCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.CC_HAHA_TRACE_API_CALLS
      else process.env.CC_HAHA_TRACE_API_CALLS = originalTraceEnv
    }
  })
})

describe('session trace API', () => {
  test('returns an empty trace when no calls were captured for the session', async () => {
    const req = new Request('http://localhost:3456/api/sessions/missing-session/trace')
    const url = new URL(req.url)

    const res = await handleApiRequest(req, url)
    const body = await res.json() as Awaited<ReturnType<typeof traceCaptureService.getSessionTrace>> & { session: unknown }

    expect(res.status).toBe(200)
    expect(body.sessionId).toBe('missing-session')
    expect(body.session).toBeNull()
    expect(body.summary.apiCalls).toBe(0)
    expect(body.calls).toEqual([])
    expect(body.events).toEqual([])
  })

  test('lists trace sessions with storage metadata and managed settings', async () => {
    await traceCaptureService.recordCall({
      sessionId: 'session-list-trace',
      source: 'proxy',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.015Z',
      durationMs: 15,
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        body: { model: 'gpt-5.5' },
      },
      response: {
        status: 200,
        body: { ok: true },
      },
    })

    const req = new Request('http://localhost:3456/api/traces')
    const res = await handleApiRequest(req, new URL(req.url))
    const body = await res.json() as {
      traces: Array<{ sessionId: string; summary: { apiCalls: number }; fileSize: number }>
      total: number
      storageDir: string
      settings: { enabled: boolean; storageDir: string }
    }

    expect(res.status).toBe(200)
    expect(body.total).toBe(1)
    expect(body.traces[0].sessionId).toBe('session-list-trace')
    expect(body.traces[0].summary.apiCalls).toBe(1)
    expect(body.traces[0].fileSize).toBeGreaterThan(0)
    expect(body.storageDir).toBe(path.join(tmpDir, 'cc-haha', 'traces'))
    expect(body.settings).toEqual({
      enabled: true,
      storageDir: path.join(tmpDir, 'cc-haha', 'traces'),
    })
  })

  test('searches trace sessions by session title and project path before paginating', async () => {
    await traceCaptureService.recordCall({
      sessionId: 'session-title-alpha',
      source: 'proxy',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.015Z',
      durationMs: 15,
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        body: { model: 'gpt-5.5' },
      },
      response: {
        status: 200,
        body: { ok: true },
      },
    })
    await traceCaptureService.recordCall({
      sessionId: 'session-title-beta',
      source: 'proxy',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:01.000Z',
      completedAt: '2026-06-09T08:00:01.015Z',
      durationMs: 15,
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        body: { model: 'gpt-5.5' },
      },
      response: {
        status: 200,
        body: { ok: true },
      },
    })

    const originalGetSession = sessionService.getSession
    sessionService.getSession = (async (sessionId: string) => {
      if (sessionId === 'session-title-alpha') {
        return {
          id: sessionId,
          title: 'Debug stuck checkout agent',
          createdAt: '2026-06-09T08:00:00.000Z',
          modifiedAt: '2026-06-09T08:00:00.015Z',
          messageCount: 2,
          projectPath: '/tmp/checkout',
          projectRoot: '/tmp/checkout',
          workDir: '/tmp/checkout',
          workDirExists: true,
          messages: [],
        }
      }
      if (sessionId === 'session-title-beta') {
        return {
          id: sessionId,
          title: 'Unrelated model run',
          createdAt: '2026-06-09T08:00:01.000Z',
          modifiedAt: '2026-06-09T08:00:01.015Z',
          messageCount: 2,
          projectPath: '/tmp/other',
          projectRoot: '/tmp/other',
          workDir: '/tmp/other',
          workDirExists: true,
          messages: [],
        }
      }
      return null
    }) as typeof sessionService.getSession

    try {
      const titleReq = new Request('http://localhost:3456/api/traces?q=stuck%20agent&limit=10&offset=0')
      const titleRes = await handleApiRequest(titleReq, new URL(titleReq.url))
      const titleBody = await titleRes.json() as {
        traces: Array<{ sessionId: string; session: { title: string; projectPath: string } | null }>
        total: number
      }

      expect(titleRes.status).toBe(200)
      expect(titleBody.total).toBe(1)
      expect(titleBody.traces.map((trace) => trace.sessionId)).toEqual(['session-title-alpha'])
      expect(titleBody.traces[0].session?.title).toBe('Debug stuck checkout agent')

      const pathReq = new Request('http://localhost:3456/api/traces?q=checkout&limit=10&offset=0')
      const pathRes = await handleApiRequest(pathReq, new URL(pathReq.url))
      const pathBody = await pathRes.json() as {
        traces: Array<{ sessionId: string; session: { projectPath: string } | null }>
        total: number
      }

      expect(pathRes.status).toBe(200)
      expect(pathBody.total).toBe(1)
      expect(pathBody.traces.map((trace) => trace.sessionId)).toEqual(['session-title-alpha'])
      expect(pathBody.traces[0].session?.projectPath).toBe('/tmp/checkout')

      const missReq = new Request('http://localhost:3456/api/traces?q=missing-title&limit=10&offset=0')
      const missRes = await handleApiRequest(missReq, new URL(missReq.url))
      const missBody = await missRes.json() as {
        traces: Array<{ sessionId: string }>
        total: number
      }

      expect(missRes.status).toBe(200)
      expect(missBody.total).toBe(0)
      expect(missBody.traces).toEqual([])
    } finally {
      sessionService.getSession = originalGetSession
    }
  })
})
