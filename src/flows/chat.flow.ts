import { addKeyword, utils } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { MemoryDB as Database } from '@builderbot/bot'
import { generateChatResponse, GeminiMessage } from '../services/ai.service'

export const chatFlow = addKeyword<Provider, Database>(utils.setEvent('CHAT_FLOW'))
    .addAction(async (ctx, { flowDynamic, state }) => {
        try {
            const history: GeminiMessage[] = state.get('chatHistory') ?? []

            const response = await generateChatResponse(history, ctx.body)

            // Keep last 10 exchanges to avoid hitting token limits
            const updatedHistory: GeminiMessage[] = [
                ...history,
                { role: 'user', parts: [{ text: ctx.body }] },
                { role: 'model', parts: [{ text: response }] },
            ].slice(-20)

            await state.update({ chatHistory: updatedHistory })
            await flowDynamic(response)
        } catch (error) {
            console.error('[chat] Error generating response:', error)
            await flowDynamic(
                'Lo siento, tuve un problema al procesar tu mensaje. Por favor intenta de nuevo.'
            )
        }
    })
