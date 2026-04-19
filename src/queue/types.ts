export interface QueueMessage {
  id: string
  chatId: string
  text: string
  userId: string
  enqueuedAt: number
}

export interface QueueReceipt {
  id: string
  position: number
  queueLength: number
}

export type QueueEvent =
  | { type: 'processing'; message: QueueMessage }
  | { type: 'complete'; message: QueueMessage; result: string }
  | { type: 'error'; message: QueueMessage; error: string }
