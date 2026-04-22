import type { FastifyBaseLogger } from 'fastify'
import { spawnClaude } from '../claude/spawner.js'
import { MessageQueue } from '../queue/message-queue.js'
import type { QueueMessage } from '../queue/types.js'
import { ConversationHistory, type HistoryEntry } from '../context/history.js'
import { PromptBuilder } from '../context/prompt-builder.js'
import { classifyMessage, type MessageKind } from '../brain/router.js'
import {
  corpusCallosum,
  type CallosumEventPayload,
  type SkillShim,
} from '../brain/corpus-callosum.js'
import { RightBrainSkillShim } from '../brain/right-brain-skill-shim.js'
import { LeftHemisphereClient } from '../brain/left-hemisphere.js'
import { RightHemisphereClient } from '../brain/right-hemisphere.js'
import { makeRightClient } from '../brain/right-client-factory.js'
import { Tier0Classifier, type Tier0Result } from '../brain/tier0-classifier.js'
import {
  NoopReporter,
  type Reporter,
  type TraceHandle,
  CLINICAL_REDACTED_MARKER,
} from '../observability/langfuse-reporter.js'
import {
  LeftHemisphereError,
  RightHemisphereError,
  IntegrationError,
  type BrainResult,
} from '../brain/types.js'
import {
  INITIAL_ACK_LABEL,
  phaseLabelForEvent,
  type OrchestratorKind,
} from '../brain/phase-labels.js'
import {
  TelegramResponder,
  type TelegramSendSurface,
} from '../telegram/responder.js'

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
  /**
   * Telegram chat id for this turn. Used by W7 to derive a deterministic
   * right-brain session id; ignored when the agent path is disabled.
   */
  chatId: string
  /** Optional phase-event callback used by the evolving-message UX. */
  onEvent?: (eventName: string, payload?: CallosumEventPayload) => void
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
  /**
   * W7 — when true, the right hemisphere uses the persistent OpenClaw agent
   * (right-brain) instead of the stateless /v1/chat/completions client.
   * Defaults to false; flip to true after live smoke.
   */
  rightBrainAgentEnabled?: boolean
  /**
   * W7 — when true and the agent path throws a transport error, retry once
   * via the legacy chat-completions client. Defaults to true (prevents hard
   * regression while Wave 7 is being stabilized). Hook consumed by W7-T8.
   */
  rightBrainAgentFallback?: boolean
  /** Optional orchestrator injection — defaults to a closure over the real corpusCallosum(). */
  orchestrator?: OrchestratorFn
  /**
   * Wave-6 evolving-message UX killswitch. When true AND telegramSurface is
   * present, the processor replaces the 8-second "Working on it..." ack with
   * an immediate "Thinking…" message that is edited in place through phases.
   */
  evolvingMessageEnabled?: boolean
  /**
   * Injected for the evolving-message path. When absent the legacy 8-second
   * ack + deliver() path is used regardless of evolvingMessageEnabled.
   */
  telegramSurface?: TelegramSendSurface
  /**
   * W8-T14 — when true, dual-brain turns use the router flow (left plans,
   * dispatches, right drafts with skill evidence or research focus). When
   * false (default), the legacy Wave-7 parallel-pass-1 flow runs byte-for-byte.
   */
  routerEnabled?: boolean
  /**
   * W8-T14 — optional skill shim injection (defaults to RightBrainSkillShim).
   * Only consumed when routerEnabled=true.
   */
  skillShim?: SkillShim
  /**
   * W8.7 — enable the embedding-based Tier-0 intent classifier. When true and
   * the classifier routes an incoming natural-language turn to `quick_q` with
   * confidence ≥ `tier0Threshold`, the processor short-circuits to the single-
   * brain Claude path instead of running the full corpus callosum. Default: false.
   */
  tier0Enabled?: boolean
  /** Cosine threshold for the Tier-0 shortcut. Default 0.65. */
  tier0Threshold?: number
  /**
   * Optional classifier injection (tests). Defaults to a lazily-loaded
   * `Tier0Classifier` when `tier0Enabled === true`.
   */
  tier0Classifier?: Tier0Classifier
  /**
   * W8.8 — observability reporter. When omitted, a `NoopReporter` is used
   * and no traces are emitted. server.ts wires the real `LangfuseReporter`
   * when `LANGFUSE_ENABLED=true` + credentials are set.
   */
  reporter?: Reporter
}

export class MessageProcessor {
  private readonly queue: MessageQueue
  private readonly deliver: DeliverFn
  private readonly config: ProcessorConfig
  private readonly log: FastifyBaseLogger
  private readonly history: ConversationHistory
  private readonly promptBuilder: PromptBuilder
  private readonly orchestrator?: OrchestratorFn
  private readonly responder: TelegramResponder | null
  private readonly tier0Classifier: Tier0Classifier | null
  private readonly reporter: Reporter
  private readonly liveTraces: Map<string, TraceHandle> = new Map()

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
      const timeoutMs = config.corpusCallosumTimeoutMs
      const routerEnabled = config.routerEnabled === true
      // Skill shim is only meaningful in router mode; lazy-construct a default
      // when routerEnabled is on and the caller didn't inject one.
      const skillShim: SkillShim | undefined = routerEnabled
        ? config.skillShim ?? new RightBrainSkillShim({ logger: this.log })
        : undefined
      this.orchestrator = async (input) => {
        const rightClient = makeRightClient({
          rightBrainAgentEnabled: config.rightBrainAgentEnabled === true,
          rightBrainAgentFallback: config.rightBrainAgentFallback !== false,
          chatId: input.chatId,
          gatewayUrl: config.gatewayUrl,
          gatewayToken: config.gatewayToken,
          rightModel: config.rightModel,
          logger: this.log,
        })
        return corpusCallosum(
          {
            left: leftClient,
            right: rightClient,
            basePrompt: input.basePrompt,
            timeoutMs,
            logger: this.log,
            onEvent: input.onEvent,
            routerEnabled,
            skillShim,
          },
          { userMsg: input.userMsg, history: input.history },
        )
      }
    }

    // W8.7 — Tier-0 classifier. Only constructed when the feature flag is on
    // AND the dual-brain is enabled (otherwise there's nothing to short-circuit
    // past). Respects an injected instance for tests.
    if (config.tier0Classifier) {
      this.tier0Classifier = config.tier0Classifier
    } else if (config.tier0Enabled === true && config.corpusCallosumEnabled) {
      this.tier0Classifier = new Tier0Classifier({
        threshold: config.tier0Threshold,
        logger: this.log,
      })
    } else {
      this.tier0Classifier = null
    }

    // W8.8 — Reporter for Langfuse traces. server.ts injects a real
    // LangfuseReporter when `LANGFUSE_ENABLED=true`; otherwise (and in
    // tests) a NoopReporter satisfies the interface with zero overhead.
    this.reporter = config.reporter ?? new NoopReporter()

    // Wave-6 evolving-message responder. Only constructed when both the
    // killswitch is on AND the surface is wired; otherwise we stay on the
    // legacy 8-second ack path.
    if (config.evolvingMessageEnabled === true && config.telegramSurface) {
      this.responder = new TelegramResponder({
        surface: config.telegramSurface,
        logger: this.log,
      })
    } else {
      this.responder = null
    }

    this.queue.on('message', (event) => {
      if (event.type === 'error') {
        this.log.error({ messageId: event.message.id, error: event.error }, 'Queue processing error')
      }
    })
  }

  submit(chatId: string, text: string, userId: string): { messageId: string; position: number } {
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

    return { messageId: receipt.id, position: receipt.position }
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

    // W8.8 — open a Langfuse root trace for this turn. NoopReporter when
    // disabled, so this costs nothing in the dev/test path. Stored in the
    // liveTraces map so emitProcessEnd can finalise it from any path
    // handler without a signature-cascade refactor.
    const isClinical = this.config.clinicalOverride === true
    const trace = this.reporter.startTrace({
      name: 'telegram_message',
      sessionId: `chat_${msg.chatId}`,
      userId: msg.userId,
      input: isClinical ? CLINICAL_REDACTED_MARKER : msg.text,
      metadata: {
        messageId: msg.id,
        queueLength: this.queue.getQueueLength(),
        textLength: msg.text.length,
      },
      tags: ['inbound'],
    })
    this.liveTraces.set(msg.id, trace)

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

    // W8.7 — Tier-0 embedding classifier. Only runs for natural-language
    // turns where the dual-brain would otherwise fire. A `quick_q` winner
    // short-circuits to the single-brain path; every other outcome (null,
    // tool_call, dispatch, deep_review) falls through unchanged so W8.7 is
    // purely additive.
    let tier0: Tier0Result | null = null
    if (
      classification.kind === 'natural' &&
      this.config.corpusCallosumEnabled &&
      this.tier0Classifier !== null
    ) {
      tier0 = await this.tier0Classifier.classify(msg.text)
      this.log.info(
        {
          event: 'tier0_classification',
          messageId: msg.id,
          route: tier0.route,
          confidence: tier0.confidence,
          topRoute: tier0.topRoute,
          topCosine: tier0.topCosine,
          latencyMs: tier0.latencyMs,
          reason: tier0.reason,
        },
        'tier0 classification',
      )
    }

    const tier0Shortcut = tier0?.route === 'quick_q'

    const useDualBrain =
      classification.kind === 'natural' &&
      !tier0Shortcut &&
      this.config.corpusCallosumEnabled &&
      this.orchestrator !== undefined

    // Update trace with classification + tier-0 metadata before routing.
    trace.update({
      metadata: {
        kind: classification.kind,
        tier0Route: tier0?.route ?? null,
        tier0Confidence: tier0?.confidence ?? null,
        tier0TopRoute: tier0?.topRoute ?? null,
        tier0TopCosine: tier0?.topCosine ?? null,
        tier0LatencyMs: tier0?.latencyMs ?? null,
        tier0Reason: tier0?.reason ?? null,
      },
    })

    if (useDualBrain) {
      this.log.info({ event: 'route_dual_brain', messageId: msg.id }, 'routing via dual-brain')
      return this.processDualBrain(msg, processStart)
    }

    const singleBrainKind: OrchestratorKind = tier0Shortcut
      ? 'tier0_quick'
      : this.resolveSingleBrainKind(classification.kind)

    this.log.info(
      {
        event: 'route_bypass',
        kind: classification.kind,
        singleBrainKind,
        tier0Shortcut,
        messageId: msg.id,
      },
      'routing via single-brain bypass',
    )
    return this.processSingleBrain(msg, processStart, singleBrainKind)
  }

  /**
   * Map a classification kind + current config state into the OrchestratorKind
   * used by phase-labels.ts. Dual-brain natural messages use 'natural'; the
   * single-brain fallback for a natural message (killswitch or orchestrator
   * absent) resolves to 'killswitch'.
   */
  private resolveSingleBrainKind(classificationKind: MessageKind): OrchestratorKind {
    if (classificationKind === 'slash') return 'slash'
    if (classificationKind === 'clinical') return 'clinical'
    // classificationKind === 'natural' on the single-brain path → dual-brain disabled
    return 'killswitch'
  }

  private async processSingleBrain(
    msg: QueueMessage,
    processStart: number,
    kind: OrchestratorKind,
  ): Promise<string> {
    // Evolving-message path — attempt ack first; fall back to legacy if it fails.
    if (this.responder) {
      const msgId = await this.responder.postAck(msg.chatId, INITIAL_ACK_LABEL)
      if (msgId != null) {
        return this.processSingleBrainEvolving(msg, processStart, kind, msgId)
      }
      // Telegram send failed — fall through to legacy path.
      this.log.warn(
        { event: 'evolving_ack_failed_fallback', messageId: msg.id },
        'evolving ack returned null — falling back to legacy ack path',
      )
    }
    return this.processSingleBrainLegacy(msg, processStart)
  }

  private async processSingleBrainLegacy(
    msg: QueueMessage,
    processStart: number,
  ): Promise<string> {
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
        this.emitProcessEnd(msg.id, processStart, 'single_brain', 'timeout', 'legacy', errorMsg)
        return errorMsg
      }

      if (result.exitCode !== 0 && !result.output.trim()) {
        const errorMsg = `Claude encountered an error (exit ${result.exitCode}). ${result.stderr.slice(0, 200)}`
        this.log.error({ exitCode: result.exitCode, stderrLength: result.stderr.length }, 'Claude CLI error')
        await this.deliverWithLogging(msg.id, msg.chatId, errorMsg, 'error')
        this.emitProcessEnd(msg.id, processStart, 'single_brain', 'error', 'legacy', errorMsg)
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

      this.emitProcessEnd(msg.id, processStart, 'single_brain', 'success', 'legacy', output)

      return output
    } catch (err) {
      clearTimeout(ackTimer)
      const errorMsg = `Internal error: ${err instanceof Error ? err.message : String(err)}`
      this.log.error({ messageId: msg.id, error: errorMsg }, 'Processing failed')
      await this.deliver(msg.chatId, errorMsg).catch(() => {})
      this.emitProcessEnd(msg.id, processStart, 'single_brain', 'error', 'legacy', errorMsg)
      return errorMsg
    }
  }

  private async processSingleBrainEvolving(
    msg: QueueMessage,
    processStart: number,
    kind: OrchestratorKind,
    ackMessageId: number,
  ): Promise<string> {
    const responder = this.responder!
    const stopTyping = responder.startTyping(msg.chatId)

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

      // Phase-label update before the actual call.
      const preCallLabel = phaseLabelForEvent('single_brain_call_start', kind)
      if (preCallLabel) {
        responder.updatePhase(msg.chatId, ackMessageId, preCallLabel)
      }

      this.log.info(
        { event: 'single_brain_call_start', messageId: msg.id },
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

      if (result.timedOut) {
        const errorMsg = 'Request timed out. The task was too complex for a single pass — try breaking it into smaller steps.'
        await responder.finalize(msg.chatId, ackMessageId, errorMsg)
        this.emitProcessEnd(msg.id, processStart, 'single_brain', 'timeout', 'evolving', errorMsg)
        return errorMsg
      }

      if (result.exitCode !== 0 && !result.output.trim()) {
        const errorMsg = `Claude encountered an error (exit ${result.exitCode}). ${result.stderr.slice(0, 200)}`
        this.log.error({ exitCode: result.exitCode, stderrLength: result.stderr.length }, 'Claude CLI error')
        await responder.finalize(msg.chatId, ackMessageId, errorMsg)
        this.emitProcessEnd(msg.id, processStart, 'single_brain', 'error', 'evolving', errorMsg)
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
      await responder.finalize(msg.chatId, ackMessageId, output)

      this.log.info({
        messageId: msg.id,
        durationMs: result.durationMs,
        outputLen: output.length,
      }, 'Message processed')

      this.emitProcessEnd(msg.id, processStart, 'single_brain', 'success', 'evolving', output)

      return output
    } catch (err) {
      const errorMsg = `Internal error: ${err instanceof Error ? err.message : String(err)}`
      this.log.error({ messageId: msg.id, error: errorMsg }, 'Processing failed')
      await responder.finalize(msg.chatId, ackMessageId, errorMsg).catch(() => {})
      this.emitProcessEnd(msg.id, processStart, 'single_brain', 'error', 'evolving', errorMsg)
      return errorMsg
    } finally {
      stopTyping()
    }
  }

  private async processDualBrain(msg: QueueMessage, processStart: number): Promise<string> {
    // Evolving-message path — attempt ack first; fall back to legacy if it fails.
    if (this.responder) {
      const msgId = await this.responder.postAck(msg.chatId, INITIAL_ACK_LABEL)
      if (msgId != null) {
        return this.processDualBrainEvolving(msg, processStart, msgId)
      }
      this.log.warn(
        { event: 'evolving_ack_failed_fallback', messageId: msg.id },
        'evolving ack returned null — falling back to legacy ack path',
      )
    }
    return this.processDualBrainLegacy(msg, processStart)
  }

  private async processDualBrainLegacy(msg: QueueMessage, processStart: number): Promise<string> {
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
        chatId: msg.chatId,
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

      this.emitProcessEnd(msg.id, processStart, 'dual_brain', 'success', 'legacy', output)

      return output
    } catch (err) {
      clearTimeout(ackTimer)
      const errorMsg = this.formatDualBrainError(err, msg.id)
      const typed =
        err instanceof LeftHemisphereError ||
        err instanceof RightHemisphereError ||
        err instanceof IntegrationError
      if (typed) {
        await this.deliverWithLogging(msg.id, msg.chatId, errorMsg, 'error').catch(() => {})
      } else {
        await this.deliver(msg.chatId, errorMsg).catch(() => {})
      }
      this.emitProcessEnd(msg.id, processStart, 'dual_brain', 'error', 'legacy', errorMsg)
      return errorMsg
    }
  }

  private async processDualBrainEvolving(
    msg: QueueMessage,
    processStart: number,
    ackMessageId: number,
  ): Promise<string> {
    const responder = this.responder!
    const stopTyping = responder.startTyping(msg.chatId)
    let cardPosted = false

    try {
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

      const onEvent = (
        eventName: string,
        payload?: CallosumEventPayload,
      ): void => {
        if (
          eventName === 'callosum_pass2_ok' &&
          payload &&
          typeof payload.p2Left === 'string' &&
          typeof payload.p2Right === 'string'
        ) {
          const hasRouterEvidence =
            payload.leftTools !== undefined ||
            payload.rightMode !== undefined
          const card = formatDeliberationCard(
            payload.p2Left,
            payload.p2Right,
            payload.leftMs ?? 0,
            payload.rightMs ?? 0,
            hasRouterEvidence
              ? {
                  leftTools: payload.leftTools,
                  rightMode: payload.rightMode,
                  rightSkill: payload.rightSkill,
                }
              : undefined,
          )
          // Pin the deliberation card to the original ack bubble so the
          // conversation reads top-down: status → card → integrated answer.
          responder.finalize(msg.chatId, ackMessageId, card).catch(() => {})
          cardPosted = true
          this.log.info(
            {
              event: 'deliberation_card_posted',
              messageId: msg.id,
              leftLen: payload.p2Left.length,
              rightLen: payload.p2Right.length,
              leftMs: payload.leftMs,
              rightMs: payload.rightMs,
            },
            'deliberation card posted',
          )
          return
        }
        // Once the card is pinned, subsequent phase labels (e.g. "Integrating…")
        // would overwrite it — silently drop them. One exception: W8-T14
        // `self_correction_retry_start` is the permitted post-card edit so the
        // user sees "Re-planning…" while Claude runs the bounded retry. The
        // final answer still posts as a fresh bubble below the ack.
        if (cardPosted) {
          if (eventName === 'self_correction_retry_start') {
            const label = phaseLabelForEvent(eventName, 'natural')
            if (label) {
              responder.updatePhase(msg.chatId, ackMessageId, label)
            }
          }
          return
        }
        const label = phaseLabelForEvent(eventName, 'natural')
        if (label) {
          responder.updatePhase(msg.chatId, ackMessageId, label)
        }
      }

      const result = await this.orchestrator!({
        userMsg: msg.text,
        history,
        basePrompt,
        chatId: msg.chatId,
        onEvent,
      })

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

      if (cardPosted) {
        // Card already pinned to the ack bubble — ship the integrated answer
        // as one or more fresh bubbles below it.
        await this.deliverNewBubbles(msg.id, msg.chatId, output)
      } else {
        // No pass-2 payload arrived (test stub or pre-pass-2 short-circuit) —
        // preserve the original behaviour: integrated answer goes into the
        // ack bubble.
        await responder.finalize(msg.chatId, ackMessageId, output)
      }

      this.log.info(
        {
          event: 'dual_brain_done',
          messageId: msg.id,
          totalMs: result.trace.totalMs,
          integrationMs: result.trace.integrationMs,
          outputLen: output.length,
        },
        'dual-brain processed',
      )

      this.emitProcessEnd(msg.id, processStart, 'dual_brain', 'success', 'evolving', output)

      return output
    } catch (err) {
      const errorMsg = this.formatDualBrainError(err, msg.id)
      if (cardPosted) {
        await this.deliverNewBubbles(msg.id, msg.chatId, errorMsg).catch(() => {})
      } else {
        await responder.finalize(msg.chatId, ackMessageId, errorMsg).catch(() => {})
      }
      this.emitProcessEnd(msg.id, processStart, 'dual_brain', 'error', 'evolving', errorMsg)
      return errorMsg
    } finally {
      stopTyping()
    }
  }

  /**
   * Post the integrated answer (or error text) as one or more fresh Telegram
   * bubbles. Used after a deliberation card has finalized the ack bubble; the
   * integrated answer can't squeeze into an editMessageText slot because
   * Telegram caps edits at 4096 chars and the card is already there.
   */
  private async deliverNewBubbles(
    messageId: string,
    chatId: string,
    text: string,
  ): Promise<void> {
    const responder = this.responder!
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
    let outcome: 'success' | 'error' = 'success'
    for (const chunk of chunks) {
      const id = await responder.postBubble(chatId, chunk)
      if (id == null) outcome = 'error'
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

  /** Shared error classification + logging for dual-brain paths. */
  private formatDualBrainError(err: unknown, messageId: string): string {
    if (err instanceof LeftHemisphereError) {
      this.log.error(
        { event: 'dual_brain_failed', hemisphere: 'left', messageId, error: err.message },
        'dual-brain failed',
      )
      return `Left hemisphere failed: ${err.message}`
    }
    if (err instanceof RightHemisphereError) {
      this.log.error(
        { event: 'dual_brain_failed', hemisphere: 'right', messageId, error: err.message },
        'dual-brain failed',
      )
      return `Right hemisphere failed: ${err.message}`
    }
    if (err instanceof IntegrationError) {
      this.log.error(
        { event: 'dual_brain_failed', hemisphere: 'integration', messageId, error: err.message },
        'dual-brain failed',
      )
      return `Integration failed after retry: ${err.message}`
    }
    const msgText = err instanceof Error ? err.message : String(err)
    this.log.error(
      { event: 'dual_brain_failed', messageId, error: msgText },
      'dual-brain failed',
    )
    return `Internal error: ${msgText}`
  }

  private emitProcessEnd(
    messageId: string,
    processStart: number,
    path: 'single_brain' | 'dual_brain',
    outcome: 'success' | 'error' | 'timeout',
    uxPath: 'evolving' | 'legacy',
    output?: string,
  ): void {
    const totalPipelineMs = Date.now() - processStart
    this.log.info(
      {
        event: 'process_end',
        messageId,
        totalPipelineMs,
        path,
        outcome,
        uxPath,
      },
      'process end',
    )

    // W8.8 — finalise the Langfuse trace for this turn. Safe when reporter
    // is a noop (handle's update/end are no-ops). Output is redacted on the
    // clinical path; metadata always captured.
    const trace = this.liveTraces.get(messageId)
    if (trace) {
      const isClinical = this.config.clinicalOverride === true
      trace.update({
        output:
          output != null
            ? isClinical
              ? CLINICAL_REDACTED_MARKER
              : output
            : undefined,
        metadata: { path, outcome, uxPath, totalPipelineMs },
        tags: [path, outcome, uxPath],
      })
      trace.end()
      this.liveTraces.delete(messageId)
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

/**
 * Evidence passed to the deliberation card to render per-hemisphere
 * tool/skill summaries. Absent in legacy mode (no router) — the card then
 * falls back to the "Claude"/"GPT" provider labels.
 */
export interface DeliberationEvidence {
  /** Tool calls the left hemisphere made in pass-1. Empty array = no tools. */
  leftTools?: readonly { name: string; durationMs: number }[]
  /** Right hemisphere mode: "skill" (ran one via shim) or "research" (workspace memory). */
  rightMode?: 'skill' | 'research'
  /** Skill name when rightMode === 'skill'. */
  rightSkill?: string
}

/**
 * Render the two pass-2 hemisphere drafts into a single Telegram bubble.
 * Each draft is clipped to MAX_PER_DRAFT chars so the combined card stays
 * under Telegram's 4096-char message limit (header + 2×1500 + spacing ≈ 3100).
 *
 * W8-T13 — router-mode `evidence` replaces the provider labels with:
 *   Left  — "ran <tool-names>" OR "drafted"
 *   Right — "<skill-name>"     OR "researched"
 * Legacy mode (no evidence) keeps the original "Claude" / "GPT" labels.
 */
export function formatDeliberationCard(
  p2Left: string,
  p2Right: string,
  leftMs: number,
  rightMs: number,
  evidence?: DeliberationEvidence,
): string {
  const MAX_PER_DRAFT = 1500
  const truncate = (s: string): string => {
    const trimmed = s.trim()
    if (trimmed.length <= MAX_PER_DRAFT) return trimmed
    return trimmed.slice(0, MAX_PER_DRAFT) + '… [truncated]'
  }
  const left = truncate(p2Left)
  const right = truncate(p2Right)
  const leftSec = (leftMs / 1000).toFixed(1)
  const rightSec = (rightMs / 1000).toFixed(1)

  let leftLabel: string
  let rightLabel: string
  if (evidence) {
    const tools = evidence.leftTools ?? []
    leftLabel =
      tools.length > 0
        ? `ran ${tools.map((t) => t.name).join(', ')}`
        : 'drafted'
    if (evidence.rightMode === 'skill' && evidence.rightSkill) {
      rightLabel = evidence.rightSkill
    } else if (evidence.rightMode === 'research') {
      rightLabel = 'researched'
    } else {
      rightLabel = 'drafted'
    }
  } else {
    leftLabel = 'Claude'
    rightLabel = 'GPT'
  }

  return [
    '🧠 Two-brain deliberation',
    '',
    `🔵 Left (${leftLabel} · ${leftSec}s):`,
    left,
    '',
    `🟠 Right (${rightLabel} · ${rightSec}s):`,
    right,
  ].join('\n')
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
