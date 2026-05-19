import { addKeyword, utils } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { MemoryDB as Database } from '@builderbot/bot'
import {
    CalendarConfigurationError,
    deleteAppointment,
    findUpcomingAppointmentByPhone,
    formatStoredDateTime,
    isCalendarNotFoundError,
    parseAppointmentDescription,
} from '../services/calendar.service'
import { dispatchByIntent } from './dispatch-intent'
import { formatTime12h } from '../utils/appointment-datetime'

const APPOINTMENT_STATE_KEYS = [
    'appointmentName',
    'appointmentService',
    'appointmentDate',
    'appointmentTime',
    'appointmentEmail',
    'appointmentExtracted',
    'appointmentInitialMessage',
    'appointmentBookingActive',
    'appointmentOfferedDate',
    'appointmentOfferedTime',
    'appointmentAwaitingAlternateSlot',
    'pendingCancelEventId',
] as const

const clearAppointmentState = async (state: {
    update: (data: Record<string, unknown>) => Promise<unknown>
}): Promise<void> => {
    const wipe: Record<string, unknown> = {}
    for (const key of APPOINTMENT_STATE_KEYS) wipe[key] = ''
    await state.update(wipe)
}

const calendarUnreachable = (error: unknown): boolean =>
    error instanceof CalendarConfigurationError || isCalendarNotFoundError(error)

const looksLikeYes = (raw: string): boolean => {
    const t = raw.trim().toLowerCase()
    if (!t) return false
    return /^(si|sí|s|claro|confirmo|confirmar|adelante|de acuerdo|ok|okay|vale|hazlo|borrala|cancela(la)?|listo|dale)\b/.test(
        t
    )
}

const looksLikeNo = (raw: string): boolean => {
    const t = raw.trim().toLowerCase()
    if (!t) return false
    return /^(no|nop|negativo|cancela(r)? eso|mejor no|olvidalo|deja(la)?)\b/.test(t)
}

export const cancelFlow = addKeyword<Provider, Database>(utils.setEvent('CANCEL_FLOW'))
    .addAction(async (ctx, { state, flowDynamic, endFlow }) => {
        let appointment
        try {
            appointment = await findUpcomingAppointmentByPhone(ctx.from)
        } catch (error) {
            console.error('[cancel] Error fetching appointment:', error)
            if (calendarUnreachable(error)) {
                await flowDynamic('No puedo consultar la agenda ahora, intenta en un minuto.')
                return endFlow()
            }
            await flowDynamic('Hubo un problema al consultar tu cita. Intentemos de nuevo.')
            return endFlow()
        }

        if (!appointment) {
            await flowDynamic('No veo citas tuyas en agenda. ¿Quieres agendar una?')
            await clearAppointmentState(state)
            return endFlow()
        }

        const fmt = formatStoredDateTime(appointment.startIso)
        const { reason } = parseAppointmentDescription(appointment.description)
        const cabecera = fmt
            ? `Tu cita: ${reason ?? 'consulta'} el ${fmt.date} a las ${formatTime12h(fmt.time)}.`
            : 'Encontre tu cita.'
        const detalles = `${cabecera}\n¿La cancelo? (si/no)`

        await state.update({ pendingCancelEventId: appointment.eventId })
        await flowDynamic(detalles)
    })
    .addAction({ capture: true }, async (ctx, { state, flowDynamic, fallBack, endFlow, gotoFlow }) => {
        const rerouted = await dispatchByIntent(ctx, state, gotoFlow)
        if (rerouted) return

        const eventId = state.get('pendingCancelEventId') as string | undefined
        if (!eventId) {
            await flowDynamic('No tengo nada pendiente. Si quieres agendar, dimelo.')
            return endFlow()
        }

        if (looksLikeNo(ctx.body)) {
            await clearAppointmentState(state)
            await flowDynamic('Listo, la dejo en pie.')
            return endFlow()
        }

        if (!looksLikeYes(ctx.body)) {
            return fallBack('¿La cancelo? Responde "si" o "no".')
        }

        try {
            await deleteAppointment(eventId)
        } catch (error) {
            console.error('[cancel] Error deleting event:', error)
            if (calendarUnreachable(error)) {
                await flowDynamic('No pude cancelarla ahora, intenta en un minuto.')
            } else {
                await flowDynamic('Hubo un problema al cancelarla. ¿Lo intentamos de nuevo?')
            }
            return endFlow()
        }

        await clearAppointmentState(state)
        await flowDynamic('Hecho, cita cancelada. Si quieres otra, dimelo.')
        return endFlow()
    })

export { clearAppointmentState }
