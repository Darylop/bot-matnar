import { resolveIntent } from './resolve-intent'
import { clearAppointmentState } from './cancel.flow'
import { shouldSkipIntentDispatch } from './flow-guard'

type GotoFlow = (flow: unknown) => Promise<void>
type StateApi = {
    update: (data: Record<string, unknown>) => Promise<unknown>
    get: (key: string) => unknown
}

/**
 * Clasifica la intencion (IA + contexto) y deriva al flujo correspondiente.
 * Devuelve true si redirigio a otro flujo.
 */
export async function dispatchByIntent(
    ctx: { body: string },
    state: StateApi,
    gotoFlow: GotoFlow
): Promise<boolean> {
    if (shouldSkipIntentDispatch(state, ctx.body)) {
        return false
    }

    const intent = await resolveIntent(ctx.body, state)

    switch (intent) {
        case 'welcome': {
            await state.update({ chatMainMenuActive: true, chatServicesCatalogActive: false, outOfScope: false })
            const { welcomeMenuFlow } = await import('./welcome-menu.flow')
            await gotoFlow(welcomeMenuFlow)
            return true
        }

        case 'services': {
            await state.update({
                chatMainMenuActive: false,
                chatServicesCatalogActive: false,
                outOfScope: false,
                servicesInitialMessage: ctx.body,
            })
            const { servicesFlow } = await import('./services.flow')
            await gotoFlow(servicesFlow)
            return true
        }

        case 'appointment': {
            await state.update({ chatMainMenuActive: false, chatOfferedSchedule: false })
            await clearAppointmentState(state)
            await state.update({
                appointmentInitialMessage: ctx.body,
                appointmentExtracted: false,
                appointmentBookingActive: true,
            })
            const { appointmentFlow } = await import('./appointment.flow')
            await gotoFlow(appointmentFlow)
            return true
        }

        case 'cancel': {
            await state.update({ chatMainMenuActive: false, appointmentInitialMessage: ctx.body })
            const { cancelFlow } = await import('./cancel.flow')
            await gotoFlow(cancelFlow)
            return true
        }

        case 'edit': {
            await state.update({ chatMainMenuActive: false, appointmentInitialMessage: ctx.body })
            const { editFlow } = await import('./edit.flow')
            await gotoFlow(editFlow)
            return true
        }

        case 'unknown': {
            await state.update({ outOfScope: true, servicesInitialMessage: ctx.body })
            const { servicesFlow } = await import('./services.flow')
            await gotoFlow(servicesFlow)
            return true
        }

        default:
            return false
    }
}
