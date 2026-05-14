import { addKeyword, utils } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { MemoryDB as Database } from '@builderbot/bot'
import {
    CalendarConfigurationError,
    checkAvailability,
    createAppointment,
    isCalendarNotFoundError,
} from '../services/calendar.service'
import {
    getAppointmentTimeZone,
    isBusinessWeekday,
    isWithinBusinessHours,
    normalizeAppointmentDate,
    normalizeAppointmentTime,
} from '../utils/appointment-datetime'
import { AppointmentFields, extractAppointmentFields, mapServiceToCatalog } from '../services/extractor.service'

type FieldKey = 'name' | 'service' | 'date' | 'time'

const FIELD_STATE_KEY: Record<FieldKey, string> = {
    name: 'appointmentName',
    service: 'appointmentService',
    date: 'appointmentDate',
    time: 'appointmentTime',
}

const getField = (state: { get: (k: string) => unknown }, key: FieldKey): string | null => {
    const v = state.get(FIELD_STATE_KEY[key])
    return typeof v === 'string' && v.length > 0 ? v : null
}

const mergeExtraction = async (
    state: { update: (data: Record<string, unknown>) => Promise<unknown>; get: (k: string) => unknown },
    extracted: AppointmentFields
): Promise<void> => {
    const patch: Record<string, string> = {}
    if (!getField(state, 'name') && extracted.name) patch[FIELD_STATE_KEY.name] = extracted.name
    if (!getField(state, 'service') && extracted.service) patch[FIELD_STATE_KEY.service] = extracted.service
    if (!getField(state, 'date') && extracted.date && isBusinessWeekday(extracted.date)) {
        patch[FIELD_STATE_KEY.date] = extracted.date
    }
    if (!getField(state, 'time') && extracted.time && isWithinBusinessHours(extracted.time)) {
        patch[FIELD_STATE_KEY.time] = extracted.time
    }
    if (Object.keys(patch).length > 0) await state.update(patch)
}

const getMissing = (state: { get: (k: string) => unknown }): FieldKey[] => {
    const keys: FieldKey[] = ['name', 'service', 'date', 'time']
    return keys.filter((k) => !getField(state, k))
}

const friendlyFieldLabel: Record<FieldKey, string> = {
    name: 'tu nombre',
    service: 'el servicio que te interesa',
    date: 'la fecha (lunes a viernes)',
    time: 'la hora (entre 09:00 y 18:00)',
}

const buildMissingPrompt = (missing: FieldKey[], name: string | null): string => {
    const greeting = name ? `Perfecto ${name},` : 'Perfecto,'

    if (missing.length === 1) {
        return `${greeting} solo me faltaria ${friendlyFieldLabel[missing[0]]}. ¿Me lo indicas?`
    }
    if (missing.length === 2) {
        return `${greeting} me puedes indicar ${friendlyFieldLabel[missing[0]]} y ${friendlyFieldLabel[missing[1]]}?`
    }
    if (missing.length === 3) {
        return `${greeting} para agendarte necesito ${friendlyFieldLabel[missing[0]]}, ${friendlyFieldLabel[missing[1]]} y ${friendlyFieldLabel[missing[2]]}. ¿Me los compartes?`
    }
    return 'Con gusto te agendo una llamada de consultoria. ¿Me indicas tu nombre, el servicio que te interesa, y la fecha y hora que prefieres? Atendemos de lunes a viernes, 09:00 a 18:00.'
}

const tryDirectNormalize = (raw: string): Partial<AppointmentFields> => {
    const out: Partial<AppointmentFields> = {}
    const date = normalizeAppointmentDate(raw, new Date(), getAppointmentTimeZone())
    if (date && isBusinessWeekday(date)) out.date = date
    const time = normalizeAppointmentTime(raw)
    if (time && isWithinBusinessHours(time)) out.time = time
    return out
}

/**
 * Validates the slot is available and creates the calendar event.
 * Returns null on success, or an error message string on failure (so caller can re-prompt).
 */
type BookResult =
    | { ok: true; message: string; clearField: null }
    | { ok: false; clearField: FieldKey | null; message: string }

const tryBook = async (
    ctx: { from: string },
    state: { get: (k: string) => unknown; update: (data: Record<string, unknown>) => Promise<unknown> }
): Promise<BookResult> => {
    const name = getField(state, 'name')!
    const service = getField(state, 'service')!
    const date = getField(state, 'date')!
    const time = getField(state, 'time')!

    try {
        const available = await checkAvailability(date, time)
        if (!available) {
            await state.update({ [FIELD_STATE_KEY.time]: '' })
            return {
                ok: false,
                clearField: 'time',
                message: `El horario ${time} del ${date} ya esta ocupado. ¿Puedes elegir otra hora?`,
            }
        }
    } catch (error) {
        console.error('[appointment] Error checking availability:', error)
        if (error instanceof CalendarConfigurationError || isCalendarNotFoundError(error)) {
            return {
                ok: false,
                clearField: null,
                message: 'No pude validar la agenda ahora mismo por una configuracion del calendario. Intenta de nuevo en unos minutos.',
            }
        }
    }

    try {
        await createAppointment({ name, reason: service, date, time, phone: ctx.from })
        return {
            ok: true,
            clearField: null,
            message: [
                `¡Listo ${name}! Hay disponibilidad y ya te agendamos la llamada.`,
                '',
                `Servicio: ${service}`,
                `Fecha: ${date}`,
                `Hora: ${time}`,
                `Duracion: 30 minutos`,
                '',
                'Nuestro equipo te contactara para confirmar'
            ].join('\n'),
        }
    } catch (error) {
        console.error('[appointment] Error creating event:', error)
        if (error instanceof CalendarConfigurationError || isCalendarNotFoundError(error)) {
            return {
                ok: false,
                clearField: null,
                message: 'No pude registrar la cita porque el calendario no esta accesible ahora mismo. Intenta de nuevo en unos minutos.',
            }
        }
        return {
            ok: false,
            clearField: null,
            message: 'Hubo un problema al registrar tu cita. Intenta de nuevo, por favor.',
        }
    }
}

export const appointmentFlow = addKeyword<Provider, Database>(utils.setEvent('APPOINTMENT_FLOW'))
    .addAction(async (ctx, { state, flowDynamic, endFlow }) => {
        // Use whatever the user already said (passed from welcome) or the current message
        const initial = (state.get('appointmentInitialMessage') as string | undefined) ?? ctx.body
        if (initial && !state.get('appointmentExtracted')) {
            try {
                const extracted = await extractAppointmentFields(initial)
                await mergeExtraction(state, extracted)
            } catch (error) {
                console.error('[appointment] Initial extraction failed:', error)
            }
            await state.update({ appointmentExtracted: true })
        }

        const missing = getMissing(state)
        if (missing.length === 0) {
            const result = await tryBook(ctx, state)
            await flowDynamic(result.message)
            if (result.ok) return endFlow()
            if (result.clearField === null) return endFlow()
            // If we cleared time, fall through to the capture loop to ask again
        }

        const promptMissing = getMissing(state)
        await flowDynamic(buildMissingPrompt(promptMissing, getField(state, 'name')))
    })
    .addAction({ capture: true }, async (ctx, { state, fallBack, flowDynamic, endFlow }) => {
        const body = ctx.body.trim()

        // Cheap direct parses first (e.g. user just typed "viernes" or "3 pm")
        const direct = tryDirectNormalize(body)
        const missingBefore = getMissing(state)

        // If the only missing field is name and the message is short, take it as the name directly
        if (missingBefore.length === 1 && missingBefore[0] === 'name' && body.length <= 60 && !direct.date && !direct.time) {
            await state.update({ [FIELD_STATE_KEY.name]: body })
        } else if (missingBefore.length === 1 && missingBefore[0] === 'service' && body.length <= 120 && !direct.date && !direct.time) {
            await state.update({ [FIELD_STATE_KEY.service]: mapServiceToCatalog(body) })
        } else {
            // Run the AI extractor on the new message
            try {
                const extracted = await extractAppointmentFields(body)
                await mergeExtraction(state, extracted)
            } catch (error) {
                console.error('[appointment] Re-extraction failed:', error)
            }
            // Also fold in any direct date/time we already parsed
            if (direct.date && !getField(state, 'date')) {
                await state.update({ [FIELD_STATE_KEY.date]: direct.date })
            }
            if (direct.time && !getField(state, 'time')) {
                await state.update({ [FIELD_STATE_KEY.time]: direct.time })
            }
        }

        const missingAfter = getMissing(state)
        if (missingAfter.length > 0) {
            return fallBack(buildMissingPrompt(missingAfter, getField(state, 'name')))
        }

        const result = await tryBook(ctx, state)
        await flowDynamic(result.message)
        if (result.ok) return endFlow()
        if (result.clearField === null) return endFlow()
        return fallBack(buildMissingPrompt(getMissing(state), getField(state, 'name')))
    })
