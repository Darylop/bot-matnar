import { addKeyword, utils } from '@builderbot/bot'

import { BaileysProvider as Provider } from '@builderbot/provider-baileys'

import { MemoryDB as Database } from '@builderbot/bot'

import {

    CalendarConfigurationError,

    deleteAppointment,

    findUpcomingAppointmentByPhone,

    formatStoredDateTime,

    isCalendarNotFoundError,

    listUpcomingAppointmentsByPhone,

    parseAppointmentDescription,

} from '../services/calendar.service'

import { dispatchByIntent } from './dispatch-intent'

import { looksLikeCancelAllRequest } from './flow-guard'

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

    'pendingCancelAll',

    'pendingCancelAllEventIds',

    'editEventId',

    'editName',

    'editService',

    'editDate',

    'editTime',

    'editEmail',

    'editOriginalService',

    'editOriginalDate',

    'editOriginalTime',

    'editOriginalEmail',

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



const isPendingCancelAll = (state: { get: (key: string) => unknown }): boolean => {

    const v = state.get('pendingCancelAll')

    return v === true || v === 'true'

}



const parseStoredEventIds = (raw: unknown): string[] => {

    if (typeof raw !== 'string' || !raw.trim()) return []

    return raw.split(',').map((s) => s.trim()).filter(Boolean)

}



const cancelTriggerMessage = (state: { get: (key: string) => unknown }, body: string): string => {

    const initial = state.get('appointmentInitialMessage')

    return typeof initial === 'string' && initial.trim() ? initial : body

}



export const cancelFlow = addKeyword<Provider, Database>(utils.setEvent('CANCEL_FLOW'))

    .addAction(async (ctx, { state, flowDynamic, endFlow }) => {

        const trigger = cancelTriggerMessage(state, ctx.body)



        if (looksLikeCancelAllRequest(trigger)) {

            let appointments

            try {

                appointments = await listUpcomingAppointmentsByPhone(ctx.from)

            } catch (error) {

                console.error('[cancel-all] Error fetching appointments:', error)

                if (calendarUnreachable(error)) {

                    await flowDynamic('No puedo consultar la agenda ahora, intenta en un minuto.')

                    return endFlow()

                }

                await flowDynamic('Hubo un problema al consultar tus citas. Intentemos de nuevo.')

                return endFlow()

            }



            if (appointments.length === 0) {

                await flowDynamic('No veo citas tuyas en agenda. ¿Quieres agendar una?')

                await clearAppointmentState(state)

                return endFlow()

            }



            const ids = appointments.map((a) => a.eventId).join(',')

            await state.update({

                pendingCancelAll: true,

                pendingCancelAllEventIds: ids,

                pendingCancelEventId: '',

            })



            const n = appointments.length

            const prompt =

                n === 1

                    ? 'Tienes 1 cita programada.\n¿La cancelo? (si/no)'

                    : `Tienes ${n} citas programadas.\n¿Las cancelo todas? (si/no)`

            await flowDynamic(prompt)

            return

        }



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



        await state.update({ pendingCancelEventId: appointment.eventId, pendingCancelAll: false })

        await flowDynamic(detalles)

    })

    .addAction({ capture: true }, async (ctx, { state, flowDynamic, fallBack, endFlow, gotoFlow }) => {

        const rerouted = await dispatchByIntent(ctx, state, gotoFlow)

        if (rerouted) return



        if (isPendingCancelAll(state)) {

            const eventIds = parseStoredEventIds(state.get('pendingCancelAllEventIds'))



            if (looksLikeNo(ctx.body)) {

                await clearAppointmentState(state)

                await flowDynamic('Listo, deje tus citas como estaban.')

                return endFlow()

            }



            if (!looksLikeYes(ctx.body)) {

                const n = eventIds.length

                const hint =

                    n === 1

                        ? '¿La cancelo? Responde "si" o "no".'

                        : '¿Las cancelo todas? Responde "si" o "no".'

                return fallBack(hint)

            }



            let deleted = 0

            let failed = 0

            for (const eventId of eventIds) {

                try {

                    await deleteAppointment(eventId)

                    deleted++

                } catch (error) {

                    failed++

                    console.error('[cancel-all] Error deleting event:', eventId, error)

                }

            }



            await clearAppointmentState(state)



            if (failed > 0 && deleted === 0) {
                await flowDynamic('Hubo un problema al cancelarlas. ¿Lo intentamos de nuevo?')
                return endFlow()
            }



            if (failed > 0) {

                await flowDynamic(

                    `Cancele ${deleted} cita(s), pero ${failed} no se pudieron borrar. Revisa *mis citas* o intenta de nuevo.`

                )

                return endFlow()

            }



            const doneMsg =

                deleted === 1

                    ? 'Hecho, cita cancelada. Si quieres otra, dimelo.'

                    : `Hecho, cancele las ${deleted} citas. Si quieres agendar otra, dimelo.`

            await flowDynamic(doneMsg)

            return endFlow()

        }



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


