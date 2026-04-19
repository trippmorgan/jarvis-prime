import type { FastifyBaseLogger } from 'fastify'
import { spawnClaude } from '../claude/spawner.js'
import { MessageQueue } from '../queue/message-queue.js'
import type { QueueMessage } from '../queue/types.js'
import { scanText } from '../phi/scanner.js'
import { ConversationHistory, type HistoryEntry } from '../context/history.js'
import { PromptBuilder } from '../context/prompt-builder.js'
import { classifyMessage } from '../brain/router.js'
import { corpusCallosum } from '../brain/corpus-callosum.js'
import { LeftHemisphereClient } from '../brain/left-hemisphere.js'
import { RightHemisphereClient } from '../brain/right-hemisphere.js'
import {
  LeftHemisphereError,
  RightHemisphereError,
  IntegrationError,
  type BrainResult,
} from '../brain/types.js'

const ACK_DELAY_MS = 8_000
const HARD_TIMEOUT_MS = 300_000
const TELEGRAM_MAX_LENGTH = 4096
const DEFAULT_HISTORY_PATH = '/home/tripp/.openclaw/workspace/jarvis-prime/.data/conversation-history.jsonl'

export interface DeliverFn {
  (chatId: string, text: string): Promise<void>
}

/**
 * Orchestrator injection shape. The processor wraps corpusCallosum() in a
 * closure that pre-binds the hemisphere clients and logger so tests can swap
 * in a fake without touching real LLMs.
 */
export type OrchestratorFn = (input: {
  userMsg: string
  history: HistoryEntry[]
  basePrompt: string
}) => Promise<BrainResult>

export interface ProcessorConfig {
  claudePath: string
  claudeModel: string
  claudeTimeoutMs: number
  historyPath?: string
  /** Dual-brain kill-switch. When false, every message takes the single-brain path. */
  corpusCallosumEnabled: boolean
  gatewayUrl: string
  gatewayToken: string
  rightModel: string
  corpusCallosumTimeoutMs: number
  /** When true, force clinical bypass for all messages (explicit caller override). */
  clinicalOverride?: boolean
  /** Optional orchestrator injection — defaults to a closure over the real corpusCallosum(). */
  orchestrator?: OrchestratorFn
}

export class MessageProcessor {
  private readonly queue: MessageQueue
  private readonly deliver: DeliverFn
  private readonly config: ProcessorConfig
  private readonly log: FastifyBaseLogger
  private readonly history: ConversationHistory
  private readonly promptBuilder: PromptBuilder
  private readonly orchestrator?: OrchestratorFn

  constructor(config: ProcessorConfig, deliver: DeliverFn, log: FastifyBaseLogger) {
    this.config = config
    this.deliver = deliver
    this.log = log
    this.history = new ConversationHistory(config.historyPath ?? DEFAULT_HISTORY_PATH)
    this.promptBuilder = new PromptBuilder(this.history)
    this.queue = new MessageQueue((msg) => this.process(msg))

    // Build orchestrator (if dual-brain enabled). Respects injected override for tests.
    if (config.orchestrator) {
      this.orchestrator = config.orchestrator
    } else if (config.corpusCallosumEnabled) {
      const leftClient = new LeftHemisphereClient({
        claudePath: config.claudePath,
        model: config.claudeModel,
        logger: this.log,
      })
      const rightClient = new RightHemisphereClient({
        gatewayUrl: config.gatewayUrl,
        gatewayToken: config.gatewayToken,
        model: config.rightModel,
        logger: this.log,
      })
      const timeoutMs = config.corpusCallosumTimeoutMs
      this.orchestrator = async (input) =>
        corpusCallosum(
          {
            left: leftClient,
            right: rightClient,
            basePrompt: input.basePrompt,
            timeoutMs,
            logger: this.log,
          },
          { userMsg: input.userMsg, history: input.history },
        )
    }

    this.queue.on('message', (event) => {
      if (event.type === 'error') {
        this.log.error({ messageId: event.message.id, error: event.error }, 'Queue processing error')
      }
    })
  }

  submit(chatId: string, text: string, userId: string): { blocked: boolean; messageId?: string; position?: number; reasons?: string[] } {
    this.log.info(
      {
        event: 'message_inbound',
        chatId,
        userId,
        textLength: text.length,
        timestamp: Date.now(),
      },
      'message inbound',
    )

    const phiResult = scanText(text)
    if (phiResult.blocked) {
      this.log.warn(
        {
          event: 'phi_scan',
          chatId,
          blocked: true,
          reasonsCount: phiResult.reasons.length,
          reasons: phiResult.reasons,
        },
        'PHI detected — message blocked',
      )
      this.deliver(chatId, 'PHI detected — message blocked for security. Please use the clinical pipeline for patient data.').catch(() => {})
      return { blocked: true, reasons: phiResult.reasons }
    }

    this.log.info(
      {
        event: 'phi_scan',
        chatId,
        blocked: false,
        reasonsCount: 0,
      },
      'phi scan clear',
    )

    const receipt = this.queue.enqueue({ chatId, text, userId })

    this.log.info(
      {
        event: 'message_enqueued',
        messageId: receipt.id,
        position: receipt.position,
        chatId,
      },
      'message enqueued',
    )

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
    const processStart = Date.now()
    this.log.info(
      {
        event: 'process_start',
        messageId: msg.id,
        queueLength: this.queue.getQueueLength(),
      },
      'process start',
    )

    this.history.append('user', msg.text)
    this.log.info(
      {
        event: 'history_user_appended',
        messageId: msg.id,
        userContentLength: msg.text.length,
      },
      'history user appended',
    )

    const classification = classifyMessage({
      text: msg.text,
      userId: msg.userId,
      clinicalOverride: this.config.clinicalOverride === true,
    })

    this.log.info(
      {
        event: 'classification',
        messageId: msg.id,
        kind: classification.kind,
      },
      'classification',
    )

    const useDualBrain =
      classification.kind === 'natural' &&
      this.config.corpusCallosumEnabled &&
      this.orchestrator !== undefined

    if (useDualBrain) {
      this.log.info({ event: 'route_dual_brain', messageId: msg.id }, 'routing via dual-brain')
      return this.processDualBrain(msg, processStart)
    }

    this.log.info(
      { event: 'route_bypass', kind: classification.kind, messageId: msg.id },
      'routing via single-brain bypass',
    )
    return this.processSingleBrain(msg, processStart)
  }

  private async processSingleBrain(msg: QueueMessage, processStart: number): Promise<string> {
    let ackSent = false
    const ackTimer = setTimeout(async () => {
      ackSent = true
      this.log.info(
        { event: 'ack_sent', messageId: msg.id, ackDelayMs: ACK_DELAY_MS },
        'ack sent',
      )
      await this.deliver(msg.chatId, 'Working on it...').catch(() => {})
    }, ACK_DELAY_MS)

    try {
      const prompt = this.promptBuilder.build(msg.text)
      this.log.info(
        {
          event: 'prompt_built',
          messageId: msg.id,
          promptLength: prompt.length,
          historyEntriesUsed: this.history.getRecent(10).length,
        },
        'prompt built',
      )

      this.log.info(
        {
          event: 'single_brain_call_start',
          messageId: msg.id,
        },
        'single-brain call start',
      )

      const result = await spawnClaude(prompt, {
        claudePath: this.config.claudePath,
        model: this.config.claudeModel,
        timeoutMs: Math.min(this.config.claudeTimeoutMs, HARD_TIMEOUT_MS),
      })

      this.log.info(
        {
          event: 'single_brain_call_end',
          messageId: msg.id,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          exitCode: result.exitCode,
          outputLength: result.output.length,
          stderrLength: result.stderr.length,
        },
        'single-brain call end',
      )

      clearTimeout(ackTimer)

      if (result.timedOut) {
        const errorMsg = 'Request timed out. The task was too complex for a single pass — try breaking it into smaller steps.'
        await this.deliverWithLogging(msg.id, msg.chatId, errorMsg, 'error')
        this.log.info(
          {
            event: 'process_end',
            messageId: msg.id,
            totalPipelineMs: Date.now() - processStart,
            path: 'single_brain',
            outcome: 'timeout',
          },
          'process end',
        )
        return errorMsg
      }

      if (result.exitCode !== 0 && !result.output.trim()) {
        const errorMsg = `Claude encountered an error (exit ${result.exitCode}). ${result.stderr.slice(0, 200)}`
        this.log.error({ exitCode: result.exitCode, stderrLength: result.stderr.length }, 'Claude CLI error')
        await this.deliverWithLogging(msg.id, msg.chatId, errorMsg, 'error')
        this.log.info(
          {
            event: 'process_end',
            messageId: msg.id,
            totalPipelineMs: Date.now() - processStart,
            path: 'single_brain',
            outcome: 'error',
          },
          'process end',
        )
        return errorMsg
      }

      const output = result.output.trim() || '(No output)'
      this.history.append('assistant', output)
      this.log.info(
        {
          event: 'history_assistant_appended',
          messageId: msg.id,
          assistantContentLength: output.length,
        },
        'history assistant appended',
      )
      await this.deliverWithLogging(msg.id, msg.chatId, output, 'success')

      this.log.info({
        messageId: msg.id,
        durationMs: result.durationMs,
        outputLen: output.length,
        ackSent,
      }, 'Message processed')

      this.log.info(
        {
          event: 'process_end',
          messageId: msg.id,
          totalPipelineMs: Date.now() - processStart,
          path: 'single_brain',
          outcome: 'success',
        },
        'process end',
      )

      return output
    } catch (err) {
      clearTimeout(ackTimer)
      const errorMsg = `Internal error: ${err instanceof Error ? err.message : String(err)}`
      this.log.error({ messageId: msg.id, error: errorMsg }, 'Processing failed')
      await this.deliver(msg.chatId, errorMsg).catch(() => {})
      this.log.info(
        {
          event: 'process_end',
          messageId: msg.id,
          totalPipelineMs: Date.now() - processStart,
          path: 'single_brain',
          outcome: 'error',
        },
        'process end',
      )
      return errorMsg
    }
  }

  private async processDualBrain(msg: QueueMessage, processStart: number): Promise<string> {
    let ackSent = false
    const ackTimer = setTimeout(async () => {
      ackSent = true
      this.log.info(
        { event: 'ack_sent', messageId: msg.id, ackDelayMs: ACK_DELAY_MS },
        'ack sent',
      )
      await this.deliver(msg.chatId, 'Working on it...').catch(() => {})
    }, ACK_DELAY_MS)

    try {
      // Note: basePrompt already includes the formatted "Recent conversation"
      // block from PromptBuilder plus the current user message. The orchestrator
      // also formats history/userMsg in its own affordance/integration builders.
      // v1 accepts this redundancy — stripping it would require surgery inside
      // PromptBuilder which lives on the single-brain path.
      const basePrompt = this.promptBuilder.build(msg.text)
      const history = this.history.getRecent(10)

      this.log.info(
        {
          event: 'prompt_built',
          messageId: msg.id,
          promptLength: basePrompt.length,
          historyEntriesUsed: history.length,
        },
        'prompt built',
      )

      this.log.info(
        {
          event: 'dual_brain_call_start',
          messageId: msg.id,
          timeoutMs: this.config.corpusCallosumTimeoutMs,
        },
        'dual-brain call start',
      )

      const result = await this.orchestrator!({
        userMsg: msg.text,
        history,
        basePrompt,
      })

      clearTimeout(ackTimer)

      const output = result.finalText.trim() || '(No output)'
      this.history.append('assistant', result.finalText)
      this.log.info(
        {
          event: 'history_assistant_appended',
          messageId: msg.id,
          assistantContentLength: result.finalText.length,
        },
        'history assistant appended',
      )
      await this.deliverWithLogging(msg.id, msg.chatId, output, 'success')

      this.log.info(
        {
          event: 'dual_brain_done',
          messageId: msg.id,
          totalMs: result.trace.totalMs,
          integrationMs: result.trace.integrationMs,
          outputLen: output.length,
          ackSent,
        },
        'dual-brain processed',
      )

      this.log.info(
        {
          event: 'process_end',
          messageId: msg.id,
          totalPipelineMs: Date.now() - processStart,
          path: 'dual_brain',
          outcome: 'success',
        },
        'process end',
      )

      return output
    } catch (err) {
      clearTimeout(ackTimer)

      if (err instanceof LeftHemisphereError) {
        const errorMsg = `Left hemisphere failed: ${err.message}`
        this.log.error(
          { event: 'dual_brain_failed', hemisphere: 'left', messageId: msg.id, error: err.message },
          'dual-brain failed',
        )
        await this.deliverWithLogging(msg.id, msg.chatId, errorMsg, 'error').catch(() => {})
        this.log.info(
          {
            event: 'process_end',
            messageId: msg.id,
            totalPipelineMs: Date.now() - processStart,
            path: 'dual_brain',
            outcome: 'error',
          },
          'process end',
        )
        return errorMsg
      }

      if (err instanceof RightHemisphereError) {
        const errorMsg = `Right hemisphere failed: ${err.message}`
        this.log.error(
          { event: 'dual_brain_failed', hemisphere: 'right', messageId: msg.id, error: err.message },
          'dual-brain failed',
        )
        await this.deliverWithLogging(msg.id, msg.chatId, errorMsg, 'error').catch(() => {})
        this.log.info(
          {
            event: 'process_end',
            messageId: msg.id,
            totalPipelineMs: Date.now() - processStart,
            path: 'dual_brain',
            outcome: 'error',
          },
          'process end',
        )
        return errorMsg
      }

      if (err instanceof IntegrationError) {
        const errorMsg = `Integration failed after retry: ${err.message}`
        this.log.error(
          { event: 'dual_brain_failed', hemisphere: 'integration', messageId: msg.id, error: err.message },
          'dual-brain failed',
        )
        await this.deliverWithLogging(msg.id, msg.chatId, errorMsg, 'error').catch(() => {})
        this.log.info(
          {
            event: 'process_end',
            messageId: msg.id,
            totalPipelineMs: Date.now() - processStart,
            path: 'dual_brain',
            outcome: 'error',
          },
          'process end',
        )
        return errorMsg
      }

      const errorMsg = `Internal error: ${err instanceof Error ? err.message : String(err)}`
      this.log.error(
        { event: 'dual_brain_failed', messageId: msg.id, error: err instanceof Error ? err.message : String(err) },
        'dual-brain failed',
      )
      await this.deliver(msg.chatId, errorMsg).catch(() => {})
      this.log.info(
        {
          event: 'process_end',
          messageId: msg.id,
          totalPipelineMs: Date.now() - processStart,
          path: 'dual_brain',
          outcome: 'error',
        },
        'process end',
      )
      return errorMsg
    }
  }

  /**
   * Deliver a message chunked, with structured delivery_start / delivery_end
   * events wrapping the write. Safe for both happy-path and error-path output;
   * caller tags `outcome` appropriately. Never logs text content — only counts.
   */
  private async deliverWithLogging(
    messageId: string,
    chatId: string,
    text: string,
    outcome: 'success' | 'error',
  ): Promise<void> {
    const chunks = splitMessage(text, TELEGRAM_MAX_LENGTH)
    const start = Date.now()
    this.log.info(
      {
        event: 'delivery_start',
        messageId,
        chatId,
        chunks: chunks.length,
        totalLength: text.length,
      },
      'delivery start',
    )
    for (const chunk of chunks) {
      await this.deliver(chatId, chunk)
    }
    this.log.info(
      {
        event: 'delivery_end',
        messageId,
        chatId,
        chunks: chunks.length,
        totalLength: text.length,
        deliveryMs: Date.now() - start,
        outcome,
      },
      'delivery end',
    )
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
