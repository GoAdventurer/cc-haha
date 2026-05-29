import { listen } from '@tauri-apps/api/event'
import { useBrowserPanelStore } from '../stores/browserPanelStore'
import { useChatStore } from '../stores/chatStore'
import { buildSelectionComposerText, type SelectionPayload } from './selectionComposer'

function kindLabel(kind?: string): string {
  if (kind === 'viewport') return 'viewport'
  if (kind === 'element') return 'element'
  return 'full'
}

export async function subscribePreviewEvents(sessionId: string): Promise<() => void> {
  return listen<string>('preview://event', (e) => {
    let msg: { type?: string; url?: string; title?: string; dataUrl?: string; kind?: string; payload?: unknown }
    try { msg = JSON.parse(e.payload) } catch { return }
    const store = useBrowserPanelStore.getState()
    if (msg.type === 'navigated' && msg.url) store.setNavigated(sessionId, msg.url, msg.title ?? '')
    else if (msg.type === 'ready') store.setReady(sessionId)
    else if (msg.type === 'screenshot' && msg.dataUrl) {
      useChatStore.getState().queueComposerPrefill(sessionId, {
        text: '',
        attachments: [{ type: 'image', name: `screenshot-${kindLabel(msg.kind)}.png`, mimeType: 'image/png', data: msg.dataUrl }],
      })
    }
    else if (msg.type === 'selection' && msg.payload) {
      const p = msg.payload as SelectionPayload & { screenshot?: { dataUrl?: string; kind?: string } }
      useChatStore.getState().queueComposerPrefill(sessionId, {
        text: buildSelectionComposerText(p),
        attachments: p.screenshot?.dataUrl
          ? [{ type: 'image', name: 'selection.png', mimeType: 'image/png', data: p.screenshot.dataUrl }]
          : [],
      })
    }
  })
}
