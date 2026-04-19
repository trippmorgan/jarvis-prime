import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { MessageProcessor } from '../bridge/processor.js'

const messageSchema = z.object({
  chatId: z.string(),
  text: z.string().min(1),
  userId: z.string(),
})

export function registerMessageRoute(server: FastifyInstance, processor: MessageProcessor): void {
  server.post('/message', async (request, reply) => {
    const parsed = messageSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid payload', details: parsed.error.issues })
    }

    const { chatId, text, userId } = parsed.data
    const result = processor.submit(chatId, text, userId)

    if (result.blocked) {
      return reply.code(422).send({ error: 'phi_blocked', reasons: result.reasons })
    }

    return reply.code(202).send({
      queued: true,
      messageId: result.messageId,
      position: result.position,
    })
  })

  server.get('/queue', async () => ({
    length: processor.getQueueLength(),
    processing: processor.isProcessing(),
  }))
}
