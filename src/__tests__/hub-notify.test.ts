import { describe, it, expect, vi } from 'vitest'
import { hubNotifyEvent, notifyHub } from '../bridge/hub-notify.js'

const env = { kernelUrl: 'http://kernel.test:3000/', kernelToken: 'tok', node: 'voldemort', from: 'frank' }

describe('notify_hub — reaching Jarvis Prime on the room mesh (2026-10-20)', () => {
  it('addresses prime by default on channel room with frank + recipients as members', () => {
    const b = hubNotifyEvent({ message: '  Grizzard clone ready at ~/grizzard  ' }, env)
    expect('error' in b).toBe(false)
    if ('error' in b) return
    expect(b.to).toEqual(['prime'])
    expect(b.body).toMatchObject({ body: 'Grizzard clone ready at ~/grizzard', severity: 'info', node: 'voldemort',
      metadata: { channel: 'room', chat_id: 'room-frank-prime', from: 'frank', members: ['frank', 'prime'], mentions: ['prime'] } })
    expect(b.body).not.toHaveProperty('agent_id')
  })
  it('normalises recipients, never lists frank twice, rejects junk ids and empty messages', () => {
    const b = hubNotifyEvent({ message: 'hi', to: ['Prime', 'argus', 'frank', 'prime'] }, env)
    if ('error' in b) throw new Error(b.error)
    expect(b.to).toEqual(['prime', 'argus', 'frank'])
    expect((b.body.metadata as { members: string[] }).members).toEqual(['frank', 'prime', 'argus'])
    expect(hubNotifyEvent({ message: 'hi', to: ['../etc'] }, env)).toHaveProperty('error')
    expect(hubNotifyEvent({ message: '   ' }, env)).toHaveProperty('error')
  })
  it('posts with the bearer to /api/v1/registry/events and reports the event id', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { id: 91234 } }), { status: 201 }))
    const r = await notifyHub({ message: 'done' }, env, f)
    expect(r).toMatchObject({ ok: true, eventId: 91234, to: ['prime'] })
    expect(r.text).toMatch(/delivered to prime .* event 91234/)
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://kernel.test:3000/api/v1/registry/events')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body as string).metadata.mentions).toEqual(['prime'])
  })
  it('never throws: HTTP errors, network errors and a missing token come back as honest tool text', async () => {
    expect((await notifyHub({ message: 'x' }, env, vi.fn(async () => new Response('{"error":"AUTH_FAILED"}', { status: 401 })))).text).toMatch(/kernel HTTP 401/)
    expect((await notifyHub({ message: 'x' }, env, vi.fn(async () => { throw new Error('ECONNREFUSED') }))).text).toMatch(/ECONNREFUSED/)
    expect((await notifyHub({ message: 'x' }, { ...env, kernelToken: undefined }, vi.fn())).text).toMatch(/no KERNEL_TOKEN/)
  })
})
