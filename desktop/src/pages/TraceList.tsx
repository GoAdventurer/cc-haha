import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, Search, Workflow } from 'lucide-react'
import { tracesApi } from '../api/traces'
import { SETTINGS_TAB_ID, useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import { useTranslation } from '../i18n'
import { Button } from '../components/shared/Button'
import { formatBytes } from '../lib/formatBytes'
import { getDesktopHost } from '../lib/desktopHost'
import type { TraceSessionList, TraceSessionListItem } from '../types/trace'

type TraceListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: TraceSessionList }

const POLL_MS = 5_000
const PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 250

export function TraceList() {
  const t = useTranslation()
  const [state, setState] = useState<TraceListState>({ status: 'loading' })
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const host = getDesktopHost()

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(queryInput.trim())
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [queryInput])

  const load = useCallback(async (options?: {
    append?: boolean
    limit?: number
    offset?: number
    silent?: boolean
  }) => {
    const append = options?.append === true
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? PAGE_SIZE
    try {
      if (append) {
        setIsLoadingMore(true)
      } else if (!options?.silent) {
        setState({ status: 'loading' })
      }
      const data = await tracesApi.list({ limit, offset, query })
      setState((previous) => {
        if (!append || previous.status !== 'ready') {
          return { status: 'ready', data }
        }
        return {
          status: 'ready',
          data: {
            ...data,
            traces: [...previous.data.traces, ...data.traces],
          },
        }
      })
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : t('trace.list.loadFailed'),
      })
    } finally {
      if (append) setIsLoadingMore(false)
    }
  }, [query, t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (state.status !== 'ready' || !state.data.settings.enabled) return
    const timer = window.setInterval(() => {
      void load({
        limit: Math.max(PAGE_SIZE, state.data.traces.length),
        silent: true,
      })
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [load, state])

  const summary = useMemo(() => {
    if (state.status !== 'ready') return { apiCalls: 0, failedCalls: 0, models: 0 }
    const modelNames = new Set<string>()
    let apiCalls = 0
    let failedCalls = 0
    for (const item of state.data.traces) {
      apiCalls += item.summary.apiCalls
      failedCalls += item.summary.failedCalls
      for (const model of item.summary.models) modelNames.add(model.model)
    }
    return { apiCalls, failedCalls, models: modelNames.size }
  }, [state])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]">
      <header className="shrink-0 border-b border-[var(--color-border)] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase text-[var(--color-text-tertiary)]">
              <Workflow className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
              <span>{t('trace.list.eyebrow')}</span>
              {state.status === 'ready' && (
                <span className={`rounded-md border px-1.5 py-0.5 ${
                  state.data.settings.enabled
                    ? 'border-[var(--color-success)]/25 bg-[var(--color-success)]/10 text-[var(--color-success)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-[var(--color-text-tertiary)]'
                }`}>
                  {state.data.settings.enabled ? t('trace.list.collecting') : t('trace.list.paused')}
                </span>
              )}
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--color-text-primary)]">{t('trace.list.title')}</h1>
            {state.status === 'ready' && (
              <p className="mt-1 truncate text-xs text-[var(--color-text-tertiary)]">
                {state.data.storageDir}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => openTraceSettings(t)}>
              {t('trace.list.settings')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              {t('trace.refresh')}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-4 gap-3">
          <Metric label={t('trace.list.sessions')} value={state.status === 'ready' ? String(state.data.total) : '-'} />
          <Metric label={t('trace.apiCalls')} value={String(summary.apiCalls)} />
          <Metric label={t('trace.failedCalls')} value={String(summary.failedCalls)} tone={summary.failedCalls > 0 ? 'danger' : 'default'} />
          <Metric label={t('trace.models')} value={String(summary.models)} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-[var(--color-border)] px-5 py-3">
          <div className="flex h-10 max-w-xl items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 focus-within:border-[var(--color-border-focus)]">
            <Search className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" strokeWidth={1.8} aria-hidden="true" />
            <input
              value={queryInput}
              onChange={(event) => setQueryInput(event.currentTarget.value)}
              placeholder={t('trace.list.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent px-2 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
            />
          </div>
        </div>

        {state.status === 'loading' && (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-tertiary)]">{t('common.loading')}</div>
        )}
        {state.status === 'error' && (
          <div className="m-5 rounded-[var(--radius-md)] border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">
            {state.message}
          </div>
        )}
        {state.status === 'ready' && (
          <TraceRows
            traces={state.data.traces}
            total={state.data.total}
            loadingMore={isLoadingMore}
            onLoadMore={() => void load({
              append: true,
              offset: state.data.traces.length,
              silent: true,
            })}
            onOpenWindow={(sessionId) => {
              if (host.trace) void host.trace.openWindow(sessionId)
            }}
          />
        )}
      </div>
    </div>
  )
}

function TraceRows({
  loadingMore,
  onLoadMore,
  traces,
  total,
  onOpenWindow,
}: {
  loadingMore: boolean
  onLoadMore: () => void
  traces: TraceSessionListItem[]
  total: number
  onOpenWindow: (sessionId: string) => void
}) {
  const t = useTranslation()

  if (traces.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <div className="max-w-sm">
          <Workflow className="mx-auto h-8 w-8 text-[var(--color-text-tertiary)]" strokeWidth={1.5} aria-hidden="true" />
          <h2 className="mt-3 text-sm font-semibold text-[var(--color-text-primary)]">{t('trace.list.emptyTitle')}</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">{t('trace.list.emptyBody')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid grid-cols-[minmax(260px,1.5fr)_120px_90px_120px_minmax(160px,1fr)_96px] border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-5 py-2 text-[10px] font-semibold uppercase text-[var(--color-text-tertiary)]">
        <div>{t('trace.list.session')}</div>
        <div>{t('trace.apiCalls')}</div>
        <div>{t('trace.failedCalls')}</div>
        <div>{t('trace.duration')}</div>
        <div>{t('trace.models')}</div>
        <div className="text-right">{t('trace.list.actions')}</div>
      </div>
      {traces.map((trace) => (
        <TraceRow key={trace.sessionId} trace={trace} onOpenWindow={onOpenWindow} />
      ))}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3 text-xs text-[var(--color-text-tertiary)]">
        <span>{t('trace.list.loadedCount', { shown: traces.length, total })}</span>
        {traces.length < total && (
          <Button size="sm" variant="secondary" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? t('common.loading') : t('trace.list.loadMore')}
          </Button>
        )}
      </div>
    </div>
  )
}

function TraceRow({
  trace,
  onOpenWindow,
}: {
  trace: TraceSessionListItem
  onOpenWindow: (sessionId: string) => void
}) {
  const t = useTranslation()
  const title = trace.session?.title || t('session.untitled')
  const modelLabel = trace.summary.models.map((model) => `${model.model} x${model.calls}`).join(', ') || t('trace.noModel')
  const updatedAt = trace.summary.updatedAt ?? trace.fileUpdatedAt
  const hasError = trace.summary.failedCalls > 0

  return (
    <div className="grid grid-cols-[minmax(260px,1.5fr)_120px_90px_120px_minmax(160px,1fr)_96px] items-center gap-0 border-b border-[var(--color-border)] px-5 py-3 text-sm hover:bg-[var(--color-surface-hover)]">
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => openTrace(trace.sessionId, title, t)}
          className="block min-w-0 text-left"
        >
          <div className="flex min-w-0 items-center gap-2">
            {hasError
              ? <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-error)]" strokeWidth={1.8} aria-hidden="true" />
              : <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--color-success)]" strokeWidth={1.8} aria-hidden="true" />}
            <span className="truncate font-medium text-[var(--color-text-primary)]">{title}</span>
          </div>
          <div className="mt-1 flex min-w-0 gap-2 text-xs text-[var(--color-text-tertiary)]">
            <span className="truncate font-mono">{trace.sessionId}</span>
            <span className="shrink-0">{formatUpdatedAt(updatedAt)}</span>
          </div>
          {trace.session?.projectPath && (
            <div className="mt-1 truncate text-[11px] text-[var(--color-text-tertiary)]">{trace.session.projectPath}</div>
          )}
        </button>
      </div>
      <div className="font-mono text-[var(--color-text-primary)]">{trace.summary.apiCalls}</div>
      <div className={hasError ? 'font-mono text-[var(--color-error)]' : 'font-mono text-[var(--color-text-primary)]'}>{trace.summary.failedCalls}</div>
      <div className="font-mono text-[var(--color-text-secondary)]">{formatDuration(trace.summary.totalDurationMs)}</div>
      <div className="min-w-0 truncate text-xs text-[var(--color-text-secondary)]" title={modelLabel}>{modelLabel}</div>
      <div className="flex justify-end gap-1">
        <button
          type="button"
          onClick={() => openTrace(trace.sessionId, title, t)}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)]"
          aria-label={t('trace.open')}
          title={t('trace.open')}
        >
          <Workflow className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onOpenWindow(trace.sessionId)}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)]"
          aria-label={t('trace.openWindow')}
          title={t('trace.openWindow')}
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="col-span-6 mt-2 hidden text-[11px] text-[var(--color-text-tertiary)] md:block">
        {t('trace.list.fileSize')}: {formatBytes(trace.fileSize)}
      </div>
    </div>
  )
}

function Metric({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'danger' }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-1 truncate font-mono text-lg ${tone === 'danger' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-primary)]'}`}>{value}</div>
    </div>
  )
}

function openTrace(sessionId: string, title: string, t: ReturnType<typeof useTranslation>) {
  useTabStore.getState().openTraceTab(sessionId, `${t('trace.title')}: ${title}`)
}

function openTraceSettings(t: ReturnType<typeof useTranslation>) {
  useUIStore.getState().setPendingSettingsTab('general')
  useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}
