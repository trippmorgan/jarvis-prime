import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DeliveryClient } from '../delivery/delivery-client.js'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'

// ─── Test setup ──────────────────────────────────────────────────────────────

const GATEWAY_URL = 'https://openclaw.test'
const GATEWAY_TOKEN = 'test-token-abc123'

let spoolDir: string

function makeClient(): DeliveryClient {
  return new DeliveryClient({
    gatewayUrl: GATEWAY_URL,
    gatewayToken: GATEWAY_TOKEN,
    deliveryQueueDir: spoolDir,
  })
}

beforeEach(() => {
  spoolDir = mkdtempSync(join(tmpdir(), 'delivery-test-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(spoolDir, { recursive: true, force: true })
})

// ─── deliver() ───────────────────────────────────────────────────────────────

describe('DeliveryClient.deliver', () => {
  it('POSTs correct payload with Bearer auth to gateway', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    })
    vi.stubGlobal('fetch', mockFetch)

    const client = makeClient()
    const result = await client.deliver('12345', 'Hello Tripp', { parseMode: 'Markdown' })

    expect(result).toBe(true)
    expect(mockFetch).toHaveBeenCalledOnce()

    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('https://openclaw.test/api/jarvis/deliver')
    expect(options.method).toBe('POST')
    expect(options.headers['Authorization']).toBe('Bearer test-token-abc123')
    expect(options.headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(options.body)
    expect(body).toEqual({
      chat_id: '12345',
      text: 'Hello Tripp',
      parse_mode: 'Markdown',
    })
  })

  it('spools to delivery queue on HTTP error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve('Bad Gateway'),
    })
    vi.stubGlobal('fetch', mockFetch)

    const client = makeClient()
    const result = await client.deliver('12345', 'This will fail')

    expect(result).toBe(false)

    // Check spool file was written
    const files = readdirSync(spoolDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/\.json$/)

    const spooled = JSON.parse(readFileSync(join(spoolDir, files[0]), 'utf-8'))
    expect(spooled.chatId).toBe('12345')
    expect(spooled.text).toBe('This will fail')
    expect(spooled.error).toContain('502')
    expect(spooled.spooledAt).toBeTruthy()
  })

  it('spools on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', mockFetch)

    const client = makeClient()
    const result = await client.deliver('12345', 'Network down')

    expect(result).toBe(false)

    const files = readdirSync(spoolDir)
    expect(files).toHaveLength(1)

    const spooled = JSON.parse(readFileSync(join(spoolDir, files[0]), 'utf-8'))
    expect(spooled.error).toBe('ECONNREFUSED')
  })
})

// ─── splitMessage() ──────────────────────────────────────────────────────────

describe('DeliveryClient.splitMessage', () => {
  it('returns short message as single-element array', () => {
    const client = makeClient()
    const result = client.splitMessage('Hello there')

    expect(result).toEqual(['Hello there'])
  })

  it('splits at 4096 char boundary', () => {
    const client = makeClient()
    // Create a message that's exactly 8192 chars with no newlines
    const longText = 'A'.repeat(8192)
    const result = client.splitMessage(longText)

    expect(result).toHaveLength(2)
    expect(result[0]).toHaveLength(4096)
    expect(result[1]).toHaveLength(4096)
  })

  it('splits at newline boundaries when possible', () => {
    const client = makeClient()
    // Use a small maxLen for easier testing
    const text = 'Line one\nLine two\nLine three\nLine four'
    const result = client.splitMessage(text, 20)

    // "Line one\nLine two\n" = 19 chars — fits in first chunk
    // "Line three\nLine four" = 20 chars — fits in second chunk
    expect(result).toHaveLength(2)
    expect(result[0]).toBe('Line one\nLine two\n')
    expect(result[1]).toBe('Line three\nLine four')
  })

  it('returns single-element array for exactly-at-limit message', () => {
    const client = makeClient()
    const text = 'X'.repeat(4096)
    const result = client.splitMessage(text)

    expect(result).toEqual([text])
  })

  it('handles custom maxLen parameter', () => {
    const client = makeClient()
    const text = 'ABCDEFGHIJ' // 10 chars
    const result = client.splitMessage(text, 5)

    expect(result).toEqual(['ABCDE', 'FGHIJ'])
  })
})
