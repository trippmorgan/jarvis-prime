import type { FastifyBaseLogger } from 'fastify'
import { spawnClaude } from '../claude/spawner.js'
import { MessageQueue } from '../queue/message-queue.js'
import type { QueueMessage } from '../queue/types.js'
import { scanText } from '../phi/scanner.js'
import { ConversationHistory } from '../context/history.js'
import { PromptBuilder } from '../context/prompt-builder.js'

const ACK_DELAY_MS = 8_000
const HARD_TIMEOUT_MS = 300_000
const TELEGRAM_MAX_LENGTH = 4096
const DEFAULT_HISTORY_PATH = '/home/tripp/.openclaw/workspace/jarvis-prime/.data/conversation-history.jsonl'

export interface DeliverFn {
  (chatId: string, text: string): Promise<void>
}

export interface ProcessorConfig {
  claudePath: string
  claudeModel: string
  claudeTimeoutMs: number
  historyPath?: string
}

export class MessageProcessor {
  private readonly queue: MessageQueue
  private readonly deliver: DeliverFn
  private readonly config: ProcessorConfig
  private readonly log: FastifyBaseLogger
  private readonly history: ConversationHistory
  private readonly promptBuilder: PromptBuilder

  constructor(config: ProcessorConfig, deliver: DeliverFn, log: FastifyBaseLogger) {
    this.config = config
    this.deliver = deliver
    this.log = log
    this.history = new ConversationHistory(config.historyPath ?? DEFAULT_HISTORY_PATH)
    this.promptBuilder = new PromptBuilder(this.history)
    this.queue = new MessageQueue((msg) => this.process(msg))

    this.queue.on('message', (event) => {
      if (event.type === 'error') {
        this.log.error({ messageId: event.message.id, error: event.error }, 'Queue processing error')
      }
    })
  }

  submit(chatId: string, text: string, userId: string): { blocked: boolean; messageId?: string; position?: number; reasons?: string[] } {
    const phiResult = scanText(text)
    if (phiResult.blocked) {
      this.log.warn({ chatId, reasons: phiResult.reasons }, 'PHI detected — message blocked')
      this.deliver(chatId, 'PHI detected — message blocked for security. Please use the clinical pipeline for patient data.').catch(() => {})
      return { blocked: true, reasons: phiResult.reasons }
    }

    const receipt = this.queue.enqueue({ chatId, text, userId })

    if (receipt.position > 1) {
      this.deliver(chatId, `Queued (position ${receipt.position}). I'll get to this shortly.`).catch(() => {})
    }

    return { blocked: false, messageId: receipt.id, position: receipt.position }
  }

  getQueueLength(): number {
    return this.queue.getQueueLength()
  }

  isProcessing(): boolean {
    return this.queue.isProcessing()
  }

  private async process(msg: QueueMessage): Promise<string> {
    this.history.append('user', msg.text)

    let ackSent = false
    const ackTimer = setTimeout(async () => {
      ackSent = true
      await this.deliver(msg.chatId, 'Working on it...').catch(() => {})
    }, ACK_DELAY_MS)

    try {
      const prompt = this.promptBuilder.build(msg.text)

      const result = await spawnClaude(prompt, {
        claudePath: this.config.claudePath,
        model: this.config.claudeModel,
        timeoutMs: Math.min(this.config.claudeTimeoutMs, HARD_TIMEOUT_MS),
      })

      clearTimeout(ackTimer)

      if (result.timedOut) {
        const errorMsg = 'Request timed out. The task was too complex for a single pass — try breaking it into smaller steps.'
        await this.deliverChunked(msg.chatId, errorMsg)
        return errorMsg
      }

      if (result.exitCode !== 0 && !result.output.trim()) {
        const errorMsg = `Claude encountered an error (exit ${result.exitCode}). ${result.stderr.slice(0, 200)}`
        this.log.error({ exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) }, 'Claude CLI error')
        await this.deliverChunked(msg.chatId, errorMsg)
        return errorMsg
      }

      const output = result.output.trim() || '(No output)'
      this.history.append('assistant', output)
      await this.deliverChunked(msg.chatId, output)

      this.log.info({
        messageId: msg.id,
        durationMs: result.durationMs,
        outputLen: output.length,
        ackSent,
      }, 'Message processed')

      return output
    } catch (err) {
      clearTimeout(ackTimer)
      const errorMsg = `Internal error: ${err instanceof Error ? err.message : String(err)}`
      this.log.error({ messageId: msg.id, error: errorMsg }, 'Processing failed')
      await this.deliver(msg.chatId, errorMsg).catch(() => {})
      return errorMsg
    }
  }

  private async deliverChunked(chatId: string, text: string): Promise<void> {
    const chunks = splitMessage(text, TELEGRAM_MAX_LENGTH)
    for (const chunk of chunks) {
      await this.deliver(chatId, chunk)
    }
  }
}

export function splitMessage(text: string, maxLen: number = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }

    const slice = remaining.slice(0, maxLen)
    const lastNewline = slice.lastIndexOf('\n')
    const splitAt = lastNewline > 0 ? lastNewline + 1 : maxLen

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }

  return chunks
}
