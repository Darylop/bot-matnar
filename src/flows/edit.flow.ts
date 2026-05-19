import { addKeyword, utils } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { MemoryDB as Database } from '@builderbot/bot'
import {
    CalendarConfigurationError,
    checkAvailability,
    findUpcomingAppointmentByPhone,
    formatStoredDateTime,
    isCalendarNotFoundError,
    parseAppointmentDescription,
    rescheduleAppointment,
} from '../services/calendar.service'
import { extractAppointmentFields, extractEmail, mapServiceToCatalog } from '../services/extractor.service'
import {
    BUSINESS_HOURS_LABEL,
    formatTime12h,
    getAppointmentTimeZone,
    isBusinessWeekday,
    isWithinBusinessHours,
    normalizeAppointmentDate,
    normalizeAppointmentTime,
} from '../utils/appointment-datetime'
import { clearAppointmentState } from './cancel.flow'
import { dispatchByIntent } from './dispatch-intent'

type StoredSnapshot = {
    eventId: string
    name: string
    service: string
    date: string
    time: string
    email: string | null
}

const STATE_KEYS = {
    eventId: 'editEventId',
    name: 'editName',
    service: 'editService',
    date: 'editDate',
    time: 'editTime',
    email: 'editEmail',
    snapshotService: 'editOriginalService',
    snapshotDate: 'editOriginalDate',
    snapshotTime: 'editOriginalTime',
    snapshotEmail: 'editOriginalEmail',
} as const

const calendarUnreachable = (error: unknown): boolean =>
    error instanceof CalendarConfigurationError || isCalendarNotFoundError(error)

const tryDirectNormalize = (raw: string): { date?: string; time?: string } => {
    const out: { date?: string; time?: string } = {}
    const date = normalizeAppointmentDate(raw, new Date(), getAppointmentTimeZone())
    if (date && isBusinessWeekday(date)) out.date = date
    const time = normalizeAppointmentTime(raw)
    if (time && isWithinBusinessHours(time)) out.time = time
    return out
}

const applyUserMessage = async (
    rawMessage: string,
    state: { update: (data: Record<string, unknown>) => Promise<unknown>; get: (k: string) => unknown }
): Promise<void> => {
    try {
        const extracted = await extractAppointmentFields(rawMessage)
        const patch: Record<string, string> = {}
        if (extracted.date && isBusinessWeekday(extracted.date)) patch[STATE_KEYS.date] = extracted.date
        if (extracted.time && isWithinBusinessHours(extracted.time)) patch[STATE_KEYS.time] = extracted.time
        if (extracted.service) patch[STATE_KEYS.service] = extracted.service
        if (extracted.email) patch[STATE_KEYS.email] = extracted.email
        if (Object.keys(patch).length > 0) await state.update(patch)
    } catch (error) {
        console.error('[edit] AI extraction failed:', error)
    }

    const direct = tryDirectNormalize(rawMessage)
    const patch: Record<string, string> = {}
    if (direct.date && !state.get(STATE_KEYS.date)) patch[STATE_KEYS.date] = direct.date
    if (direct.time && !state.get(STATE_KEYS.time)) patch[STATE_KEYS.time] = direct.time
    const email = extractEmail(rawMessage)
    if (email && !state.get(STATE_KEYS.email)) patch[STATE_KEYS.email] = email
    if (Object.keys(patch).length > 0) await state.update(patch)
}

const hasNewSlot = (
    state: { get: (k: string) => unknown },
    snapshot: StoredSnapshot
): boolean => {
    const newDate = (state.get(STATE_KEYS.date) as string) || ''
    const newTime = (state.get(STATE_KEYS.time) as string) || ''
    const newService = (state.get(STATE_KEYS.service) as string) || ''
    if (!newDate && !newTime && !newService) return false
    const dateChanged = newDate && newDate !== snapshot.date
    const timeChanged = newTime && newTime !== snapshot.time
    const serviceChanged = newService && newService !== snapshot.service
    return Boolean(dateChanged || timeChanged || serviceChanged)
}

const summarizeChange = (
    snapshot: StoredSnapshot,
    next: StoredSnapshot,
    meetLink: string | null,
    addToCalendarUrl: string | null,
    attendeeInvited: boolean
): string => {
    const lines = [`Listo ${next.name}, movi tu cita al ${next.date} a las ${formatTime12h(next.time)} 📅`]
    if (next.service !== snapshot.service) lines.push(`Servicio: ${next.service}.`)
    if (attendeeInvited && next.email) {
        lines.push(`Te llegara la actualizacion a ${next.email} y ya quedo en tu calendario 📩`)
    } else if (addToCalendarUrl) {
        lines.push(`Agregalo a tu calendario: ${addToCalendarUrl}`)
    }
    if (meetLink) lines.push(`Link de Google Meet: ${meetLink}`)
    return lines.join('\n')
}

const promptForMissing = (
    state: { get: (k: string) => unknown },
    snapshot: StoredSnapshot
): string => {
    const newDate = (state.get(STATE_KEYS.date) as string) || ''
    const newTime = (state.get(STATE_KEYS.time) as string) || ''
    const missing: string[] = []
    if (!newDate) missing.push('la fecha (lun-vie)')
    if (!newTime) missing.push(`la hora (${BUSINESS_HOURS_LABEL})`)

    const cabecera = `Tu cita: ${snapshot.service} el ${snapshot.date} a las ${formatTime12h(snapshot.time)}.`
    if (missing.length === 0) {
        return `${cabecera}\n¿Que cambias? Pasame la fecha y/o hora nueva.`
    }
    return `${cabecera}\n¿Me pasas ${missing.join(' y ')}?`
}

export const editFlow = addKeyword<Provider, Database>(utils.setEvent('EDIT_FLOW'))
    .addAction(async (ctx, { state, flowDynamic, endFlow }) => {
        let appointment
        try {
            appointment = await findUpcomingAppointmentByPhone(ctx.from)
        } catch (error) {
            console.error('[edit] Error fetching appointment:', error)
            if (calendarUnreachable(error)) {
                await flowDynamic('No puedo consultar la agenda ahora, intenta en un minuto.')
                return endFlow()
            }
            await flowDynamic('Hubo un problema al consultar tu cita. Intentemos de nuevo.')
            return endFlow()
        }

        if (!appointment) {
            await flowDynamic('No veo citas tuyas para modificar. ¿Agendamos una?')
            await clearAppointmentState(state)
            return endFlow()
        }

        const fmt = formatStoredDateTime(appointment.startIso)
        const { name, reason, email: descEmail } = parseAppointmentDescription(appointment.description)
        if (!fmt || !name || !reason) {
            await flowDynamic('Encontre la cita pero le faltan datos. Mejor cancelala y agenda una nueva.')
            return endFlow()
        }

        const existingEmail = appointment.email ?? descEmail ?? null
        const snapshot: StoredSnapshot = {
            eventId: appointment.eventId,
            name,
            service: reason,
            date: fmt.date,
            time: fmt.time,
            email: existingEmail,
        }

        await state.update({
            [STATE_KEYS.eventId]: snapshot.eventId,
            [STATE_KEYS.name]: snapshot.name,
            [STATE_KEYS.snapshotService]: snapshot.service,
            [STATE_KEYS.snapshotDate]: snapshot.date,
            [STATE_KEYS.snapshotTime]: snapshot.time,
            [STATE_KEYS.snapshotEmail]: snapshot.email ?? '',
            [STATE_KEYS.service]: '',
            [STATE_KEYS.date]: '',
            [STATE_KEYS.time]: '',
            [STATE_KEYS.email]: '',
        })

        const initial = (state.get('appointmentInitialMessage') as string | undefined) ?? ctx.body
        if (initial) await applyUserMessage(initial, state)

        if (!hasNewSlot(state, snapshot)) {
            await flowDynamic(promptForMissing(state, snapshot))
            return
        }

        await tryReschedule(ctx, state, snapshot, flowDynamic, endFlow)
    })
    .addAction({ capture: true }, async (ctx, { state, flowDynamic, fallBack, endFlow, gotoFlow }) => {
        const rerouted = await dispatchByIntent(ctx, state, gotoFlow)
        if (rerouted) return

        const eventId = state.get(STATE_KEYS.eventId) as string | undefined
        const originalService = state.get(STATE_KEYS.snapshotService) as string | undefined
        const originalDate = state.get(STATE_KEYS.snapshotDate) as string | undefined
        const originalTime = state.get(STATE_KEYS.snapshotTime) as string | undefined
        const name = state.get(STATE_KEYS.name) as string | undefined
        const originalEmailRaw = state.get(STATE_KEYS.snapshotEmail) as string | undefined
        if (!eventId || !originalDate || !originalTime || !name) {
            await flowDynamic('Perdi el contexto, dime "modificar mi cita" otra vez.')
            await clearAppointmentState(state)
            return endFlow()
        }

        await applyUserMessage(ctx.body, state)

        const snapshot: StoredSnapshot = {
            eventId,
            name,
            service: originalService || '',
            date: originalDate,
            time: originalTime,
            email: originalEmailRaw || null,
        }

        if (!hasNewSlot(state, snapshot)) {
            return fallBack(promptForMissing(state, snapshot))
        }

        await tryReschedule(ctx, state, snapshot, flowDynamic, endFlow)
        return
    })

async function tryReschedule(
    ctx: { from: string },
    state: { get: (k: string) => unknown; update: (data: Record<string, unknown>) => Promise<unknown> },
    snapshot: StoredSnapshot,
    flowDynamic: (msg: string) => Promise<unknown>,
    endFlow: () => unknown
): Promise<void> {
    const nextDate = ((state.get(STATE_KEYS.date) as string) || snapshot.date).trim()
    const nextTime = ((state.get(STATE_KEYS.time) as string) || snapshot.time).trim()
    const nextServiceRaw = (state.get(STATE_KEYS.service) as string) || ''
    const nextService = nextServiceRaw ? mapServiceToCatalog(nextServiceRaw) : snapshot.service || nextServiceRaw
    const nextEmailRaw = (state.get(STATE_KEYS.email) as string) || ''
    const nextEmail = nextEmailRaw || snapshot.email || null

    try {
        const free = await checkAvailability(nextDate, nextTime, snapshot.eventId)
        if (!free) {
            await state.update({ [STATE_KEYS.time]: '' })
            await flowDynamic(`El ${nextDate} a las ${formatTime12h(nextTime)} esta ocupado. ¿Otra hora?`)
            return
        }
    } catch (error) {
        console.error('[edit] Error checking availability:', error)
        if (calendarUnreachable(error)) {
            await flowDynamic('No puedo consultar la agenda ahora, intenta en un minuto.')
            endFlow()
            return
        }
    }

    let result
    try {
        result = await rescheduleAppointment(snapshot.eventId, {
            name: snapshot.name,
            reason: nextService,
            date: nextDate,
            time: nextTime,
            phone: ctx.from,
            email: nextEmail,
        })
    } catch (error) {
        console.error('[edit] Error patching event:', error)
        if (calendarUnreachable(error)) {
            await flowDynamic('No puedo actualizar la cita ahora, intenta en un minuto.')
        } else {
            await flowDynamic('Hubo un problema al actualizar la cita. ¿Lo intentamos de nuevo?')
        }
        endFlow()
        return
    }

    const next: StoredSnapshot = {
        eventId: snapshot.eventId,
        name: snapshot.name,
        service: nextService,
        date: nextDate,
        time: nextTime,
        email: nextEmail,
    }
    await flowDynamic(
        summarizeChange(snapshot, next, result.meetLink, result.addToCalendarUrl, result.attendeeInvited)
    )
    await clearAppointmentState(state)
    endFlow()
}
