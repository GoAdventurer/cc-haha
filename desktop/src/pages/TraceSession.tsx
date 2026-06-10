import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Copy,
  Database,
  ExternalLink,
  FileJson2,
  GitBranch,
  MessageSquareText,
  RadioTower,
  RefreshCw,
  Search,
  Server,
  Wrench,
} from 'lucide-react'
import { sessionsApi } from '../api/sessions'
import { useSessionStore } from '../stores/sessionStore'
import { useTranslation } from '../i18n'
import type { MessageEntry } from '../types/session'
import type { TraceBodySnapshot, TraceSession as TraceSessionData } from '../types/trace'
import { getDesktopHost } from '../lib/desktopHost'
import { buildTraceWindowUrl } from '../lib/traceLaunch'
import { formatBytes as formatBytesValue } from '../lib/formatBytes'
import { CodeViewer } from '../components/chat/CodeViewer'
import { MarkdownRenderer } from '../components/markdown/MarkdownRenderer'
import { CopyButton } from '../components/shared/CopyButton'
import {
  buildTraceViewModel,
  extractTextContent,
  formatTraceJson,
  getTraceValueLanguage,
  previewTraceValue,
  type TraceSpan,
  type TraceSpanKind,
  type TraceSpanStatus,
  type TraceTurn,
  type TraceViewModel,
} from '../lib/traceViewModel'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; trace: TraceSessionData; messages: MessageEntry[] }

type SpanFilter = 'all' | 'llm' | 'tool' | 'error'
type InspectorTab = 'overview' | 'input' | 'output' | 'metadata' | 'raw'
type RawScope = 'span' | 'full'
type TraceTranslator = ReturnType<typeof useTranslation>

const TRACE_POLL_INTERVAL_MS = 1500
const MESSAGE_PREVIEW_CHARS = 5000

export function TraceSession({
  sessionId,
  standalone = false,
  pollIntervalMs = TRACE_POLL_INTERVAL_MS,
}: {
  sessionId: string
  standalone?: boolean
  pollIntervalMs?: number
}) {
  const t = useTranslation()
  const sessionTitle = useSessionStore((s) => s.sessions.find((session) => session.id === sessionId)?.title)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('overview')
  const [rawScope, setRawScope] = useState<RawScope>('span')
  const [filter, setFilter] = useState<SpanFilter>('all')
  const [query, setQuery] = useState('')
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let cancelled = false

    const load = async (silent: boolean) => {
      if (!silent) setState({ status: 'loading' })
      if (silent) setRefreshing(true)
      try {
        const trace = await sessionsApi.getTrace(sessionId)
        if (!isTraceSessionData(trace)) {
          throw new Error(t('trace.snapshotEmpty'))
        }
        const messageResponse = await sessionsApi.getMessages(sessionId).catch(() => ({ messages: [] }))
        if (cancelled) return
        setState({ status: 'ready', trace, messages: messageResponse.messages })
        setLastLoadedAt(new Date().toISOString())
      } catch (error) {
        if (cancelled) return
        if (!silent) {
          setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      } finally {
        if (!cancelled) setRefreshing(false)
      }
    }

    setSelectedId(null)
    setInspectorTab('overview')
    void load(false)
    const interval = window.setInterval(() => {
      void load(true)
    }, pollIntervalMs)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [sessionId, refreshNonce, pollIntervalMs, t])

  const refresh = () => setRefreshNonce((value) => value + 1)

  const openWindow = () => {
    const host = getDesktopHost()
    if (host.trace) {
      void host.trace.openWindow(sessionId)
      return
    }
    window.open(buildTraceWindowUrl(sessionId), '_blank', 'noopener,noreferrer')
  }

  const readyState = state.status === 'ready' ? state : null
  const viewModel = useMemo(
    () => readyState ? buildTraceViewModel(readyState.trace, readyState.messages) : null,
    [readyState],
  )
  const selected = selectedId && viewModel ? viewModel.spansById.get(selectedId) : null
  const activeSpan = viewModel
    ? selected ?? viewModel.spansById.get(viewModel.rootId) ?? viewModel.spans[0] ?? null
    : null
  const visibleSpanIds = useMemo(
    () => viewModel ? filterSpanIds(viewModel, filter, query) : new Set<string>(),
    [filter, query, viewModel],
  )

  useEffect(() => {
    if (!viewModel) return
    if (!activeSpan && viewModel.rootId) {
      setSelectedId(viewModel.rootId)
      return
    }
    if (selectedId && viewModel.spansById.has(selectedId)) return
    const diagnosisFocus = viewModel.diagnosis.focusSpanId
      ? viewModel.spansById.get(viewModel.diagnosis.focusSpanId)
      : undefined
    const firstError = viewModel.spans.find((span) => span.status === 'error')
    const firstUseful = diagnosisFocus ?? firstError ?? viewModel.spans.find((span) => span.kind === 'llm') ?? viewModel.spansById.get(viewModel.rootId)
    if (firstUseful) setSelectedId(firstUseful.id)
  }, [activeSpan, selectedId, viewModel])

  if (state.status === 'loading') {
    return (
      <TraceLoading
        sessionId={sessionId}
        title={sessionTitle ?? t('session.untitled')}
        standalone={standalone}
      />
    )
  }

  if (state.status === 'error') {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]">
        <TraceHeader
          sessionId={sessionId}
          title={sessionTitle ?? t('session.untitled')}
          standalone={standalone}
          onOpenWindow={openWindow}
          onRefresh={refresh}
          refreshing={refreshing}
          updatedAt={lastLoadedAt}
        />
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md border-t border-[var(--color-error)]/30 pt-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-error)]">
              <AlertTriangle size={16} strokeWidth={2} />
              {t('trace.loadFailed')}
            </div>
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">{state.message}</p>
            <button
              type="button"
              onClick={refresh}
              className="mt-4 inline-flex items-center gap-2 rounded-[8px] border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-primary)] transition-transform active:scale-[0.98]"
            >
              <RefreshCw size={14} strokeWidth={2} />
              {t('common.retry')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const { trace, messages } = state
  const resolvedTitle = sessionTitle ?? trace.session?.title ?? t('session.untitled')
  if (!viewModel) {
    return <TraceEmpty />
  }

  const hasTraceContent = viewModel.spans.length > 1 || trace.calls.length > 0 || messages.length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)] text-[var(--color-text-primary)]">
      <TraceHeader
        sessionId={sessionId}
        title={resolvedTitle}
        trace={trace}
        standalone={standalone}
        onOpenWindow={openWindow}
        onRefresh={refresh}
        refreshing={refreshing}
        updatedAt={lastLoadedAt}
      />
      <TraceDiagnosisBar
        viewModel={viewModel}
        onSelect={(spanId) => {
          setSelectedId(spanId)
          setInspectorTab('overview')
        }}
      />
      {hasTraceContent && activeSpan ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 border-t border-[var(--color-border)] xl:grid-cols-[300px_minmax(420px,1fr)_minmax(360px,0.85fr)]">
          <TraceRunTree
            viewModel={viewModel}
            visibleSpanIds={visibleSpanIds}
            selectedId={activeSpan.id}
            filter={filter}
            query={query}
            onFilterChange={setFilter}
            onQueryChange={setQuery}
            onSelect={(spanId) => {
              setSelectedId(spanId)
              setInspectorTab('overview')
            }}
          />
          <TraceThread
            turns={viewModel.turns}
            viewModel={viewModel}
            selectedId={activeSpan.id}
            onSelect={(spanId) => {
              setSelectedId(spanId)
              setInspectorTab('overview')
            }}
          />
          <TraceInspector
            span={activeSpan}
            viewModel={viewModel}
            activeTab={inspectorTab}
            rawScope={rawScope}
            onTabChange={setInspectorTab}
            onRawScopeChange={setRawScope}
          />
        </div>
      ) : (
        <TraceEmpty />
      )}
    </div>
  )
}

function TraceHeader({
  sessionId,
  title,
  trace,
  standalone,
  onOpenWindow,
  onRefresh,
  refreshing = false,
  updatedAt,
}: {
  sessionId: string
  title: string
  trace?: TraceSessionData
  standalone?: boolean
  onOpenWindow?: () => void
  onRefresh?: () => void
  refreshing?: boolean
  updatedAt?: string | null
}) {
  const t = useTranslation()
  const summary = trace?.summary
  const modelLabel = summary?.models.map((model) => `${model.model} x${model.calls}`).join(', ') || t('trace.noModel')

  return (
    <header className="shrink-0 px-5 py-4" data-testid="trace-header">
      <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-end 2xl:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
            <RadioTower size={14} strokeWidth={2} className="shrink-0" />
            <span>{t('trace.title')}</span>
            <span className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--color-success)]/25 px-1.5 py-0.5 text-[10px] text-[var(--color-success)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)] animate-pulse-dot" />
              {t('trace.live')}
            </span>
            <span className="rounded-[6px] border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-[var(--color-text-secondary)]">
              {t('trace.sessionTrace')}
            </span>
          </div>
          <h1 className="mt-1 truncate text-xl font-bold tracking-tight text-[var(--color-text-primary)]">
            {title}
          </h1>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 font-mono text-[10px] text-[var(--color-text-tertiary)]">
            <span className="max-w-full truncate">{sessionId}</span>
            {updatedAt ? <span>{t('trace.updatedAt')}: {formatTime(updatedAt)}</span> : null}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-end">
          {summary ? (
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs md:grid-cols-5">
              <Metric label={t('trace.apiCalls')} value={String(summary.apiCalls)} />
              <Metric label={t('trace.failedCalls')} value={String(summary.failedCalls)} tone={summary.failedCalls > 0 ? 'danger' : 'default'} />
              <Metric label={t('trace.duration')} value={formatDuration(summary.totalDurationMs)} />
              <Metric label={t('trace.tokens')} value={`${summary.totalInputTokens + summary.totalOutputTokens}`} />
              <Metric label={t('trace.models')} value={modelLabel} wide />
            </div>
          ) : null}
          <div className="flex shrink-0 items-center gap-1.5">
            <CopyButton
              text={sessionId}
              label={t('trace.copySessionId')}
              copiedLabel={t('common.copied')}
              displayLabel={<Copy size={14} strokeWidth={2} />}
              displayCopiedLabel={<CheckCircle2 size={14} strokeWidth={2} />}
              className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-[var(--color-border)] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-focus)] hover:text-[var(--color-text-primary)] active:scale-[0.98]"
            />
            <IconAction label={t('trace.refresh')} onClick={onRefresh}>
              <RefreshCw size={14} strokeWidth={2} className={refreshing ? 'animate-spin' : ''} />
            </IconAction>
            {!standalone ? (
              <IconAction label={t('trace.openWindow')} onClick={onOpenWindow}>
                <ExternalLink size={14} strokeWidth={2} />
              </IconAction>
            ) : null}
          </div>
        </div>
      </div>
    </header>
  )
}

function isTraceSessionData(value: unknown): value is TraceSessionData {
  return !!value &&
    typeof value === 'object' &&
    'sessionId' in value &&
    'summary' in value &&
    Array.isArray((value as { calls?: unknown }).calls)
}

function TraceDiagnosisBar({
  viewModel,
  onSelect,
}: {
  viewModel: TraceViewModel
  onSelect: (spanId: string) => void
}) {
  const t = useTranslation()
  const diagnosis = viewModel.diagnosis
  const focusSpan = diagnosis.focusSpanId ? viewModel.spansById.get(diagnosis.focusSpanId) : undefined
  const evidenceSpans = diagnosis.evidenceSpanIds
    .map((spanId) => viewModel.spansById.get(spanId))
    .filter((span): span is TraceSpan => !!span)
    .slice(0, 4)
  const toneClass = diagnosis.status === 'blocked'
    ? 'border-[var(--color-error)]/30 bg-[var(--color-error-container)]/30'
    : diagnosis.status === 'attention'
      ? 'border-[var(--color-warning)]/30 bg-[var(--color-warning-container)]/25'
      : 'border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]'

  return (
    <section className={`shrink-0 border-t px-5 py-3 ${toneClass}`}>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              <AlertTriangle size={13} strokeWidth={2} />
              {t('trace.diagnosis')}
            </span>
            <StatusPill status={diagnosisStatusToSpanStatus(diagnosis.status)} />
            <span className="text-sm font-semibold text-[var(--color-text-primary)]">
              {diagnosisReasonLabel(diagnosis.reason, t)}
            </span>
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap gap-1.5 text-[11px] text-[var(--color-text-secondary)]">
            <DiagnosisChip label={t('trace.lastActivity')} value={formatTime(diagnosis.lastActivityAt)} />
            <DiagnosisChip label={t('trace.errors')} value={String(diagnosis.errorCount)} tone={diagnosis.errorCount > 0 ? 'danger' : 'default'} />
            <DiagnosisChip label={t('trace.pendingModels')} value={String(diagnosis.pendingModelCalls)} tone={diagnosis.pendingModelCalls > 0 ? 'danger' : 'default'} />
            <DiagnosisChip label={t('trace.pendingTools')} value={String(diagnosis.pendingToolCalls)} tone={diagnosis.pendingToolCalls > 0 ? 'danger' : 'default'} />
            {focusSpan ? (
              <button
                type="button"
                onClick={() => onSelect(focusSpan.id)}
                className="min-w-0 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-left transition-colors hover:border-[var(--color-border-focus)] hover:text-[var(--color-text-primary)] active:scale-[0.98]"
              >
                <span className="text-[var(--color-text-tertiary)]">{t('trace.focus')}: </span>
                <span className="font-semibold">{spanTitle(focusSpan, t)}</span>
              </button>
            ) : null}
          </div>
        </div>
        {evidenceSpans.length > 0 ? (
          <div className="flex min-w-0 flex-wrap justify-start gap-1.5 lg:justify-end">
            {evidenceSpans.map((span) => (
              <button
                key={span.id}
                type="button"
                onClick={() => onSelect(span.id)}
                className="inline-flex max-w-[220px] items-center gap-1.5 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-focus)] hover:text-[var(--color-text-primary)] active:scale-[0.98]"
              >
                <SpanIcon span={span} />
                <span className="truncate">{spanTitle(span, t)}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function DiagnosisChip({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'danger'
}) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-[6px] border px-2 py-1 font-mono ${
      tone === 'danger'
        ? 'border-[var(--color-error)]/25 bg-[var(--color-error)]/10 text-[var(--color-error)]'
        : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)]'
    }`}>
      <span className="font-sans text-[var(--color-text-tertiary)]">{label}</span>
      {value}
    </span>
  )
}

function diagnosisStatusToSpanStatus(status: TraceViewModel['diagnosis']['status']): TraceSpanStatus {
  if (status === 'blocked') return 'error'
  if (status === 'attention') return 'pending'
  return 'ok'
}

function TraceRunTree({
  viewModel,
  visibleSpanIds,
  selectedId,
  filter,
  query,
  onFilterChange,
  onQueryChange,
  onSelect,
}: {
  viewModel: TraceViewModel
  visibleSpanIds: Set<string>
  selectedId: string
  filter: SpanFilter
  query: string
  onFilterChange: (filter: SpanFilter) => void
  onQueryChange: (query: string) => void
  onSelect: (spanId: string) => void
}) {
  const t = useTranslation()
  const rows = viewModel.orderedSpanIds
    .map((id) => viewModel.spansById.get(id))
    .filter((span): span is TraceSpan => !!span && visibleSpanIds.has(span.id))
  const depthById = useMemo(() => computeDepths(viewModel), [viewModel])

  return (
    <aside className="min-h-0 overflow-hidden border-b border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] xl:border-b-0 xl:border-r">
      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
          <GitBranch size={14} strokeWidth={2} />
          {t('trace.runTree')}
        </div>
        <label className="mt-3 flex h-8 items-center gap-2 rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text-tertiary)]">
          <Search size={13} strokeWidth={2} />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t('trace.searchSpans')}
            className="min-w-0 flex-1 bg-transparent text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />
        </label>
        <div className="mt-2 flex flex-wrap gap-1">
          {(['all', 'llm', 'tool', 'error'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onFilterChange(value)}
              className={`rounded-[6px] px-2 py-1 text-[10px] font-semibold transition-colors ${
                filter === value
                  ? 'bg-[var(--color-primary-container)] text-[var(--color-on-primary-container)]'
                  : 'border border-[var(--color-border)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              {filterLabel(value, t)}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto py-2">
        {rows.length > 0 ? (
          rows.map((span) => (
            <TreeSpanRow
              key={span.id}
              span={span}
              depth={depthById.get(span.id) ?? 0}
              selected={span.id === selectedId}
              onSelect={() => onSelect(span.id)}
            />
          ))
        ) : (
          <div className="px-4 py-8 text-center text-xs text-[var(--color-text-tertiary)]">
            {t('trace.noMatchingSpans')}
          </div>
        )}
      </div>
    </aside>
  )
}

function TreeSpanRow({
  span,
  depth,
  selected,
  onSelect,
}: {
  span: TraceSpan
  depth: number
  selected: boolean
  onSelect: () => void
}) {
  const t = useTranslation()
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 text-left transition-colors active:scale-[0.995] ${
        selected
          ? 'bg-[var(--color-surface-container-high)] text-[var(--color-text-primary)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-container-low)] hover:text-[var(--color-text-primary)]'
      }`}
      style={{ paddingLeft: `${12 + depth * 14}px` }}
    >
      <SpanIcon span={span} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs font-semibold">{spanTitle(span, t)}</span>
          {span.isSidechain ? (
            <span className="rounded-[5px] border border-[var(--color-border)] px-1 text-[9px] text-[var(--color-text-tertiary)]">{t('trace.sidechain')}</span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-text-tertiary)]">
          {spanSubtitle(span, t)}
        </div>
      </div>
      <StatusGlyph status={span.status} />
    </button>
  )
}

function TraceThread({
  turns,
  viewModel,
  selectedId,
  onSelect,
}: {
  turns: TraceTurn[]
  viewModel: TraceViewModel
  selectedId: string
  onSelect: (spanId: string) => void
}) {
  const t = useTranslation()
  return (
    <main className="min-h-0 overflow-hidden border-b border-[var(--color-border)] xl:border-b-0 xl:border-r">
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-[var(--color-border)] px-5 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                <MessageSquareText size={14} strokeWidth={2} />
                {t('trace.thread')}
              </div>
              <div className="mt-1 text-xs text-[var(--color-text-secondary)]">
                {t('trace.threadStats', { turns: turns.length, spans: viewModel.spans.length })}
              </div>
            </div>
            <div className="hidden items-center gap-2 text-[11px] text-[var(--color-text-tertiary)] md:flex">
              <span>{t('trace.turnCount', { count: turns.length })}</span>
              <span>{t('trace.spanCount', { count: viewModel.spans.length })}</span>
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
            {turns.map((turn) => (
              <TraceTurnBlock
                key={turn.id}
                turn={turn}
                viewModel={viewModel}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}

function TraceTurnBlock({
  turn,
  viewModel,
  selectedId,
  onSelect,
}: {
  turn: TraceTurn
  viewModel: TraceViewModel
  selectedId: string
  onSelect: (spanId: string) => void
}) {
  const t = useTranslation()
  const displaySpans = turn.spanIds
    .map((spanId) => viewModel.spansById.get(spanId))
    .filter((span): span is TraceSpan => !!span && (span.parentId === turn.id || span.kind === 'message' || span.kind === 'llm' || span.kind === 'event'))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  const stats = summarizeTurn(displaySpans)

  return (
    <section className="border-l border-[var(--color-border)] pl-4">
      <button
        type="button"
        onClick={() => onSelect(turn.id)}
        className={`mb-3 flex w-full items-start justify-between gap-3 text-left transition-colors ${
          selectedId === turn.id ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
        }`}
      >
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            {t('trace.turnLabel', { index: turn.index + 1 })}
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm font-semibold">{turnTitle(turn, t)}</div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <MiniStat value={stats.llm} label={t('trace.stat.llm')} />
          <MiniStat value={stats.tools} label={t('trace.stat.tools')} />
          <MiniStat value={stats.errors} label={t('trace.stat.errors')} tone={stats.errors > 0 ? 'danger' : 'default'} />
        </div>
      </button>
      <div className="flex flex-col gap-2.5">
        {displaySpans.map((span) => (
          <ThreadSpanCard
            key={span.id}
            span={span}
            viewModel={viewModel}
            selected={span.id === selectedId}
            onSelect={() => onSelect(span.id)}
          />
        ))}
      </div>
    </section>
  )
}

function ThreadSpanCard({
  span,
  viewModel,
  selected,
  onSelect,
}: {
  span: TraceSpan
  viewModel: TraceViewModel
  selected: boolean
  onSelect: () => void
}) {
  const t = useTranslation()
  if (span.kind === 'message') {
    return <MessageSpanCard span={span} selected={selected} onSelect={onSelect} />
  }

  if (span.kind === 'tool') {
    const childSpans = span.childIds
      .map((id) => viewModel.spansById.get(id))
      .filter((child): child is TraceSpan => !!child)
    return (
      <button
        type="button"
        onClick={onSelect}
        className={`w-full overflow-hidden rounded-[8px] border text-left transition-colors active:scale-[0.995] ${
          selected
            ? 'border-[var(--color-primary-container)] bg-[var(--color-surface-container)]'
            : 'border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] hover:bg-[var(--color-surface-container-low)]'
        }`}
      >
        <div className="flex min-w-0 items-center gap-2 border-b border-[var(--color-border)]/70 px-3 py-2">
          <Wrench size={14} strokeWidth={2} className="shrink-0 text-[var(--color-text-tertiary)]" />
          <span className="truncate text-xs font-semibold text-[var(--color-text-primary)]">{spanTitle(span, t)}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-text-tertiary)]">{spanSubtitle(span, t)}</span>
          <StatusPill status={span.status} />
        </div>
        {childSpans.length > 0 ? (
          <div className="space-y-1 px-3 py-2">
            {childSpans.slice(0, 3).map((child) => (
              <div key={child.id} className="flex items-start gap-2 rounded-[6px] bg-[var(--color-surface)] px-2 py-1.5 text-[11px] text-[var(--color-text-secondary)]">
                <StatusGlyph status={child.status} />
                <span className="line-clamp-2 min-w-0 flex-1">{child.subtitle}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-3 py-2 text-[11px] text-[var(--color-text-tertiary)]">{t('trace.waitingForResult')}</div>
        )}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[8px] border px-3 py-2 text-left transition-colors active:scale-[0.995] ${
        selected
          ? 'border-[var(--color-primary-container)] bg-[var(--color-surface-container)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] hover:bg-[var(--color-surface-container-low)]'
      }`}
    >
      <SpanIcon span={span} />
      <div className="min-w-0">
        <div className="truncate text-xs font-semibold text-[var(--color-text-primary)]">{spanTitle(span, t)}</div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-text-tertiary)]">
          {spanSubtitle(span, t)}
          {span.durationMs !== undefined ? ` · ${formatDuration(span.durationMs)}` : ''}
        </div>
      </div>
      <StatusPill status={span.status} />
    </button>
  )
}

function MessageSpanCard({ span, selected, onSelect }: { span: TraceSpan; selected: boolean; onSelect: () => void }) {
  const t = useTranslation()
  const message = span.message
  const text = message ? createTextPreview(extractTextContent(message.content), MESSAGE_PREVIEW_CHARS).text : ''
  const isUser = message?.type === 'user'
  const isAssistant = message?.type === 'assistant'

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-[8px] border px-3 py-2 text-left transition-colors active:scale-[0.995] ${
        selected
          ? 'border-[var(--color-primary-container)] bg-[var(--color-surface-container)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] hover:bg-[var(--color-surface-container-low)]'
      }`}
    >
      <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
        {isUser ? <MessageSquareText size={13} strokeWidth={2} /> : isAssistant ? <Bot size={13} strokeWidth={2} /> : <FileJson2 size={13} strokeWidth={2} />}
        <span>{spanTitle(span, t)}</span>
        <span className="ml-auto font-mono text-[10px]">{formatTime(span.timestamp)}</span>
      </div>
      {text ? (
        <div className="line-clamp-5 text-xs leading-5 text-[var(--color-text-secondary)]">
          {text}
        </div>
      ) : (
        <div className="text-xs text-[var(--color-text-tertiary)]">{t('trace.emptyMessage')}</div>
      )}
    </button>
  )
}

function TraceInspector({
  span,
  viewModel,
  activeTab,
  rawScope,
  onTabChange,
  onRawScopeChange,
}: {
  span: TraceSpan
  viewModel: TraceViewModel
  activeTab: InspectorTab
  rawScope: RawScope
  onTabChange: (tab: InspectorTab) => void
  onRawScopeChange: (scope: RawScope) => void
}) {
  const t = useTranslation()
  return (
    <aside className="min-h-0 overflow-hidden bg-[var(--color-surface-container-lowest)]">
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-[var(--color-border)] text-[var(--color-text-secondary)]">
              <SpanIcon span={span} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{spanTitle(span, t)}</h2>
                <StatusPill status={span.status} />
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-text-tertiary)]">{spanSubtitle(span, t)}</div>
            </div>
          </div>
          <div className="mt-3 flex overflow-x-auto border-b border-[var(--color-border)]" role="tablist" aria-label={t('trace.inspectorAria')}>
            {(['overview', 'input', 'output', 'metadata', 'raw'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                onClick={() => onTabChange(tab)}
                className={`shrink-0 border-b-2 px-3 py-2 text-xs font-semibold transition-colors ${
                  activeTab === tab
                    ? 'border-[var(--color-brand)] text-[var(--color-text-primary)]'
                    : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                {inspectorTabLabel(tab, t)}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {activeTab === 'overview' ? <OverviewPanel span={span} viewModel={viewModel} /> : null}
          {activeTab === 'input' ? <InputPanel span={span} /> : null}
          {activeTab === 'output' ? <OutputPanel span={span} viewModel={viewModel} /> : null}
          {activeTab === 'metadata' ? <MetadataPanel span={span} /> : null}
          {activeTab === 'raw' ? (
            <RawPanel
              span={span}
              viewModel={viewModel}
              rawScope={rawScope}
              onRawScopeChange={onRawScopeChange}
            />
          ) : null}
        </div>
      </div>
    </aside>
  )
}

function OverviewPanel({ span, viewModel }: { span: TraceSpan; viewModel: TraceViewModel }) {
  const t = useTranslation()
  const call = span.call
  const children = span.childIds.map((id) => viewModel.spansById.get(id)).filter(Boolean) as TraceSpan[]
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <MetricBox label={t('trace.kind')} value={kindLabel(span.kind, t)} />
        <MetricBox label={t('trace.status')} value={statusLabel(span.status, t)} tone={span.status === 'error' ? 'danger' : 'default'} />
        <MetricBox label={t('trace.started')} value={formatTime(span.timestamp)} />
        <MetricBox label={t('trace.duration')} value={span.durationMs !== undefined ? formatDuration(span.durationMs) : t('trace.notAvailable')} />
      </div>
      {call ? (
        <div className="grid grid-cols-2 gap-3">
          <MetricBox label={t('trace.provider')} value={call.provider?.name ?? call.source} />
          <MetricBox label={t('trace.model')} value={call.model ?? t('trace.notAvailable')} />
          <MetricBox label={t('trace.request')} value={formatBytesValue(call.request.body.bytes)} />
          <MetricBox label={t('trace.response')} value={call.response ? formatBytesValue(call.response.body.bytes) : t('trace.notAvailable')} />
        </div>
      ) : null}
      {call?.error ? (
        <InlineNotice tone="danger" title={t('common.error')}>
          {call?.error?.message ?? t('trace.spanFailed')}
        </InlineNotice>
      ) : null}
      {span.kind === 'session' ? (
        <DataSection title={t('trace.sessionSummary')}>
          <SummaryRows span={span} viewModel={viewModel} />
        </DataSection>
      ) : null}
      {children.length > 0 ? (
        <DataSection title={t('trace.childSpans')}>
          <div className="space-y-1.5">
            {children.map((child) => (
              <div key={child.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-[6px] border border-[var(--color-border)] px-2 py-1.5">
                <SpanIcon span={child} />
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-[var(--color-text-primary)]">{spanTitle(child, t)}</div>
                  <div className="truncate font-mono text-[10px] text-[var(--color-text-tertiary)]">{spanSubtitle(child, t)}</div>
                </div>
                <StatusGlyph status={child.status} />
              </div>
            ))}
          </div>
        </DataSection>
      ) : null}
    </div>
  )
}

function InputPanel({ span }: { span: TraceSpan }) {
  const t = useTranslation()
  if (span.call) {
    return (
      <div className="space-y-3">
        <BodyPreview title={t('trace.requestBody')} body={span.call.request.body} />
        <DataPreview title={t('trace.requestHeaders')} value={span.call.request.headers} language="json" />
      </div>
    )
  }
  if (span.kind === 'tool') {
    return <DataPreview title={t('trace.toolArguments')} value={span.input ?? null} language="json" />
  }
  if (span.message) {
    return <MessagePreview title={t('trace.messageContent')} message={span.message} />
  }
  if (span.event) {
    return <DataPreview title={t('trace.eventPayload')} value={span.event.metadata ?? null} language="json" />
  }
  return <EmptyPanel label={t('trace.noInput')} />
}

function OutputPanel({ span, viewModel }: { span: TraceSpan; viewModel: TraceViewModel }) {
  const t = useTranslation()
  if (span.call) {
    if (span.call.error) {
      return <InlineNotice tone="danger" title={span.call.error.name}>{span.call.error.message}</InlineNotice>
    }
    return span.call.response ? (
      <div className="space-y-3">
        <BodyPreview title={t('trace.responseBody')} body={span.call.response.body} />
        <DataPreview title={t('trace.responseHeaders')} value={span.call.response.headers} language="json" />
      </div>
    ) : (
      <EmptyPanel label={t('trace.noResponse')} />
    )
  }
  if (span.kind === 'tool') {
    const outputs = span.childIds
      .map((id) => viewModel.spansById.get(id))
      .filter((child): child is TraceSpan => !!child && child.kind === 'tool_result')
      .map((child) => child.output)
    return outputs.length > 0
      ? <DataPreview title={t('trace.toolResult')} value={outputs.length === 1 ? outputs[0] : outputs} language="json" />
      : <EmptyPanel label={t('trace.toolResultPending')} />
  }
  if (span.kind === 'tool_result') {
    return <DataPreview title={t('trace.toolResult')} value={span.output ?? null} language="json" />
  }
  if (span.event) {
    return <DataPreview title={t('trace.eventPayload')} value={{
      phase: span.event.phase,
      severity: span.event.severity,
      message: span.event.message,
      metadata: span.event.metadata,
    }} language="json" />
  }
  return <EmptyPanel label={t('trace.noSeparateOutput')} />
}

function MetadataPanel({ span }: { span: TraceSpan }) {
  const call = span.call
  const metadata = {
    id: span.id,
    parentId: span.parentId,
    kind: span.kind,
    status: span.status,
    timestamp: span.timestamp,
    completedAt: span.completedAt,
    durationMs: span.durationMs,
    turnIndex: span.turnIndex,
    toolUseId: span.toolUseId,
    toolName: span.toolName,
    isSidechain: span.isSidechain,
    event: span.event
      ? {
          id: span.event.id,
          phase: span.event.phase,
          severity: span.event.severity,
          callId: span.event.callId,
          source: span.event.source,
          provider: span.event.provider,
          model: span.event.model,
          message: span.event.message,
        }
      : undefined,
    provider: call?.provider,
    model: call?.model,
    request: call
      ? {
          method: call.request.method,
          url: call.request.url,
          bodyBytes: call.request.body.bytes,
          bodySha256: call.request.body.sha256,
          bodyTruncated: call.request.body.truncated,
        }
      : undefined,
    response: call?.response
      ? {
          status: call.response.status,
          bodyBytes: call.response.body.bytes,
          bodySha256: call.response.body.sha256,
          bodyTruncated: call.response.body.truncated,
        }
      : undefined,
  }
  const t = useTranslation()
  return <DataPreview title={t('trace.spanMetadata')} value={metadata} language="json" />
}

function RawPanel({
  span,
  viewModel,
  rawScope,
  onRawScopeChange,
}: {
  span: TraceSpan
  viewModel: TraceViewModel
  rawScope: RawScope
  onRawScopeChange: (scope: RawScope) => void
}) {
  const t = useTranslation()
  const raw = rawScope === 'span' ? span.raw : viewModel.fullRaw
  return (
    <div className="space-y-3">
      <div className="flex rounded-[8px] border border-[var(--color-border)] p-1">
        {(['span', 'full'] as const).map((scope) => (
          <button
            key={scope}
            type="button"
            onClick={() => onRawScopeChange(scope)}
            className={`flex-1 rounded-[6px] px-2 py-1.5 text-xs font-semibold transition-colors ${
              rawScope === scope
                ? 'bg-[var(--color-surface-container-high)] text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            {scope === 'span' ? t('trace.rawScope.span') : t('trace.rawScope.full')}
          </button>
        ))}
      </div>
      <DataPreview title={rawScope === 'span' ? t('trace.rawSpanJson') : t('trace.rawTraceJson')} value={raw} language="json" maxLines={36} />
    </div>
  )
}

function BodyPreview({ title, body }: { title: string; body: TraceBodySnapshot }) {
  const t = useTranslation()
  const language = body.contentType === 'json' ? 'json' : 'text'
  const code = body.contentType === 'json' ? formatTraceJson(body.preview) : body.preview
  return (
    <DataSection
      title={title}
      right={
        <span className="font-mono text-[10px] text-[var(--color-text-tertiary)]">
          {formatBytesValue(body.bytes)}{body.truncated ? ` · ${t('trace.truncatedShort')}` : ''}
        </span>
      }
    >
      {code ? (
        <CodeViewer code={code} language={language} maxLines={32} showLineNumbers={language === 'json'} />
      ) : (
        <EmptyPanel label={t('trace.emptyBodyShort')} compact />
      )}
    </DataSection>
  )
}

function DataPreview({
  title,
  value,
  language,
  maxLines = 28,
}: {
  title: string
  value: unknown
  language?: 'json' | 'text'
  maxLines?: number
}) {
  const t = useTranslation()
  const code = language === 'text' ? String(value ?? '') : formatTraceJson(value)
  const detectedLanguage = language ?? getTraceValueLanguage(value)
  return (
    <DataSection title={title}>
      {code && code !== 'undefined' ? (
        <CodeViewer code={code} language={detectedLanguage === 'json' ? 'json' : 'text'} maxLines={maxLines} showLineNumbers={detectedLanguage === 'json'} />
      ) : (
        <EmptyPanel label={t('trace.noData')} compact />
      )}
    </DataSection>
  )
}

function MessagePreview({ title, message }: { title: string; message: MessageEntry }) {
  const t = useTranslation()
  const text = extractTextContent(message.content)
  const preview = createTextPreview(text, MESSAGE_PREVIEW_CHARS)
  const language = getTraceValueLanguage(message.content, 'text')
  if (text.trim() && language === 'text') {
    return (
      <DataSection title={title} right={preview.truncated ? <span className="text-[10px] text-[var(--color-text-tertiary)]">{t('trace.truncatedShort')}</span> : null}>
        <div className="rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
          <MarkdownRenderer content={preview.text} variant="compact" />
        </div>
      </DataSection>
    )
  }
  return <DataPreview title={title} value={message.content} language="json" />
}

function SummaryRows({ span, viewModel }: { span: TraceSpan; viewModel: TraceViewModel }) {
  const t = useTranslation()
  const llm = viewModel.spans.filter((item) => item.kind === 'llm').length
  const tools = viewModel.spans.filter((item) => item.kind === 'tool').length
  const errors = viewModel.spans.filter((item) => item.status === 'error').length
  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <SummaryRow label={t('trace.trace')} value={span.title} />
      <SummaryRow label={t('trace.turns')} value={String(viewModel.turns.length)} />
      <SummaryRow label={t('trace.llmCalls')} value={String(llm)} />
      <SummaryRow label={t('trace.toolCalls')} value={String(tools)} />
      <SummaryRow label={t('trace.errors')} value={String(errors)} tone={errors > 0 ? 'danger' : 'default'} />
      <SummaryRow label={t('trace.started')} value={formatTime(span.timestamp)} />
    </div>
  )
}

function DataSection({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </section>
  )
}

function EmptyPanel({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <div className={`flex items-center justify-center rounded-[8px] border border-dashed border-[var(--color-border)] text-xs text-[var(--color-text-tertiary)] ${compact ? 'p-3' : 'p-8'}`}>
      {label}
    </div>
  )
}

function InlineNotice({ tone, title, children }: { tone: 'danger' | 'default'; title: string; children: ReactNode }) {
  return (
    <div className={`rounded-[8px] border px-3 py-2 text-sm ${
      tone === 'danger'
        ? 'border-[var(--color-error)]/25 bg-[var(--color-error-container)]/50 text-[var(--color-error)]'
        : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)]'
    }`}>
      <div className="text-xs font-semibold">{title}</div>
      <div className="mt-1 text-xs leading-5">{children}</div>
    </div>
  )
}

function IconAction({ label, onClick, children }: { label: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-[var(--color-border)] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-focus)] hover:text-[var(--color-text-primary)] active:scale-[0.98]"
    >
      {children}
    </button>
  )
}

function SpanIcon({ span }: { span: TraceSpan }) {
  const className = span.status === 'error'
    ? 'text-[var(--color-error)]'
    : span.kind === 'llm'
      ? 'text-[var(--color-brand)]'
      : 'text-[var(--color-text-tertiary)]'
  const icon = iconForKind(span.kind)
  return <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${className}`}>{icon}</span>
}

function iconForKind(kind: TraceSpanKind): ReactNode {
  switch (kind) {
    case 'session': return <RadioTower size={14} strokeWidth={2} />
    case 'turn': return <GitBranch size={14} strokeWidth={2} />
    case 'llm': return <Server size={14} strokeWidth={2} />
    case 'tool': return <Wrench size={14} strokeWidth={2} />
    case 'tool_result': return <Database size={14} strokeWidth={2} />
    case 'message': return <MessageSquareText size={14} strokeWidth={2} />
    case 'event': return <Clock3 size={14} strokeWidth={2} />
    default: return <FileJson2 size={14} strokeWidth={2} />
  }
}

function StatusGlyph({ status }: { status: TraceSpanStatus }) {
  if (status === 'error') return <AlertTriangle size={13} strokeWidth={2} className="text-[var(--color-error)]" />
  if (status === 'pending') return <Clock3 size={13} strokeWidth={2} className="text-[var(--color-text-tertiary)]" />
  return <CheckCircle2 size={13} strokeWidth={2} className="text-[var(--color-success)]" />
}

function StatusPill({ status }: { status: TraceSpanStatus }) {
  const t = useTranslation()
  const icon = status === 'ok'
    ? <CheckCircle2 size={12} strokeWidth={2} />
    : status === 'error'
      ? <AlertTriangle size={12} strokeWidth={2} />
      : <Clock3 size={12} strokeWidth={2} />
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[10px] font-semibold ${
      status === 'error'
        ? 'bg-[var(--color-error)]/10 text-[var(--color-error)]'
        : status === 'ok'
          ? 'bg-[var(--color-success)]/10 text-[var(--color-success)]'
          : 'bg-[var(--color-surface-container)] text-[var(--color-text-tertiary)]'
    }`}>
      {icon}
      {statusLabel(status, t)}
    </span>
  )
}

function Metric({ label, value, tone = 'default', wide = false }: { label: string; value: string; tone?: 'default' | 'danger'; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2 md:col-span-1' : ''}>
      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-0.5 truncate font-mono text-[13px] ${tone === 'danger' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-primary)]'}`}>
        {value}
      </div>
    </div>
  )
}

function MetricBox({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'danger' }) {
  return (
    <div className="rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-1 truncate font-mono text-xs ${tone === 'danger' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-primary)]'}`}>{value}</div>
    </div>
  )
}

function MiniStat({ value, label, tone = 'default' }: { value: number; label: string; tone?: 'default' | 'danger' }) {
  return (
    <span className={`rounded-[6px] border px-1.5 py-0.5 font-mono text-[10px] ${
      tone === 'danger' && value > 0
        ? 'border-[var(--color-error)]/25 text-[var(--color-error)]'
        : 'border-[var(--color-border)] text-[var(--color-text-tertiary)]'
    }`}>
      {value} {label}
    </span>
  )
}

function SummaryRow({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'danger' }) {
  return (
    <div className="min-w-0 rounded-[6px] bg-[var(--color-surface)] px-2 py-1.5">
      <div className="text-[10px] text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`truncate font-mono text-[11px] ${tone === 'danger' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-primary)]'}`}>{value}</div>
    </div>
  )
}

function TraceLoading({ sessionId, title, standalone }: { sessionId: string; title: string; standalone?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]">
      <TraceHeader sessionId={sessionId} title={title} standalone={standalone} />
      <div className="grid min-h-0 flex-1 grid-cols-1 border-t border-[var(--color-border)] xl:grid-cols-[300px_minmax(420px,1fr)_minmax(360px,0.85fr)]">
        <div className="border-r border-[var(--color-border)] p-4">
          <div className="h-8 animate-pulse rounded-[8px] bg-[var(--color-surface-container)]" />
          <div className="mt-4 space-y-2">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="h-10 animate-pulse rounded-[8px] bg-[var(--color-surface-container)]" />
            ))}
          </div>
        </div>
        <div className="border-r border-[var(--color-border)] p-5">
          <div className="h-4 w-56 animate-pulse rounded bg-[var(--color-surface-container)]" />
          <div className="mt-6 space-y-3">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="h-24 animate-pulse rounded-[8px] bg-[var(--color-surface-container)]" />
            ))}
          </div>
        </div>
        <div className="p-4">
          <div className="h-10 animate-pulse rounded-[8px] bg-[var(--color-surface-container)]" />
          <div className="mt-4 h-72 animate-pulse rounded-[8px] bg-[var(--color-surface-container)]" />
        </div>
      </div>
    </div>
  )
}

function TraceEmpty() {
  const t = useTranslation()
  return (
    <div className="flex flex-1 items-center justify-center border-t border-[var(--color-border)] p-8">
      <div className="max-w-sm border-t border-[var(--color-border)] pt-5 text-center">
        <RadioTower size={22} strokeWidth={2} className="mx-auto text-[var(--color-text-tertiary)]" />
        <h2 className="mt-3 text-sm font-semibold text-[var(--color-text-primary)]">{t('trace.emptyTitle')}</h2>
        <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">{t('trace.emptyBody')}</p>
      </div>
    </div>
  )
}

function filterSpanIds(viewModel: TraceViewModel, filter: SpanFilter, query: string): Set<string> {
  const normalizedQuery = query.trim().toLowerCase()
  const matched = new Set<string>()
  for (const span of viewModel.spans) {
    const filterMatch =
      filter === 'all' ||
      (filter === 'llm' && span.kind === 'llm') ||
      (filter === 'tool' && (span.kind === 'tool' || span.kind === 'tool_result')) ||
      (filter === 'error' && span.status === 'error')
    const queryMatch = !normalizedQuery || spanSearchText(span).includes(normalizedQuery)
    if (filterMatch && queryMatch) {
      includeWithAncestors(viewModel, span.id, matched)
    }
  }
  return matched
}

function includeWithAncestors(viewModel: TraceViewModel, spanId: string, target: Set<string>) {
  let current = viewModel.spansById.get(spanId)
  while (current) {
    target.add(current.id)
    current = current.parentId ? viewModel.spansById.get(current.parentId) : undefined
  }
}

function spanSearchText(span: TraceSpan): string {
  return [
    span.title,
    span.subtitle,
    span.kind,
    span.status,
    span.toolName,
    span.toolUseId,
    span.call?.model,
    span.call?.provider?.name,
    span.call?.request.url,
    span.event?.phase,
    span.event?.message,
    span.event?.provider?.name,
    previewTraceValue(span.raw, 500),
  ].filter(Boolean).join(' ').toLowerCase()
}

function computeDepths(viewModel: TraceViewModel): Map<string, number> {
  const depths = new Map<string, number>()
  const visit = (id: string, depth: number) => {
    depths.set(id, depth)
    const span = viewModel.spansById.get(id)
    if (!span) return
    for (const childId of span.childIds) visit(childId, depth + 1)
  }
  visit(viewModel.rootId, 0)
  return depths
}

function summarizeTurn(spans: TraceSpan[]): { llm: number; tools: number; errors: number } {
  return spans.reduce(
    (acc, span) => {
      if (span.kind === 'llm') acc.llm += 1
      if (span.kind === 'tool') acc.tools += 1
      if (span.status === 'error') acc.errors += 1
      return acc
    },
    { llm: 0, tools: 0, errors: 0 },
  )
}

function filterLabel(filter: SpanFilter, t: TraceTranslator): string {
  switch (filter) {
    case 'llm': return t('trace.filter.llm')
    case 'tool': return t('trace.filter.tools')
    case 'error': return t('trace.filter.errors')
    default: return t('trace.filter.all')
  }
}

function inspectorTabLabel(tab: InspectorTab, t: TraceTranslator): string {
  switch (tab) {
    case 'input': return t('trace.tab.input')
    case 'output': return t('trace.tab.output')
    case 'metadata': return t('trace.tab.metadata')
    case 'raw': return t('trace.tab.raw')
    default: return t('trace.tab.overview')
  }
}

function kindLabel(kind: TraceSpanKind, t: TraceTranslator): string {
  switch (kind) {
    case 'session': return t('trace.kind.session')
    case 'turn': return t('trace.kind.turn')
    case 'llm': return t('trace.kind.llm')
    case 'tool': return t('trace.kind.tool')
    case 'tool_result': return t('trace.kind.toolResult')
    case 'message': return t('trace.kind.message')
    case 'event': return t('trace.kind.event')
    default: return kind
  }
}

function statusLabel(status: TraceSpanStatus, t: TraceTranslator): string {
  switch (status) {
    case 'error': return t('trace.status.error')
    case 'pending': return t('trace.status.pending')
    default: return t('trace.status.ok')
  }
}

function diagnosisReasonLabel(reason: TraceViewModel['diagnosis']['reason'], t: TraceTranslator): string {
  switch (reason) {
    case 'model_error': return t('trace.diagnosis.modelError')
    case 'tool_error': return t('trace.diagnosis.toolError')
    case 'event_error': return t('trace.diagnosis.eventError')
    case 'pending_model': return t('trace.diagnosis.pendingModel')
    case 'pending_tool': return t('trace.diagnosis.pendingTool')
    case 'waiting_for_agent': return t('trace.diagnosis.waitingForAgent')
    case 'empty': return t('trace.diagnosis.empty')
    default: return t('trace.diagnosis.healthy')
  }
}

function spanTitle(span: TraceSpan, t: TraceTranslator): string {
  if (span.kind === 'message' && span.message) {
    switch (span.message.type) {
      case 'user': return t('trace.message.user')
      case 'assistant': return span.message.model ? `${t('trace.message.assistant')} · ${span.message.model}` : t('trace.message.assistant')
      case 'system': return t('trace.message.system')
      case 'tool_use': return t('trace.message.toolRequest')
      case 'tool_result': return t('trace.message.toolResult')
      default: return span.message.type
    }
  }
  if (span.kind === 'tool_result') {
    return span.status === 'error' ? t('trace.toolError') : t('trace.toolResult')
  }
  if (span.kind === 'llm') {
    return span.call?.model ?? span.call?.provider?.name ?? t('trace.modelCall')
  }
  if (span.kind === 'tool') {
    return span.toolName ?? span.title
  }
  if (span.kind === 'event' && span.event) {
    return traceEventPhaseLabel(span.event.phase, t)
  }
  if (span.kind === 'turn') {
    if (span.title === 'Session activity') return t('trace.sessionActivity')
    const match = span.title.match(/^Turn (\d+)$/)
    if (match) return t('trace.turnLabel', { index: match[1]! })
  }
  return span.title
}

function turnTitle(turn: TraceTurn, t: TraceTranslator): string {
  if (turn.title === 'Session activity') return t('trace.sessionActivity')
  const match = turn.title.match(/^Turn (\d+)$/)
  if (match) return t('trace.turnLabel', { index: match[1]! })
  return turn.title
}

function spanSubtitle(span: TraceSpan, t: TraceTranslator): string {
  if (span.kind === 'session') {
    return t('trace.modelCalls', { count: span.call ? 1 : getSessionModelCallCount(span) })
  }
  if (span.kind === 'turn') {
    return t('trace.turnLabel', { index: (span.turnIndex ?? 0) + 1 })
  }
  if (span.kind === 'event' && span.event) {
    return span.event.message ?? span.event.provider?.name ?? spanSubtitleFromEvent(span.event, t)
  }
  return span.subtitle === 'empty' ? t('trace.emptyValue') : span.subtitle
}

function spanSubtitleFromEvent(event: NonNullable<TraceSpan['event']>, t: TraceTranslator): string {
  const status = event.metadata && typeof event.metadata.status === 'number'
    ? `HTTP ${event.metadata.status}`
    : undefined
  return status ?? event.source ?? t('trace.kind.event')
}

function traceEventPhaseLabel(phase: string, t: TraceTranslator): string {
  switch (phase) {
    case 'api_call_started': return t('trace.event.apiCallStarted')
    case 'api_call_completed': return t('trace.event.apiCallCompleted')
    case 'api_call_failed': return t('trace.event.apiCallFailed')
    case 'response_capture_failed': return t('trace.event.responseCaptureFailed')
    case 'upstream_fetch_started': return t('trace.event.upstreamFetchStarted')
    case 'upstream_fetch_completed': return t('trace.event.upstreamFetchCompleted')
    case 'upstream_fetch_failed': return t('trace.event.upstreamFetchFailed')
    default: return phase
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  }
}

function getSessionModelCallCount(span: TraceSpan): number {
  const raw = span.raw as { summary?: { apiCalls?: unknown } } | undefined
  return typeof raw?.summary?.apiCalls === 'number' ? raw.summary.apiCalls : 0
}

function createTextPreview(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: `${text.slice(0, maxChars)}\n...`, truncated: true }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
