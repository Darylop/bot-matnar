import { addKeyword, EVENTS } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { MemoryDB as Database } from '@builderbot/bot'
import { dispatchByIntent } from './dispatch-intent'

/**
 * Punto de entrada de cada mensaje (EVENTS.WELCOME).
 * Siempre clasifica la intencion con IA y deriva al flujo correspondiente.
 */
export const welcomeFlow = addKeyword<Provider, Database>(EVENTS.WELCOME).addAction(
    async (ctx, { gotoFlow, state }) => {
        await dispatchByIntent(ctx, state, gotoFlow)
    }
)
