import { addKeyword, utils } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { MemoryDB as Database } from '@builderbot/bot'
import {
    buildAboutUsReply,
    buildMainMenuReply,
    looksLikeBackToMenu,
    parseMainMenuChoice,
} from '../context/services.catalog'
import { splitWhatsappMessages } from '../utils/split-message'
import { dispatchByIntent } from './dispatch-intent'
import { servicesFlow } from './services.flow'
import { appointmentFlow } from './appointment.flow'
import { clearAppointmentState } from './cancel.flow'

export const welcomeMenuFlow = addKeyword<Provider, Database>(utils.setEvent('WELCOME_MENU_FLOW'))
    .addAction(async (ctx, { flowDynamic, state }) => {
        await state.update({ chatMainMenuActive: true })
        await flowDynamic(buildMainMenuReply())
    })
    .addAction({ capture: true }, async (ctx, { state, flowDynamic, gotoFlow }) => {
        const rerouted = await dispatchByIntent(ctx, state, gotoFlow)
        if (rerouted) return

        if (looksLikeBackToMenu(ctx.body)) {
            await state.update({ chatMainMenuActive: true })
            await flowDynamic(buildMainMenuReply())
            return
        }

        const menuChoice = parseMainMenuChoice(ctx.body, true)
        if (menuChoice === 'about') {
            await flowDynamic(splitWhatsappMessages(buildAboutUsReply()))
            return
        }
        if (menuChoice === 'services') {
            await state.update({
                servicesInitialMessage: ctx.body,
                chatMainMenuActive: false,
                chatServicesCatalogActive: false,
            })
            return gotoFlow(servicesFlow)
        }
        if (menuChoice === 'appointment') {
            await state.update({ chatMainMenuActive: false, chatOfferedSchedule: false })
            await clearAppointmentState(state)
            await state.update({
                appointmentInitialMessage: ctx.body,
                appointmentExtracted: false,
                appointmentBookingActive: true,
            })
            return gotoFlow(appointmentFlow)
        }

        await flowDynamic('Elige 1, 2 o 3 del menu, o escribe *menu*.')
    })
