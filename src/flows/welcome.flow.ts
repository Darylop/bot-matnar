import { addKeyword, EVENTS } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { MemoryDB as Database } from '@builderbot/bot'
import { classifyIntent } from '../services/ai.service'
import { chatFlow } from './chat.flow'
import { appointmentFlow } from './appointment.flow'

export const welcomeFlow = addKeyword<Provider, Database>(EVENTS.WELCOME)
    .addAction(async (ctx, { gotoFlow, state }) => {
        let intent: 'chat' | 'appointment' = 'chat'
        try {
            intent = await classifyIntent(ctx.body)
        } catch (error) {
            // If classification keeps failing (e.g. Gemini 503 after retries),
            // fall back to chat so the user still gets a contextual response.
            console.error('[welcome] Error classifying intent, defaulting to chat:', error)
        }

        if (intent === 'appointment') {
            await state.update({
                appointmentInitialMessage: ctx.body,
                appointmentExtracted: false,
            })
            return gotoFlow(appointmentFlow)
        }

        return gotoFlow(chatFlow)
    })
