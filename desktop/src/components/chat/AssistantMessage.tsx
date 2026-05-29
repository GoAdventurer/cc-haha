import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { MessageActionBar, type MessageBranchAction } from './MessageActionBar'
import { InlineImageGallery } from './InlineImageGallery'
import { handlePreviewLink } from '../../lib/handlePreviewLink'
import { getServerBaseUrl } from '../../lib/desktopRuntime'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useOpenTargetStore } from '../../stores/openTargetStore'
import { OpenWithMenu } from '../common/OpenWithMenu'
import { buildOpenWithItems, type OpenWithItem } from '../../lib/openWithItems'
import { openWithContextForHref } from '../../lib/openWithContextForHref'
import { classifyPreviewLink } from '../../lib/previewLinkRouter'
import { useTranslation, type TranslationKey } from '../../i18n'

type Props = {
  content: string
  isStreaming?: boolean
  branchAction?: MessageBranchAction
  sessionId?: string
}

export const AssistantMessage = memo(function AssistantMessage({ content, isStreaming, branchAction, sessionId }: Props) {
  const t = useTranslation()
  const contentRef = useRef<HTMLDivElement>(null)
  const [openWith, setOpenWith] = useState<{ items: OpenWithItem[]; anchor: DOMRect } | null>(null)

  const handleLinkClick = useCallback(
    (href: string, event: ReactMouseEvent<HTMLDivElement>): boolean => {
      if (!sessionId) return false
      const handled = handlePreviewLink(href, {
        sessionId,
        serverBaseUrl: getServerBaseUrl(),
        openBrowser: (id, url) => useBrowserPanelStore.getState().open(id, url),
        openFilePreview: (id, path) => {
          void useWorkspacePanelStore.getState().openPreview(id, path, 'file')
        },
        openExternal: (url) => {
          void import('@tauri-apps/plugin-shell')
            .then((m) => m.open(url))
            .catch(() => window.open(url, '_blank'))
        },
      })
      if (handled) event.preventDefault()
      return handled
    },
    [sessionId],
  )

  // Inject ▾ triggers after streaming completes — gated on !isStreaming
  useEffect(() => {
    const root = contentRef.current
    if (!root || !sessionId || isStreaming) return

    function makeTrigger(href: string): HTMLButtonElement {
      const trigger = document.createElement('button')
      trigger.type = 'button'
      trigger.className = 'md-open-with'
      trigger.dataset.openWithHref = href
      trigger.setAttribute('aria-label', '打开方式')
      trigger.tabIndex = -1
      trigger.textContent = '▾'
      trigger.style.cssText = 'margin-left:3px;padding:0 3px;border:none;background:transparent;color:var(--color-text-tertiary);cursor:pointer;font-size:11px;line-height:1;vertical-align:middle'
      return trigger
    }

    root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((link) => {
      const href = link.getAttribute('href') ?? ''
      if (classifyPreviewLink(href).kind === 'ignored') return
      if (link.nextElementSibling instanceof HTMLElement && link.nextElementSibling.classList.contains('md-open-with')) return
      link.after(makeTrigger(href))
    })

    root.querySelectorAll<HTMLElement>('code').forEach((code) => {
      if (code.closest('pre')) return
      const text = (code.textContent ?? '').trim()
      const kind = classifyPreviewLink(text).kind
      if (kind !== 'browser-localhost' && kind !== 'remote') return
      if (code.nextElementSibling instanceof HTMLElement && code.nextElementSibling.classList.contains('md-open-with')) return
      code.after(makeTrigger(text))
    })
  }, [content, isStreaming, sessionId])

  const handleContentClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const trigger = (event.target as HTMLElement | null)?.closest<HTMLElement>('.md-open-with')
    if (!trigger || !sessionId) return
    event.preventDefault()
    event.stopPropagation()
    const href = trigger.dataset.openWithHref ?? ''
    const rect = trigger.getBoundingClientRect()
    void (async () => {
      const store = useOpenTargetStore.getState()
      await store.ensureTargets()
      const targets = useOpenTargetStore.getState().targets
      const workDir = useWorkspacePanelStore.getState().statusBySession[sessionId]?.workDir
      const ctx = openWithContextForHref(href, { sessionId, serverBaseUrl: getServerBaseUrl(), workDir })
      if (!ctx) return
      const items = buildOpenWithItems(ctx, targets, {
        openInAppBrowser: (url) => useBrowserPanelStore.getState().open(sessionId, url),
        openSystem: (p) => { void import('@tauri-apps/plugin-shell').then((m) => m.open(p)).catch(() => window.open(p, '_blank')) },
        openWorkspacePreview: (relPath) => { void useWorkspacePanelStore.getState().openPreview(sessionId, relPath, 'file') },
        openTarget: (id, abs) => { void useOpenTargetStore.getState().openTarget(id, abs) },
        t: (key, vars) => t(key as TranslationKey, vars),
      })
      setOpenWith({ items, anchor: rect })
    })()
  }, [sessionId, t])

  if (!content.trim()) return null

  const documentLayout = shouldUseDocumentLayout(content)

  return (
    <div className="group mb-5 flex justify-start">
      <div
        data-message-shell="assistant"
        data-layout={documentLayout ? 'document' : 'bubble'}
        className={`flex min-w-0 flex-col items-start gap-2 ${
          documentLayout
            ? 'w-full max-w-full'
            : 'w-full max-w-[88%] sm:max-w-[80%] lg:max-w-[72%]'
        }`}
      >
        <div className={`rounded-[20px] rounded-tl-[8px] border border-[var(--color-border)]/60 bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text-primary)] shadow-sm ${
          documentLayout ? 'w-full' : 'max-w-full'
        }`}>
          <div ref={contentRef} onClick={handleContentClick}>
            <MarkdownRenderer
              content={content}
              variant={documentLayout ? 'document' : 'default'}
              streaming={isStreaming}
              onLinkClick={sessionId ? handleLinkClick : undefined}
            />
          </div>
          {!isStreaming && <InlineImageGallery text={content} />}
          {isStreaming && (
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-shimmer bg-[var(--color-brand)] align-text-bottom" />
          )}
        </div>

        <MessageActionBar
          copyText={isStreaming ? undefined : content}
          copyLabel="Copy reply"
          branchAction={branchAction}
          align="start"
        />
      </div>
      {openWith && <OpenWithMenu items={openWith.items} anchor={openWith.anchor} onClose={() => setOpenWith(null)} />}
    </div>
  )
})

function shouldUseDocumentLayout(content: string) {
  const normalized = content.trim()
  if (!normalized) return false

  if (/```/.test(normalized)) return true
  if (/^\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|.+\|)/m.test(normalized)) return true

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)

  return paragraphs.length >= 2 || normalized.split('\n').filter((line) => line.trim()).length >= 8
}
