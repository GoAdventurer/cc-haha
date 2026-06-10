import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TraceSession } from './TraceSession'
import { sessionsApi } from '../api/sessions'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { TraceSession as TraceSessionData } from '../types/trace'

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    getTrace: vi.fn(),
    getMessages: vi.fn(),
  },
}))

const baseTrace: TraceSessionData = {
  sessionId: 'session-live',
  session: {
    id: 'session-live',
    title: 'Trace API title',
    projectPath: '/tmp',
    workDir: '/tmp',
  },
  summary: {
    apiCalls: 1,
    failedCalls: 0,
    totalDurationMs: 1200,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    models: [{ model: 'gpt-5.5', calls: 1 }],
    updatedAt: '2026-06-09T10:10:00.000Z',
  },
  calls: [{
    id: 'call-1',
    sessionId: 'session-live',
    source: 'anthropic' as const,
    provider: { id: 'provider-sub2api', name: 'Sub2API-ChatGPT', format: 'anthropic' },
    model: 'gpt-5.5',
    startedAt: '2026-06-09T10:09:59.000Z',
    completedAt: '2026-06-09T10:10:00.000Z',
    durationMs: 1200,
    request: {
      method: 'POST',
      url: 'https://sub2api.example/v1/messages',
      headers: { authorization: '[redacted]' },
      body: {
        contentType: 'json' as const,
        bytes: 26,
        sha256: 'a'.repeat(64),
        preview: '{"model":"gpt-5.5"}',
        truncated: false,
      },
    },
    response: {
      status: 200,
      headers: {},
      body: {
        contentType: 'json' as const,
        bytes: 11,
        sha256: 'b'.repeat(64),
        preview: '{"ok":true}',
        truncated: false,
      },
    },
  }],
}

describe('TraceSession', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    vi.mocked(sessionsApi.getMessages).mockResolvedValue({ messages: [] })
    useSessionStore.setState({
      sessions: [{
        id: 'session-live',
        title: 'Live probe',
        createdAt: '2026-06-09T10:00:00.000Z',
        modifiedAt: '2026-06-09T10:10:00.000Z',
        messageCount: 0,
        projectPath: '/tmp',
        workDir: '/tmp',
        workDirExists: true,
      }],
      activeSessionId: 'session-live',
      isLoading: false,
      error: null,
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
    useSettingsStore.setState({ locale: 'en' })
  })

  it('refreshes the trace snapshot while the page is open', async () => {
    vi.mocked(sessionsApi.getTrace)
      .mockResolvedValueOnce(baseTrace)
      .mockResolvedValueOnce({
        ...baseTrace,
        summary: {
          ...baseTrace.summary,
          apiCalls: 2,
          models: [{ model: 'gpt-5.5', calls: 2 }],
        },
        calls: [
          ...baseTrace.calls,
          { ...baseTrace.calls[0]!, id: 'call-2', durationMs: 900 },
        ],
      })

    render(<TraceSession sessionId="session-live" pollIntervalMs={20} />)

    await screen.findByText('gpt-5.5 x1')
    expect(sessionsApi.getTrace).toHaveBeenCalledWith('session-live')

    await waitFor(() => expect(screen.getByText('gpt-5.5 x2')).toBeInTheDocument())
    expect(vi.mocked(sessionsApi.getTrace).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('uses trace session metadata when the sidebar store has not loaded the session', async () => {
    useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
    vi.mocked(sessionsApi.getTrace).mockResolvedValue(baseTrace)

    render(<TraceSession sessionId="session-live" standalone pollIntervalMs={60_000} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Trace API title' })).toBeInTheDocument()
  })

  it('renders lifecycle events as trace spans', async () => {
    vi.mocked(sessionsApi.getTrace).mockResolvedValue({
      ...baseTrace,
      events: [{
        id: 'event-failed',
        sessionId: 'session-live',
        callId: 'call-1',
        source: 'anthropic',
        timestamp: '2026-06-09T10:10:00.100Z',
        phase: 'api_call_failed',
        severity: 'error',
        message: 'network down',
      }],
    })

    render(<TraceSession sessionId="session-live" pollIntervalMs={60_000} />)

    expect((await screen.findAllByText('API call failed')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('network down').length).toBeGreaterThan(0)
    expect(screen.getByText('Trace event failed')).toBeInTheDocument()
  })

  it('renders trace navigation and inspector labels in the active locale', async () => {
    useSettingsStore.setState({ locale: 'zh' })
    vi.mocked(sessionsApi.getTrace).mockResolvedValue(baseTrace)

    render(<TraceSession sessionId="session-live" pollIntervalMs={60_000} />)

    expect(await screen.findByText('运行树')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('搜索 Span')).toBeInTheDocument()
    expect(screen.getByText('对话线程')).toBeInTheDocument()
    expect(screen.getByText('诊断')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '输入' })).toBeInTheDocument()
    expect(screen.queryByText('Run tree')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Search spans')).not.toBeInTheDocument()
    expect(screen.queryByText('Thread')).not.toBeInTheDocument()
    expect(screen.queryByText('Session activity')).not.toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: /gpt-5\.5/ })[0]!)
    fireEvent.click(screen.getByRole('tab', { name: '输入' }))
    expect(screen.getByText('请求正文')).toBeInTheDocument()
    expect(screen.getByText('请求头')).toBeInTheDocument()
  })
})
