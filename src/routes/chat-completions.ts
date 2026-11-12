import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { MessageProcessor } from '../bridge/processor.js'

/**
 * OpenAI-compatible bridge for the openclaw TUI (2026-09-01).
 *
 * openclaw's `openai-completions` provider POSTs the whole session transcript
 * here with `stream: true`. We take only the LAST user message, push it through
 * the same MessageProcessor queue Telegram uses (dual-brain: qwen LEFT + glm
 * RIGHT + corpus callosum), and stream the integrated reply back as SSE.
 * History/continuity lives in jarvis-prime's own ConversationHistory, so the
 * transcript openclaw sends is deliberately ignored — Frank is one brain
 * whether you reach him from Telegram or the terminal.
 *
 * Turns take minutes. We emit SSE keepalive comments so neither openclaw's
 * fetch nor any proxy gives up before the callosum finishes.
 */

export const MODEL_ID = 'frank-prime'

/** chatIds with this prefix are virtual — never route them to Telegram. */
export const VIRTUAL_CHAT_PREFIX = 'tui:'
export const isVirtualChat = (chatId: string): boolean =>
  chatId.startsWith(VIRTUAL_CHAT_PREFIX)

type DeliverFn = (chatId: string, text: string) => Promise<void>

/**
 * Wrap the Telegram deliver function so virtual chats are a silent no-op —
 * their reply travels back over the HTTP response instead. Covers acks,
 * "Working on it...", queue-position notices and the final answer alike.
 */
export function guardDelivery(deliver: DeliverFn): DeliverFn {
  return async (chatId, text) => {
    if (isVirtualChat(chatId)) return
    await deliver(chatId, text)
  }
}

/**
 * Wrap the evolving-message Telegram surface so virtual chats never hit the
 * Telegram API. Every method rejects; TelegramResponder.postAck() turns that
 * rejection into `null`, which drops the processor onto the legacy path whose
 * deliver() is guarded above. Generic over the surface shape so server.ts can
 * pass its inline adapter without a type import from the processor.
 */
export function guardSurface<
  S extends Record<string, (chatId: string, ...rest: never[]) => Promise<unknown>>,
>(surface: S): S {
  const guarded = {} as Record<string, unknown>
  for (const [name, fn] of Object.entries(surface)) {
    guarded[name] = async (chatId: string, ...rest: never[]) => {
      if (isVirtualChat(chatId)) {
        throw new Error(`virtual chat ${chatId} has no Telegram surface (${name})`)
      }
      return fn(chatId, ...rest)
    }
  }
  return guarded as S
}

const KEEPALIVE_MS = 15_000

const contentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
})

const messageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(contentPartSchema), z.null()]).optional(),
})

const chatCompletionSchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().optional(),
    user: z.string().optional(),
  })
  .passthrough()

export type ChatCompletionRequest = z.infer<typeof chatCompletionSchema>

/** Flatten OpenAI message content (string or text parts) to plain text. */
export function contentToText(content: z.infer<typeof messageSchema>['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n')
  }
  return ''
}

/**
 * openclaw appends a runtime-generated frame *after* the real prompt, as a
 * second `user` message: "OpenClaw runtime context for the immediately
 * preceding user message … Sender (untrusted metadata) …" (plus retry hints
 * such as "The previous attempt did not produce a user-visible answer"). It
 * is metadata about the turn, never the turn itself — answering it sends
 * Frank chasing his own envelope.
 */
const RUNTIME_CONTEXT_RE = /^\s*OpenClaw runtime context\b/i
export const isRuntimeContextFrame = (text: string): boolean => RUNTIME_CONTEXT_RE.test(text)

/** The user turn we actually answer: the last non-empty, non-envelope `user` message. */
export function lastUserText(messages: ChatCompletionRequest['messages']): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const text = contentToText(m.content).trim()
    if (text.length === 0 || isRuntimeContextFrame(text)) continue
    return text
  }
  return null
}

/**
 * Derive the virtual chatId. A caller can pin one via `x-frank-chat-id`
 * (useful for multiple terminals); otherwise all TUI traffic shares one.
 */
function resolveChatId(request: FastifyRequest): string {
  const raw = request.headers['x-frank-chat-id']
  const header = Array.isArray(raw) ? raw[0] : raw
  const suffix = (header ?? 'openclaw').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64) || 'openclaw'
  return `${VIRTUAL_CHAT_PREFIX}${suffix}`
}

function completionId(messageId: string): string {
  return `chatcmpl-${messageId}`
}

function usageStub(prompt: string, completion: string) {
  // Rough token estimate — openclaw only uses this for its context meter.
  const est = (s: string) => Math.ceil(s.length / 4)
  const p = est(prompt)
  const c = est(completion)
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c }
}

export function registerChatCompletionsRoute(
  server: FastifyInstance,
  processor: MessageProcessor,
): void {
  server.get('/v1/models', async () => ({
    object: 'list',
    data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'jarvis-prime' }],
  }))

  server.post('/v1/chat/completions', async (request, reply) => {
    const parsed = chatCompletionSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: { message: 'Invalid chat completion payload', type: 'invalid_request_error', details: parsed.error.issues },
      })
    }

    const body = parsed.data
    const text = lastUserText(body.messages)
    if (text === null) {
      return reply.code(400).send({
        error: { message: 'No user message with text content', type: 'invalid_request_error' },
      })
    }

    const chatId = resolveChatId(request)
    const userId = body.user ?? 'openclaw-tui'
    const model = body.model ?? MODEL_ID

    if (body.stream === true) {
      return streamCompletion({ request, reply, processor, chatId, userId, text, model })
    }

    const { messageId, result } = await processor.submitAndWait(chatId, text, userId)
    return reply.code(200).send({
      id: completionId(messageId),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: result },
          finish_reason: 'stop',
        },
      ],
      usage: usageStub(text, result),
    })
  })
}

async function streamCompletion(args: {
  request: FastifyRequest
  reply: FastifyReply
  processor: MessageProcessor
  chatId: string
  userId: string
  text: string
  model: string
}): Promise<void> {
  const { request, reply, processor, chatId, userId, text, model } = args
  const raw = reply.raw
  const created = Math.floor(Date.now() / 1000)

  reply.hijack()
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  raw.flushHeaders?.()

  // Watch the *response* for the peer going away. (Not `request.raw`: since
  // Node 16 the IncomingMessage 'close' fires once the request body has been
  // consumed — i.e. immediately — which would silently drop every write.)
  let closed = false
  const onClose = () => {
    closed = true
  }
  raw.on('close', onClose)

  const write = (s: string): void => {
    if (closed || raw.destroyed || raw.writableEnded) return
    raw.write(s)
  }
  const sendEvent = (payload: unknown): void => write(`data: ${JSON.stringify(payload)}\n\n`)

  // Keepalive comments — legal SSE, ignored by OpenAI-style parsers.
  const keepalive = setInterval(() => write(': keepalive\n\n'), KEEPALIVE_MS)
  keepalive.unref?.()

  const chunk = (id: string, delta: Record<string, unknown>, finish: string | null, usage?: unknown) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage !== undefined ? { usage } : {}),
  })

  try {
    const { messageId, result } = await processor.submitAndWait(chatId, text, userId)
    const id = completionId(messageId)
    sendEvent(chunk(id, { role: 'assistant', content: '' }, null))
    sendEvent(chunk(id, { content: result }, null))
    sendEvent(chunk(id, {}, 'stop', usageStub(text, result)))
    write('data: [DONE]\n\n')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    request.log.error({ chatId, error: message }, 'chat-completions bridge failed')
    sendEvent({ error: { message, type: 'server_error' } })
    write('data: [DONE]\n\n')
  } finally {
    clearInterval(keepalive)
    raw.off('close', onClose)
    if (!raw.destroyed && !raw.writableEnded) raw.end()
  }
}
