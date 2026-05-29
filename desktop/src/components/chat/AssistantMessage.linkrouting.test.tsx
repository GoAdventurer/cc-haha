import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { openBrowser } = vi.hoisted(() => ({ openBrowser: vi.fn() }))
vi.mock('../../stores/browserPanelStore', () => ({
  useBrowserPanelStore: { getState: () => ({ open: openBrowser }) },
}))
vi.mock('../../lib/desktopRuntime', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getServerBaseUrl: () => 'http://127.0.0.1:4321',
}))

// Mock openTargetStore for the open-with menu
const ensureTargets = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const openTargetFn = vi.hoisted(() => vi.fn())
vi.mock('../../stores/openTargetStore', () => ({
  useOpenTargetStore: {
    getState: () => ({ ensureTargets, targets: [], openTarget: openTargetFn }),
  },
}))

// Mock workspacePanelStore — workDir returns undefined (no active workspace)
const openPreviewFn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../stores/workspacePanelStore', () => ({
  useWorkspacePanelStore: {
    getState: () => ({
      statusBySession: {},
      openPreview: openPreviewFn,
    }),
  },
}))

// Mock tauri shell (used by openSystem inside handleContentClick)
const shellOpen = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: shellOpen }))

// Mock i18n — return the key as the label so we can assert on keys
vi.mock('../../i18n', () => ({
  useTranslation: () => (k: string, v?: Record<string, string>) => (v?.target ? `${k}:${v.target}` : k),
  // TranslationKey is just a string-branded type; no runtime value needed
}))

// Mock settingsStore (pulled in transitively by i18n when NOT mocking i18n at module level)
// (already covered by the i18n mock above, but add a safety net)
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign((sel: (s: { locale: string }) => unknown) => sel({ locale: 'en' }), {
    getState: () => ({ locale: 'en' }),
    subscribe: () => () => {},
  }),
}))

import { AssistantMessage } from './AssistantMessage'

afterEach(() => {
  openBrowser.mockReset()
  ensureTargets.mockReset().mockResolvedValue(undefined)
  openTargetFn.mockReset()
})

describe('AssistantMessage link routing', () => {
  it('opens a localhost link in the in-app browser', () => {
    render(<AssistantMessage sessionId="s1" content={'打开 [预览](http://localhost:5173/)'} />)
    fireEvent.click(screen.getByText('预览'))
    expect(openBrowser).toHaveBeenCalledWith('s1', 'http://localhost:5173/')
  })
})

describe('AssistantMessage open-with trigger injection', () => {
  it('injects a ▾ trigger for a previewable link after streaming ends', () => {
    render(
      <AssistantMessage
        sessionId="s1"
        content={'打开 [预览](http://localhost:5173/)'}
        isStreaming={false}
      />,
    )
    expect(screen.getByLabelText('打开方式')).toBeInTheDocument()
  })

  it('does NOT inject a trigger while streaming', () => {
    render(
      <AssistantMessage
        sessionId="s1"
        content={'打开 [预览](http://localhost:5173/)'}
        isStreaming={true}
      />,
    )
    expect(screen.queryByLabelText('打开方式')).toBeNull()
  })

  it('does NOT inject a trigger for an ignored link (#anchor)', () => {
    render(
      <AssistantMessage
        sessionId="s1"
        content={'[anchor](#section)'}
        isStreaming={false}
      />,
    )
    expect(screen.queryByLabelText('打开方式')).toBeNull()
  })

  it('does NOT inject a trigger when sessionId is absent', () => {
    render(
      <AssistantMessage
        content={'打开 [预览](http://localhost:5173/)'}
        isStreaming={false}
      />,
    )
    expect(screen.queryByLabelText('打开方式')).toBeNull()
  })

  it('clicking the ▾ trigger opens a menu with in-app-browser and system-browser items for a URL', async () => {
    render(
      <AssistantMessage
        sessionId="s1"
        content={'打开 [预览](http://localhost:5173/)'}
        isStreaming={false}
      />,
    )

    const trigger = screen.getByLabelText('打开方式')
    fireEvent.click(trigger)

    // Wait for the async ensureTargets chain to resolve and the menu to appear
    await waitFor(() => {
      // buildOpenWithItems for kind:'url' produces in-app + system keys
      expect(screen.getByText('openWith.inAppBrowser')).toBeInTheDocument()
    })
    expect(screen.getByText('openWith.systemBrowser')).toBeInTheDocument()
  })
})

describe('AssistantMessage open-with trigger injection — inline code URLs', () => {
  it('injects a ▾ trigger next to an inline-code localhost URL', async () => {
    render(
      <AssistantMessage
        sessionId="s1"
        content={'运行地址 `http://localhost:9527/`'}
        isStreaming={false}
      />,
    )
    // The trigger comes from the <code> path (no <a> in this content)
    expect(screen.getByLabelText('打开方式')).toBeInTheDocument()
  })

  it('clicking the trigger next to inline-code URL opens menu with in-app-browser and system-browser items', async () => {
    render(
      <AssistantMessage
        sessionId="s1"
        content={'运行地址 `http://localhost:9527/`'}
        isStreaming={false}
      />,
    )

    const trigger = screen.getByLabelText('打开方式')
    fireEvent.click(trigger)

    await waitFor(() => {
      expect(screen.getByText('openWith.inAppBrowser')).toBeInTheDocument()
    })
    expect(screen.getByText('openWith.systemBrowser')).toBeInTheDocument()
  })

  it('does NOT inject a trigger for non-URL inline code', () => {
    render(
      <AssistantMessage
        sessionId="s1"
        content={'装一下 `npm install`'}
        isStreaming={false}
      />,
    )
    expect(screen.queryByLabelText('打开方式')).toBeNull()
  })
})
