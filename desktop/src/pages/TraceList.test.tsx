import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TraceList } from './TraceList'
import { tracesApi } from '../api/traces'
import { SETTINGS_TAB_ID, useTabStore } from '../stores/tabStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { TraceSessionList } from '../types/trace'

vi.mock('../api/traces', () => ({
  tracesApi: {
    list: vi.fn(),
  },
}))

const traceList: TraceSessionList = {
  total: 1,
  storageDir: '/tmp/cc-haha/traces',
  settings: {
    enabled: true,
    storageDir: '/tmp/cc-haha/traces',
  },
  traces: [{
    sessionId: 'session-trace-list',
    session: {
      id: 'session-trace-list',
      title: 'Debug stuck agent',
      projectPath: '/tmp/project',
      workDir: '/tmp/project',
    },
    summary: {
      apiCalls: 3,
      failedCalls: 1,
      totalDurationMs: 4715,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      models: [{ model: 'gpt-5.5', calls: 2 }],
      updatedAt: '2026-06-09T15:03:40.010Z',
    },
    fileSize: 2048,
    fileUpdatedAt: '2026-06-09T15:03:40.010Z',
  }],
}

const secondTraceList: TraceSessionList = {
  ...traceList,
  traces: [{
    ...traceList.traces[0]!,
    sessionId: 'session-trace-second-page',
    session: {
      id: 'session-trace-second-page',
      title: 'Second trace session',
      projectPath: '/tmp/second-project',
      workDir: '/tmp/second-project',
    },
    summary: {
      ...traceList.traces[0]!.summary,
      apiCalls: 1,
      failedCalls: 0,
      models: [{ model: 'gpt-5.5', calls: 1 }],
    },
  }],
}

describe('TraceList', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({ tabs: [], activeTabId: null })
    vi.mocked(tracesApi.list).mockResolvedValue(traceList)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    useTabStore.setState({ tabs: [], activeTabId: null })
    useSettingsStore.setState({ locale: 'en' })
  })

  it('renders trace session rows and opens a session trace tab', async () => {
    render(<TraceList />)

    expect(await screen.findByText('Debug stuck agent')).toBeInTheDocument()
    expect(screen.getByText('/tmp/cc-haha/traces')).toBeInTheDocument()
    expect(screen.getByText('gpt-5.5 x2')).toBeInTheDocument()
    expect(tracesApi.list).toHaveBeenCalledWith({ limit: 50, offset: 0, query: '' })

    fireEvent.click(screen.getAllByRole('button', { name: 'Trace' })[0]!)

    expect(useTabStore.getState().activeTabId).toBe('__trace__session-trace-list')
    expect(useTabStore.getState().tabs.find((tab) => tab.type === 'trace')?.traceSessionId).toBe('session-trace-list')
  })

  it('opens General settings from the trace settings button', async () => {
    render(<TraceList />)

    fireEvent.click(await screen.findByRole('button', { name: 'Trace settings' }))

    expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
    expect(useTabStore.getState().tabs.find((tab) => tab.sessionId === SETTINGS_TAB_ID)?.type).toBe('settings')
  })

  it('loads additional trace pages instead of fetching all rows at once', async () => {
    vi.mocked(tracesApi.list)
      .mockResolvedValueOnce({ ...traceList, total: 2 })
      .mockResolvedValueOnce({ ...secondTraceList, total: 2 })

    render(<TraceList />)

    expect(await screen.findByText('Debug stuck agent')).toBeInTheDocument()
    expect(screen.getByText('Showing 1 of 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByText('Second trace session')).toBeInTheDocument()
    expect(screen.getByText('Showing 2 of 2')).toBeInTheDocument()
    expect(tracesApi.list).toHaveBeenNthCalledWith(1, { limit: 50, offset: 0, query: '' })
    expect(tracesApi.list).toHaveBeenNthCalledWith(2, { limit: 50, offset: 1, query: '' })
  })

  it('sends title search text to the trace list API', async () => {
    render(<TraceList />)

    await screen.findByText('Debug stuck agent')
    fireEvent.change(screen.getByPlaceholderText('Search title, session ID, or project path'), {
      target: { value: 'stuck agent' },
    })

    await waitFor(() => {
      expect(tracesApi.list).toHaveBeenLastCalledWith({ limit: 50, offset: 0, query: 'stuck agent' })
    })
  })
})
