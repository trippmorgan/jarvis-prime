export interface QueueMessage {
  id: string
  chatId: string
  text: string
  userId: string
  enqueuedAt: number
  /** Per-turn ephemeral context appended to the prompt for THIS turn only.
   *  NEVER persisted to history. Used for the Voldemort vision lane: the
   *  qwen3-vl description goes here so Claude sees it on this turn but it
   *  doesn't pollute future turns (Claude was conflating two unrelated
   *  photos because their descriptions sat in his rolling history). */
  extraContext?: string
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
