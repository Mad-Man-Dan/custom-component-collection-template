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
function extractJsonObjectsFromBuffer(buffer: string): { objects: any[]; rest: string } {
  const objects: any[] = []
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
          const obj = JSON.parse(jsonStr)
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

export const AIAgentChatV6: FC = () => {
  Retool.useComponentSettings({ defaultWidth: 8, defaultHeight: 16 })

  const [endpointUrl] = Retool.useStateString({
    name: 'endpointUrl',
    label: 'Endpoint URL',
    inspector: 'text'
  })

  const [requestMethod] = Retool.useStateEnumeration({
    name: 'requestMethod',
    enumDefinition: ['POST', 'GET'],
    initialValue: 'POST',
    inspector: 'select',
    label: 'Method'
  })

  const [requestHeaders] = Retool.useStateObject({
    name: 'requestHeaders',
    inspector: 'hidden'
  })

  const [responseKey] = Retool.useStateString({
    name: 'responseKey',
    label: 'Response Key',
    inspector: 'text',
    initialValue: 'reply'
  })

  const [streamingMode] = Retool.useStateEnumeration({
    name: 'streamingMode',
    enumDefinition: ['none', 'sse', 'auto'],
    initialValue: 'none',
    inspector: 'select',
    label: 'Streaming'
  })

  const [renderMarkdown] = Retool.useStateBoolean({
    name: 'renderMarkdown',
    label: 'Render Markdown',
    inspector: 'checkbox',
    initialValue: true
  })

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isSending, setIsSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const canSend = useMemo(() => {
    return Boolean(endpointUrl && input.trim().length > 0 && !isSending)
  }, [endpointUrl, input, isSending])

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

      if (streamingMode === 'sse' || streamingMode === 'auto') {
        if (streamingMode === 'sse') headers['Accept'] = 'text/event-stream'
        const assistantMsg: ChatMessage = { id: `${Date.now()}-a`, role: 'assistant', content: '' }
        setMessages(prev => [...prev, assistantMsg])
        const res = await fetch(url, fetchInit)
        if (!res.ok) throw new Error(`Stream request failed (${res.status})`)
        const ct = res.headers.get('content-type') || ''
        if (ct.includes('text/event-stream')) {
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
          // Fallback: raw chunked stream (handle JSON-framed chunks from n8n or plain text)
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
                if (obj && obj.type === 'item' && typeof obj.content === 'string') {
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
          // No stream body, fall back to text
          const txt = await res.text()
          setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: txt } : m))
        }
      } else {
        const res = await fetch(url, fetchInit)
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`)
        }
        const ct = res.headers.get('content-type') || ''
        let replyText = ''
        if (ct.includes('application/json')) {
          const data = await res.json().catch(() => ({})) as Record<string, unknown>
          const key = responseKey && typeof responseKey === 'string' ? responseKey : 'reply'
          const replyVal = data ? (data as any)[key] : undefined
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
      // scroll to bottom
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
      })
    }
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', width: '100%',
      fontFamily: 'Inter, system-ui, Arial, sans-serif',
      border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden'
    }}>
      <div style={{ padding: 12, borderBottom: '1px solid #e5e7eb', background: '#fafafa' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>AI Agent Chat (v6)</div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>Endpoint bound in Inspector</div>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 12, background: '#ffffff' }}>
        {messages.length === 0 ? (
          <div style={{ color: '#9ca3af', fontSize: 14 }}>No messages yet. Type a prompt below.</div>
        ) : (
          messages.map(m => (
            <div key={m.id} style={{
              display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 8
            }}>
              {m.role === 'assistant' && renderMarkdown ? (
                <div
                  style={{
                    maxWidth: '80%', padding: '8px 12px', borderRadius: 12,
                    background: '#f3f4f6', color: '#111827',
                    fontSize: 14, lineHeight: '20px', wordBreak: 'break-word'
                  }}
                  className="ai-markdown"
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(String(marked.parse(m.content || ''))) || ''
                  }}
                />
              ) : (
                <div style={{
                  maxWidth: '80%', padding: '8px 12px', borderRadius: 12,
                  background: m.role === 'user' ? '#2563eb' : '#f3f4f6',
                  color: m.role === 'user' ? '#ffffff' : '#111827',
                  fontSize: 14, lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
                }}>{m.content}</div>
              )}
            </div>
          ))
        )}
      </div>

      <div style={{ padding: 12, borderTop: '1px solid #e5e7eb', background: '#fafafa' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onSend() }}
            placeholder={endpointUrl ? 'Type a message…' : 'Set Endpoint URL in Inspector'}
            style={{
              flex: 1, padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8,
              outline: 'none', fontSize: 14
            }}
            disabled={!endpointUrl || isSending}
          />
          <button
            onClick={onSend}
            disabled={!canSend}
            style={{
              padding: '10px 14px', borderRadius: 8, border: '1px solid transparent',
              background: canSend ? '#111827' : '#9ca3af', color: '#ffffff', fontSize: 14,
              cursor: canSend ? 'pointer' : 'not-allowed'
            }}
          >Send</button>
        </div>
      </div>
    </div>
  )
}


