import crypto from 'node:crypto'
import type { QueueMessage, QueueReceipt, QueueEvent } from './types.js'

type EventHandler = (event: QueueEvent) => void

export class MessageQueue {
  private queue: QueueMessage[] = []
  private processing = false
  private processor: (msg: QueueMessage) => Promise<string>
  private handlers: EventHandler[] = []

  constructor(processor: (msg: QueueMessage) => Promise<string>) {
    this.processor = processor
  }

  enqueue(msg: Omit<QueueMessage, 'id' | 'enqueuedAt'>): QueueReceipt {
    const message: QueueMessage = {
      ...msg,
      id: crypto.randomUUID(),
      enqueuedAt: Date.now(),
    }

    this.queue.push(message)

    const receipt: QueueReceipt = {
      id: message.id,
      position: this.queue.length,
      queueLength: this.queue.length,
    }

    // Kick off drain if not already running
    if (!this.processing) {
      this.drain()
    }

    return receipt
  }

  on(_event: 'message', handler: EventHandler): void {
    this.handlers.push(handler)
  }

  getQueueLength(): number {
    return this.queue.length
  }

  isProcessing(): boolean {
    return this.processing
  }

  private emit(event: QueueEvent): void {
    for (const handler of this.handlers) {
      handler(event)
    }
  }

  private async drain(): Promise<void> {
    this.processing = true

    while (this.queue.length > 0) {
      const message = this.queue.shift()!

      this.emit({ type: 'processing', message })

      try {
        const result = await this.processor(message)
        this.emit({ type: 'complete', message, result })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        this.emit({ type: 'error', message, error })
      }
    }

    this.processing = false
  }
}
