import { addKeyword, EVENTS } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { MemoryDB as Database } from '@builderbot/bot'
import { parseMainMenuChoice } from '../context/services.catalog'
import { dispatchByIntent } from './dispatch-intent'

/**
 * Punto de entrada de cada mensaje (EVENTS.WELCOME).
 * Clasifica con IA y deriva al flujo correspondiente, salvo opciones 1/2/3 del menu activo.
 */
export const welcomeFlow = addKeyword<Provider, Database>(EVENTS.WELCOME).addAction(
    async (ctx, { gotoFlow, state }) => {
        if (state.get('chatMainMenuActive') === true && parseMainMenuChoice(ctx.body, true)) {
            return
        }
        await dispatchByIntent(ctx, state, gotoFlow)
    }
)
