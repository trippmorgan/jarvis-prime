import { describe, it, expect, vi } from 'vitest'
import { MessageQueue } from '../queue/message-queue.js'
import type { QueueEvent, QueueMessage } from '../queue/types.js'

function makeMsg(text: string): Omit<QueueMessage, 'id' | 'enqueuedAt'> {
  return { chatId: 'chat-1', text, userId: 'user-1' }
}

/**
 * Helper: create a queue, enqueue messages, wait for all to complete/error.
 * Returns collected events in order.
 */
function collectEvents(
  processor: (msg: QueueMessage) => Promise<string>,
  messages: Omit<QueueMessage, 'id' | 'enqueuedAt'>[],
): Promise<QueueEvent[]> {
  return new Promise((resolve) => {
    const events: QueueEvent[] = []
    const queue = new MessageQueue(processor)

    let completed = 0
    queue.on('message', (event) => {
      events.push(event)
      if (event.type === 'complete' || event.type === 'error') {
        completed++
        if (completed === messages.length) {
          resolve(events)
        }
      }
    })

    for (const msg of messages) {
      queue.enqueue(msg)
    }
  })
}

describe('MessageQueue', () => {
  it('processes 3 messages in FIFO order', async () => {
    const order: string[] = []
    const processor = async (msg: QueueMessage) => {
      order.push(msg.text)
      return `done: ${msg.text}`
    }

    const events = await collectEvents(processor, [
      makeMsg('first'),
      makeMsg('second'),
      makeMsg('third'),
    ])

    expect(order).toEqual(['first', 'second', 'third'])

    const completes = events.filter((e) => e.type === 'complete')
    expect(completes).toHaveLength(3)
    expect((completes[0] as Extract<QueueEvent, { type: 'complete' }>).result).toBe('done: first')
  })

  it('only processes one message at a time', async () => {
    let concurrent = 0
    let maxConcurrent = 0

    const processor = async (msg: QueueMessage) => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      // Yield to event loop so other messages could theoretically start
      await new Promise((r) => setTimeout(r, 10))
      concurrent--
      return msg.text
    }

    await collectEvents(processor, [
      makeMsg('a'),
      makeMsg('b'),
      makeMsg('c'),
    ])

    expect(maxConcurrent).toBe(1)
  })

  it('error in processor does not block the queue', async () => {
    const processor = async (msg: QueueMessage) => {
      if (msg.text === 'fail') {
        throw new Error('boom')
      }
      return `ok: ${msg.text}`
    }

    const events = await collectEvents(processor, [
      makeMsg('before'),
      makeMsg('fail'),
      makeMsg('after'),
    ])

    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect((errors[0] as Extract<QueueEvent, { type: 'error' }>).error).toBe('boom')

    const completes = events.filter((e) => e.type === 'complete')
    expect(completes).toHaveLength(2)
    expect((completes[1] as Extract<QueueEvent, { type: 'complete' }>).message.text).toBe('after')
  })

  it('receipt returns correct position', () => {
    // Use a processor that never resolves so messages stay queued
    const processor = () => new Promise<string>(() => {})

    const queue = new MessageQueue(processor)

    const r1 = queue.enqueue(makeMsg('one'))
    const r2 = queue.enqueue(makeMsg('two'))
    const r3 = queue.enqueue(makeMsg('three'))

    // r1 triggers drain(), which synchronously shifts r1 off the queue
    // and awaits the processor. So r1's receipt captured position 1, length 1
    // at the moment of enqueue (before drain ran).
    expect(r1.position).toBe(1)
    expect(r1.queueLength).toBe(1)

    // After drain started, r1 was shifted off. r2 is now position 1 in a queue of 1.
    expect(r2.position).toBe(1)
    expect(r2.queueLength).toBe(1)

    // r3 joins behind r2. Position 2 in a queue of 2.
    expect(r3.position).toBe(2)
    expect(r3.queueLength).toBe(2)

    expect(queue.isProcessing()).toBe(true)
  })
})
