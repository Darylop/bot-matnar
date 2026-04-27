import { addKeyword, EVENTS } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { MemoryDB as Database } from '@builderbot/bot'
import { classifyIntent } from '../services/ai.service'
import { chatFlow } from './chat.flow'
import { appointmentFlow } from './appointment.flow'

export const welcomeFlow = addKeyword<Provider, Database>(EVENTS.WELCOME)
    .addAction(async (ctx, { gotoFlow, flowDynamic }) => {
        try {
            const intent = await classifyIntent(ctx.body)

            if (intent === 'appointment') {
                return gotoFlow(appointmentFlow)
            }

            return gotoFlow(chatFlow)
        } catch (error) {
            console.error('[welcome] Error classifying intent:', error)
            await flowDynamic(
                'Hola, soy el asistente de Matnar. ¿En que te puedo ayudar hoy?'
            )
        }
    })
