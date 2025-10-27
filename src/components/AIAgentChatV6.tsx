import React, { useMemo, useRef, useState } from 'react'
import { type FC } from 'react'

import { Retool } from '@tryretool/custom-component-support'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
}

// Incrementally extract complete JSON objects from a growing buffer.
function extractJsonObjectsFromBuffer(buffer: string): { objects: unknown[]; rest: string } {
  const objects: unknown[] = []
  let depth = 0
  let inString = false
  let escape = false
  let start = -1
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        const jsonStr = buffer.slice(start, i + 1)
        try {
          const obj: unknown = JSON.parse(jsonStr)
          objects.push(obj)
        } catch {
          // ignore parse errors; keep bytes in rest
          return { objects, rest: buffer.slice(start) }
        }
        start = -1
      }
    }
  }
  const rest = depth > 0 && start !== -1 ? buffer.slice(start) : ''
  return { objects, rest }
}

function isStreamItem(obj: unknown): obj is { type?: string; content?: unknown } {
  return typeof obj === 'object' && obj !== null
}

/**
 * AIAgentChatV6
 *
 * High-level responsibilities:
 * - Expose inspector-controlled props to Retool (endpoint/method/headers/etc.)
 * - Render chat UI (Header → Messages scroller → Composer)
 * - Send messages to a bound HTTP endpoint with optional streaming support
 * - Keep the component border inset to avoid scrollbars in Retool containers
 */
export const AIAgentChatV6: FC = () => {
  // Sets the default grid size when dragged onto the Retool canvas
  Retool.useComponentSettings({ defaultWidth: 8, defaultHeight: 16 })

  // Inspector: URL of your HTTP endpoint. Required to enable sending.
  const [endpointUrl] = Retool.useStateString({
    name: 'endpointUrl',
    label: 'Endpoint URL',
    inspector: 'text'
  })

  // Inspector: HTTP method for requests (POST or GET)
  const [requestMethod] = Retool.useStateEnumeration({
    name: 'requestMethod',
    enumDefinition: ['POST', 'GET'],
    initialValue: 'POST',
    inspector: 'select',
    label: 'Method'
  })

  // Inspector (hidden): arbitrary request headers supplied from Retool
  const [requestHeaders] = Retool.useStateObject({
    name: 'requestHeaders',
    inspector: 'hidden'
  })

  // Inspector: key to read the assistant reply from in JSON responses
  const [responseKey] = Retool.useStateString({
    name: 'responseKey',
    label: 'Response Key',
    inspector: 'text',
    initialValue: 'reply'
  })

  // Inspector: streaming mode — 'sse' for Server-Sent Events, 'auto' for best-effort
  const [streamingMode] = Retool.useStateEnumeration({
    name: 'streamingMode',
    enumDefinition: ['none', 'sse', 'auto'],
    initialValue: 'none',
    inspector: 'select',
    label: 'Streaming'
  })

  // Inspector: whether to render assistant messages using markdown
  const [renderMarkdown] = Retool.useStateBoolean({
    name: 'renderMarkdown',
    label: 'Render Markdown',
    inspector: 'checkbox',
    initialValue: false
  })

  // Inspector: optionally display the header bar at the top of the chat
  const [showHeader] = Retool.useStateBoolean({
    name: 'headerVisible',
    label: 'Show Header',
    inspector: 'checkbox',
    initialValue: true
  })

  // THEME AND COLOR CUSTOMIZATION -------------------------------------------
  // Theme mode that can be bound to Retool theme (e.g., {{ theme.mode }})
  const [themeMode, setThemeMode] = Retool.useStateEnumeration({
    name: 'themeMode',
    enumDefinition: ['Light', 'Dark'],
    initialValue: 'Light',
    inspector: 'segmented',
    label: 'Theme Mode',
    description: "Choose Light/Dark, or bind a variable like {{ theme.mode }}"
  })

  // Optional: bind a Retool variable for theme mode (overrides manual selection when provided)
  const [themeModeBinding] = Retool.useStateString({
    name: 'themeModeBinding',
    label: 'Theme Mode Variable',
    inspector: 'text',
    description: "Bind a variable that resolves to 'Light' or 'Dark' (e.g., {{ theme.mode }})"
  })

  // Chat background colors (light/dark)
  const [chatBackgroundLight, setChatBackgroundLight] = Retool.useStateString({
    name: 'chatBackgroundLight',
    label: 'Light — Chat Background',
    inspector: 'text',
    description: 'CSS color or formula (e.g., #ffffff or {{ colors.bgLight }})',
    initialValue: '#ffffff'
  })
  const [chatBackgroundDark, setChatBackgroundDark] = Retool.useStateString({
    name: 'chatBackgroundDark',
    label: 'Dark — Chat Background',
    inspector: 'text',
    description: 'CSS color or formula (e.g., #111827 or {{ colors.bgDark }})',
    initialValue: '#111827'
  })

  // Input border colors (light/dark)
  const [inputBorderColorLight, setInputBorderColorLight] = Retool.useStateString({
    name: 'inputBorderColorLight',
    label: 'Light — Input Border',
    inspector: 'text',
    description: 'CSS color or formula (e.g., #e5e7eb or {{ colors.borderLight }})',
    initialValue: '#e5e7eb'
  })
  const [inputBorderColorDark, setInputBorderColorDark] = Retool.useStateString({
    name: 'inputBorderColorDark',
    label: 'Dark — Input Border',
    inspector: 'text',
    description: 'CSS color or formula (e.g., #374151 or {{ colors.borderDark }})',
    initialValue: '#374151'
  })

  // Send button colors (light/dark)
  const [sendButtonColorLight, setSendButtonColorLight] = Retool.useStateString({
    name: 'sendButtonColorLight',
    label: 'Light — Send Button',
    inspector: 'text',
    description: 'CSS color or formula (e.g., #111827 or {{ colors.primaryLight }})',
    initialValue: '#111827'
  })
  const [sendButtonColorDark, setSendButtonColorDark] = Retool.useStateString({
    name: 'sendButtonColorDark',
    label: 'Dark — Send Button',
    inspector: 'text',
    description: 'CSS color or formula (e.g., #2563eb or {{ colors.primaryDark }})',
    initialValue: '#2563eb'
  })

  // Message bubble background colors (user/AI) for light/dark
  const [userBubbleColorLight, setUserBubbleColorLight] = Retool.useStateString({
    name: 'userBubbleColorLight',
    label: 'Light — User Bubble',
    inspector: 'text',
    description: 'CSS color or formula (e.g., #2563eb or {{ colors.userBubbleLight }})',
    initialValue: '#2563eb'
  })
  const [userBubbleColorDark, setUserBubbleColorDark] = Retool.useStateString({
    name: 'userBubbleColorDark',
    label: 'Dark — User Bubble',
    inspector: 'text',
    description: 'CSS color or formula (e.g., #2563eb or {{ colors.userBubbleDark }})',
    initialValue: '#2563eb'
  })
  const [aiBubbleColorLight, setAiBubbleColorLight] = Retool.useStateString({
    name: 'aiBubbleColorLight',
    label: 'Light — AI Bubble',
    inspector: 'text',
    description: 'CSS color or formula (e.g., #f3f4f6 or {{ colors.aiBubbleLight }})',
    initialValue: '#f3f4f6'
  })
  const [aiBubbleColorDark, setAiBubbleColorDark] = Retool.useStateString({
    name: 'aiBubbleColorDark',
    label: 'Dark — AI Bubble',
    inspector: 'text',
    description: 'CSS color or formula (e.g., #1f2937 or {{ colors.aiBubbleDark }})',
    initialValue: '#1f2937'
  })

  // Optional in-canvas Theme Editor for quick color picking
  const [showThemeEditor] = Retool.useStateBoolean({
    name: 'showThemeEditor',
    label: 'Show Theme Editor',
    inspector: 'checkbox',
    description: 'Displays an inline color picker panel inside the component',
    initialValue: false
  })

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isSending, setIsSending] = useState(false)
  // Keeps a handle to the scroll container so we can auto-scroll to bottom
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const canSend = useMemo(() => {
    return Boolean(endpointUrl && input.trim().length > 0 && !isSending)
  }, [endpointUrl, input, isSending])

  // Resolved colors based on theme mode
  const modeCandidate = (themeModeBinding && typeof themeModeBinding === 'string') ? themeModeBinding : themeMode
  const isDark = String(modeCandidate).toLowerCase() === 'dark'
  const chatBackground = isDark ? (chatBackgroundDark || '#111827') : (chatBackgroundLight || '#ffffff')
  const inputBorderColor = isDark ? (inputBorderColorDark || '#374151') : (inputBorderColorLight || '#e5e7eb')
  const sendButtonColor = isDark ? (sendButtonColorDark || '#2563eb') : (sendButtonColorLight || '#111827')
  const userBubbleBg = isDark ? (userBubbleColorDark || '#2563eb') : (userBubbleColorLight || '#2563eb')
  const aiBubbleBg = isDark ? (aiBubbleColorDark || '#1f2937') : (aiBubbleColorLight || '#f3f4f6')
  const assistantTextColor = isDark ? '#e5e7eb' : '#111827'
  const emptyStateText = isDark ? '#9ca3af' : '#9ca3af'

  // Helpers for color inputs (fallback to a valid hex when current value is a formula)
  const ensureHex = (value: string, fallback: string) => {
    const v = String(value || '').trim()
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) ? v : fallback
  }

  // Sends the user prompt to the configured endpoint and appends the reply.
  // Supports: SSE streams, raw chunked text/JSON frames, and plain JSON/text.
  const onSend = async () => {
    if (!endpointUrl || input.trim().length === 0 || isSending) return

    const userMsg: ChatMessage = {
      id: `${Date.now()}-u`,
      role: 'user',
      content: input.trim()
    }
    setMessages(prev => [...prev, userMsg])
    setInput('')

    setIsSending(true)
    try {
      const payload = {
        input: userMsg.content,
        messages: [...messages, userMsg].map(m => ({ role: m.role, content: m.content }))
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(requestHeaders as Record<string, string>)
      }

      const method = requestMethod === 'GET' ? 'GET' : 'POST'
      const fetchInit: RequestInit = {
        method,
        headers
      }

      let url = endpointUrl
      if (method === 'GET') {
        const query = new URLSearchParams({ input: payload.input })
        url += (endpointUrl.includes('?') ? '&' : '?') + query.toString()
      } else {
        fetchInit.body = JSON.stringify(payload)
      }

      // STREAMING PATHS -----------------------------------------------------
      if (streamingMode === 'sse' || streamingMode === 'auto') {
        if (streamingMode === 'sse') headers['Accept'] = 'text/event-stream'
        const assistantMsg: ChatMessage = { id: `${Date.now()}-a`, role: 'assistant', content: '' }
        setMessages(prev => [...prev, assistantMsg])
        const res = await fetch(url, fetchInit)
        if (!res.ok) throw new Error(`Stream request failed (${res.status})`)
        const ct = res.headers.get('content-type') || ''
        if (ct.includes('text/event-stream')) {
          // Strict SSE format: parse "data:" lines and append to the assistant message
          if (!res.body) throw new Error('No stream body')
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const parts = buffer.split('\n\n')
            buffer = parts.pop() ?? ''
            for (const part of parts) {
              const lines = part.split('\n')
              for (const line of lines) {
                const trimmed = line.trim()
                if (trimmed.startsWith('data:')) {
                  const chunk = trimmed.slice(5).trim()
                  if (chunk === '[DONE]') continue
                  if (chunk) setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: m.content + chunk } : m))
                }
              }
            }
            requestAnimationFrame(() => {
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
            })
          }
        } else if (res.body) {
          // Fallback: raw chunked stream (e.g., JSON-framed pieces like { type: 'item', content })
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            const chunk = decoder.decode(value, { stream: true })
            if (chunk) buffer += chunk
            const { objects, rest } = extractJsonObjectsFromBuffer(buffer)
            buffer = rest
            if (objects.length > 0) {
              for (const obj of objects) {
                if (isStreamItem(obj) && obj && obj.type === 'item' && typeof obj.content === 'string') {
                  const piece = obj.content
                  setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: m.content + piece } : m))
                }
              }
            } else if (chunk) {
              // Not JSON-framed; append raw text
              setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: m.content + chunk } : m))
            }
            requestAnimationFrame(() => {
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
            })
          }
        } else {
          // No stream body; fall back to reading entire text
          const txt = await res.text()
          setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: txt } : m))
        }
      } else {
        // NON-STREAMING PATH -----------------------------------------------
        const res = await fetch(url, fetchInit)
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`)
        }
        const ct = res.headers.get('content-type') || ''
        let replyText = ''
        if (ct.includes('application/json')) {
          const data = await res.json().catch(() => ({} as Record<string, unknown>))
          const key = responseKey && typeof responseKey === 'string' ? responseKey : 'reply'
          const replyVal = data ? (data as Record<string, unknown>)[key] : undefined
          replyText = typeof replyVal === 'string' ? replyVal : ''
        } else {
          replyText = await res.text().catch(() => '')
        }
        const assistantMsg: ChatMessage = {
          id: `${Date.now()}-a`,
          role: 'assistant',
          content: replyText || 'No reply'
        }
        setMessages(prev => [...prev, assistantMsg])
      }
    } catch (e) {
      const assistantMsg: ChatMessage = {
        id: `${Date.now()}-e`,
        role: 'assistant',
        content: 'Error contacting endpoint'
      }
      setMessages(prev => [...prev, assistantMsg])
    } finally {
      setIsSending(false)
      // Scroll to bottom after each request completes
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
      })
    }
  }
  // UI LAYOUT ---------------------------------------------------------------
  // Outer wrapper: insets the card border to avoid container overflow
  return (
    <div style={{ height: '100%', width: '100%', boxSizing: 'border-box', padding: 8, overflow: 'hidden' }}>
      {/* Card container (visible border) */}
      <div style={{
        display: 'flex', flexDirection: 'column', height: '100%', width: '100%', maxHeight: '100%', maxWidth: '100%',
        minHeight: 10, boxSizing: 'border-box',
        fontFamily: 'Inter, system-ui, Arial, sans-serif',
        border: `2px solid ${inputBorderColor}`, borderRadius: 4, overflow: 'hidden', background: chatBackground
      }}>
        {/* Header */}
        {showHeader && (
          <div style={{ padding: 14, borderBottom: `2px solid ${inputBorderColor}`, background: chatBackground }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>AI Agent Chat (v6)</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>Endpoint bound in Inspector</div>
          </div>
        )}

        {/* Optional Theme Editor panel ------------------------------------------------ */}
        {showThemeEditor && (
          <div style={{ padding: 12, borderBottom: `1px solid ${inputBorderColor}`, background: chatBackground }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Theme Colors</div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {/* Theme mode quick toggle */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: '#6b7280' }}>Preview mode:</span>
                <div style={{ display: 'inline-flex', border: `1px solid ${inputBorderColor}`, borderRadius: 6, overflow: 'hidden' }}>
                  <button
                    onClick={() => setThemeMode('Light')}
                    style={{ padding: '4px 8px', background: !isDark ? sendButtonColor : 'transparent', color: !isDark ? '#fff' : assistantTextColor, border: 'none' }}
                  >Light</button>
                  <button
                    onClick={() => setThemeMode('Dark')}
                    style={{ padding: '4px 8px', background: isDark ? sendButtonColor : 'transparent', color: isDark ? '#fff' : assistantTextColor, border: 'none' }}
                  >Dark</button>
                </div>
              </div>

              {/* Light group */}
              <div style={{ minWidth: 260 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Light</div>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <label style={{ fontSize: 12 }}>Chat Background</label>
                  <input type="color" value={ensureHex(chatBackgroundLight, '#ffffff')} onChange={e => setChatBackgroundLight(e.target.value)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <label style={{ fontSize: 12 }}>Input Border</label>
                  <input type="color" value={ensureHex(inputBorderColorLight, '#e5e7eb')} onChange={e => setInputBorderColorLight(e.target.value)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <label style={{ fontSize: 12 }}>Send Button</label>
                  <input type="color" value={ensureHex(sendButtonColorLight, '#111827')} onChange={e => setSendButtonColorLight(e.target.value)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <label style={{ fontSize: 12 }}>User Bubble</label>
                  <input type="color" value={ensureHex(userBubbleColorLight, '#2563eb')} onChange={e => setUserBubbleColorLight(e.target.value)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: 8 }}>
                  <label style={{ fontSize: 12 }}>AI Bubble</label>
                  <input type="color" value={ensureHex(aiBubbleColorLight, '#f3f4f6')} onChange={e => setAiBubbleColorLight(e.target.value)} />
                </div>
              </div>

              {/* Dark group */}
              <div style={{ minWidth: 260 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Dark</div>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <label style={{ fontSize: 12 }}>Chat Background</label>
                  <input type="color" value={ensureHex(chatBackgroundDark, '#111827')} onChange={e => setChatBackgroundDark(e.target.value)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <label style={{ fontSize: 12 }}>Input Border</label>
                  <input type="color" value={ensureHex(inputBorderColorDark, '#374151')} onChange={e => setInputBorderColorDark(e.target.value)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <label style={{ fontSize: 12 }}>Send Button</label>
                  <input type="color" value={ensureHex(sendButtonColorDark, '#2563eb')} onChange={e => setSendButtonColorDark(e.target.value)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <label style={{ fontSize: 12 }}>User Bubble</label>
                  <input type="color" value={ensureHex(userBubbleColorDark, '#2563eb')} onChange={e => setUserBubbleColorDark(e.target.value)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: 8 }}>
                  <label style={{ fontSize: 12 }}>AI Bubble</label>
                  <input type="color" value={ensureHex(aiBubbleColorDark, '#1f2937')} onChange={e => setAiBubbleColorDark(e.target.value)} />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Messages scroller */}
        <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 14, background: chatBackground }}>
          {messages.length === 0 ? (
            <div style={{ color: emptyStateText, fontSize: 14 }}>No messages yet. Type a prompt below.</div>
          ) : (
            messages.map(m => (
              <div key={m.id} style={{
                display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 8
              }}>
                {m.role === 'assistant' && renderMarkdown ? (
                  // Assistant (markdown rendered and sanitized)
                  <div
                    style={{
                      maxWidth: '80%', padding: '8px 12px', borderRadius: 12,
                      background: aiBubbleBg, color: assistantTextColor,
                      fontSize: 14, lineHeight: '20px', wordBreak: 'break-word'
                    }}
                    className="ai-markdown"
                    dangerouslySetInnerHTML={{
                      __html: DOMPurify.sanitize(String(marked.parse(m.content || ''))) || ''
                    }}
                  />
                ) : (
                  // User or non-markdown assistant bubble
                  <div style={{
                    maxWidth: '80%', padding: '8px 12px', borderRadius: 12,
                    background: m.role === 'user' ? userBubbleBg : aiBubbleBg,
                    color: m.role === 'user' ? '#ffffff' : assistantTextColor,
                    fontSize: 14, lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
                  }}>{m.content}</div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Composer */}
        <div style={{ padding: 14, borderTop: `1px solid ${inputBorderColor}`, background: chatBackground }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') onSend() }}
              placeholder={endpointUrl ? 'Type a message…' : 'Set Endpoint URL in Inspector'}
              style={{
                flex: 1, padding: '10px 12px', border: `1px solid ${inputBorderColor}`, borderRadius: 8,
                outline: 'none', fontSize: 14
              }}
              disabled={!endpointUrl || isSending}
            />
            <button
              onClick={onSend}
              disabled={!canSend}
              style={{
                padding: '10px 14px', borderRadius: 8, border: '1px solid transparent',
                background: canSend ? sendButtonColor : '#9ca3af', color: '#ffffff', fontSize: 14,
                cursor: canSend ? 'pointer' : 'not-allowed'
              }}
            >Send</button>
          </div>
        </div>
      </div>
    </div>
  )
}


