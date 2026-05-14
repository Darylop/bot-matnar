import { addKeyword, utils } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { MemoryDB as Database } from '@builderbot/bot'
import { buildServicesReply, userAsksForServices } from '../context/services.catalog'
import { generateChatResponse, GeminiMessage } from '../services/ai.service'

export const chatFlow = addKeyword<Provider, Database>(utils.setEvent('CHAT_FLOW'))
    .addAction(async (ctx, { flowDynamic, state }) => {
        try {
            const history: GeminiMessage[] = state.get('chatHistory') ?? []

            const response = userAsksForServices(ctx.body)
                ? buildServicesReply()
                : await generateChatResponse(history, ctx.body)

            // Keep last 10 exchanges to avoid hitting token limits
            const updatedHistory: GeminiMessage[] = [
                ...history,
                { role: 'user' as const, parts: [{ text: ctx.body }] },
                { role: 'model' as const, parts: [{ text: response }] },
            ].slice(-20)

            await state.update({ chatHistory: updatedHistory })
            await flowDynamic(response)
        } catch (error) {
            console.error('[chat] Error generating response:', error)
            const status = (error as { status?: number })?.status
            const message =
                status === 503 || status === 429
                    ? 'El asistente esta recibiendo mucho trafico en este momento. Vuelve a escribirme en un minuto, por favor.'
                    : 'Lo siento, tuve un problema al procesar tu mensaje. Por favor intenta de nuevo.'
            await flowDynamic(message)
        }
    })
