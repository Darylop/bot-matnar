import { addKeyword, utils } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { MemoryDB as Database } from '@builderbot/bot'
import {
    AppointmentResult,
    CalendarConfigurationError,
    checkAvailability,
    createAppointment,
    findNextAvailableSlot,
    isCalendarNotFoundError,
} from '../services/calendar.service'
import {
    BUSINESS_HOURS_LABEL,
    formatTime12h,
    getAppointmentTimeZone,
    isBusinessWeekday,
    isWithinBusinessHours,
    normalizeAppointmentDate,
    normalizeAppointmentTime,
} from '../utils/appointment-datetime'
import {
    AppointmentFields,
    extractAppointmentFields,
    extractEmail,
    mapServiceToCatalog,
} from '../services/extractor.service'
import { clearAppointmentState } from './cancel.flow'
import { dispatchByIntent } from './dispatch-intent'
import { negotiateAppointmentSlot } from './appointment-slot'

type FieldKey = 'name' | 'service' | 'date' | 'time' | 'email'

const FIELD_STATE_KEY: Record<FieldKey, string> = {
    name: 'appointmentName',
    service: 'appointmentService',
    date: 'appointmentDate',
    time: 'appointmentTime',
    email: 'appointmentEmail',
}

/** Campos obligatorios para reservar; el servicio es opcional (ver DEFAULT_APPOINTMENT_SERVICE). */
const REQUIRED_FIELDS: FieldKey[] = ['name', 'date', 'time', 'email']

const DEFAULT_APPOINTMENT_SERVICE = 'Reunion Matnar'

const getField = (state: { get: (k: string) => unknown }, key: FieldKey): string | null => {
    const v = state.get(FIELD_STATE_KEY[key])
    return typeof v === 'string' && v.length > 0 ? v : null
}

type Rejections = {
    rejectedDate?: string
    rejectedTime?: string
}

const mergeRejections = (a: Rejections, b: Rejections): Rejections => ({
    rejectedDate: a.rejectedDate ?? b.rejectedDate,
    rejectedTime: a.rejectedTime ?? b.rejectedTime,
})

const buildRejectionPrefix = (rej: Rejections): string => {
    const parts: string[] = []
    if (rej.rejectedTime)
        parts.push(`${formatTime12h(rej.rejectedTime)} esta fuera de horario (${BUSINESS_HOURS_LABEL}).`)
    if (rej.rejectedDate) parts.push(`${rej.rejectedDate} no es lun-vie.`)
    return parts.join(' ')
}

const mergeExtraction = async (
    state: { update: (data: Record<string, unknown>) => Promise<unknown>; get: (k: string) => unknown },
    extracted: AppointmentFields
): Promise<Rejections> => {
    const patch: Record<string, string> = {}
    const rejections: Rejections = {}
    if (!getField(state, 'name') && extracted.name) patch[FIELD_STATE_KEY.name] = extracted.name
    if (!getField(state, 'service') && extracted.service) patch[FIELD_STATE_KEY.service] = extracted.service
    if (!getField(state, 'date') && extracted.date) {
        if (isBusinessWeekday(extracted.date)) {
            patch[FIELD_STATE_KEY.date] = extracted.date
        } else {
            rejections.rejectedDate = extracted.date
        }
    }
    if (!getField(state, 'time') && extracted.time) {
        if (isWithinBusinessHours(extracted.time)) {
            patch[FIELD_STATE_KEY.time] = extracted.time
        } else {
            rejections.rejectedTime = extracted.time
        }
    }
    if (!getField(state, 'email') && extracted.email) {
        patch[FIELD_STATE_KEY.email] = extracted.email
    }
    if (Object.keys(patch).length > 0) await state.update(patch)
    return rejections
}

const getMissing = (state: { get: (k: string) => unknown }): FieldKey[] => {
    return REQUIRED_FIELDS.filter((k) => !getField(state, k))
}

const resolveServiceForBooking = (state: { get: (k: string) => unknown }): string => {
    const explicit = getField(state, 'service')
    if (explicit) return explicit
    const fromChat = state.get('chatLastMentionedService')
    if (typeof fromChat === 'string' && fromChat.length > 0) return fromChat
    return DEFAULT_APPOINTMENT_SERVICE
}

const getMissingNonEmail = (state: { get: (k: string) => unknown }): FieldKey[] => {
    return getMissing(state).filter((k) => k !== 'email')
}

/** Nombre de persona (evita mandar "Dary Lopez" al clasificador de intenciones). */
const looksLikePersonName = (raw: string): boolean => {
    const t = raw.trim()
    if (!t || t.length > 50) return false
    if (/@|\d{2,}/.test(t)) return false
    return /^[\p{L}\s'.-]+$/u.test(t)
}

const friendlyFieldLabel: Record<FieldKey, string> = {
    name: 'tu nombre',
    service: 'el servicio (opcional)',
    date: 'la fecha (lun-vie)',
    time: `la hora (${BUSINESS_HOURS_LABEL})`,
    email: 'tu correo',
}

const buildInitialAppointmentPrompt = (): string =>
    `envíame tu nombre, el servicio (opcional), la fecha (lun-vie) y la hora (${BUSINESS_HOURS_LABEL}).`

const buildMissingPrompt = (missing: FieldKey[], name: string | null): string => {
    const hi = name ? `${name}, ` : ''
    if (missing.length === 0) return ''
    if (missing.length === 1) return `${hi}solo me falta ${friendlyFieldLabel[missing[0]]}.`
    const labels = missing.map((k) => friendlyFieldLabel[k])
    const last = labels.pop() as string
    return `${hi}envíame ${labels.join(', ')} y ${last}.`
}

const buildEmailPrompt = (): string =>
    'Por ultimo, pasame tu correo para enviarte la invitacion con el link de la reunion.'

type DirectNormalized = {
    date?: string
    time?: string
    rejectedDate?: string
    rejectedTime?: string
}

const tryDirectNormalize = (raw: string): DirectNormalized => {
    const out: DirectNormalized = {}
    const date = normalizeAppointmentDate(raw, new Date(), getAppointmentTimeZone())
    if (date) {
        if (isBusinessWeekday(date)) out.date = date
        else out.rejectedDate = date
    }
    const time = normalizeAppointmentTime(raw)
    if (time) {
        if (isWithinBusinessHours(time)) out.time = time
        else out.rejectedTime = time
    }
    return out
}

type BookResult =
    | { ok: true; message: string; clearField: null }
    | { ok: false; clearField: FieldKey | null; message: string }

const buildConfirmationMessage = (
    name: string,
    service: string,
    date: string,
    time: string,
    email: string,
    result: AppointmentResult
): string => {
    const lines = [
        `¡Listo ${name}! Te agende para el ${date} a las ${formatTime12h(time)} 📅`,
        `Servicio: ${service}.`,
    ]
    if (result.attendeeInvited) {
        lines.push(`Te llegara la invitacion a ${email} y ya quedo en tu calendario 📩`)
    } else if (result.addToCalendarUrl) {
        lines.push(`Agregalo a tu calendario: ${result.addToCalendarUrl}`)
    }
    if (result.meetLink) lines.push(`Link de Google Meet: ${result.meetLink}`)
    return lines.join('\n')
}

const tryBook = async (
    ctx: { from: string },
    state: { get: (k: string) => unknown; update: (data: Record<string, unknown>) => Promise<unknown> }
): Promise<BookResult> => {
    const name = getField(state, 'name')!
    const service = resolveServiceForBooking(state)
    const date = getField(state, 'date')!
    const time = getField(state, 'time')!
    const email = getField(state, 'email')!

    try {
        const available = await checkAvailability(date, time)
        if (!available) {
            const next = await findNextAvailableSlot(date, time)
            if (next) {
                await state.update({
                    appointmentOfferedDate: next.date,
                    appointmentOfferedTime: next.time,
                    [FIELD_STATE_KEY.time]: '',
                })
            } else {
                await state.update({
                    [FIELD_STATE_KEY.time]: '',
                    appointmentAwaitingAlternateSlot: true,
                })
            }
            return {
                ok: false,
                clearField: 'time',
                message: next
                    ? `Ese horario ya no esta disponible. ¿Te sirve a las ${formatTime12h(next.time)}?`
                    : 'Ese horario ya no esta disponible. ¿Que otro dia u hora te conviene?',
            }
        }
    } catch (error) {
        console.error('[appointment] Error checking availability:', error)
        if (error instanceof CalendarConfigurationError || isCalendarNotFoundError(error)) {
            return {
                ok: false,
                clearField: null,
                message: 'No puedo consultar la agenda ahora. Vuelve a intentarlo en un minuto.',
            }
        }
        return {
            ok: false,
            clearField: null,
            message: 'No puedo verificar la agenda ahora. Vuelve a intentarlo en un minuto.',
        }
    }

    try {
        const result = await createAppointment({
            name,
            reason: service,
            date,
            time,
            phone: ctx.from,
            email,
        })
        await clearAppointmentState(state)
        return {
            ok: true,
            clearField: null,
            message: buildConfirmationMessage(name, service, date, time, email, result),
        }
    } catch (error) {
        console.error('[appointment] Error creating event:', error)
        if (error instanceof CalendarConfigurationError || isCalendarNotFoundError(error)) {
            return {
                ok: false,
                clearField: null,
                message: 'No puedo guardar la cita ahora, intenta en un minuto.',
            }
        }
        return {
            ok: false,
            clearField: null,
            message: 'Hubo un problema al guardar la cita. ¿Lo intentamos de nuevo?',
        }
    }
}

const readyToBook = (state: { get: (k: string) => unknown }): boolean => {
    return getMissing(state).length === 0
}

const composePrompt = (base: string, rejections: Rejections): string => {
    const prefix = buildRejectionPrefix(rejections)
    return prefix ? `${prefix} ${base}` : base
}

/**
 * Email se pide al final una vez completos nombre, fecha y hora. Si todavia faltan
 * datos basicos, no acribillamos al usuario con "y tu correo" en cada prompt.
 */
const buildNextPromptBase = (state: { get: (k: string) => unknown }): string => {
    const missingNonEmail = getMissingNonEmail(state)
    if (missingNonEmail.length > 0) {
        if (!getField(state, 'name') && !getField(state, 'date') && !getField(state, 'time')) {
            return buildInitialAppointmentPrompt()
        }
        return buildMissingPrompt(missingNonEmail, getField(state, 'name'))
    }
    if (!getField(state, 'email')) return buildEmailPrompt()
    return ''
}

const hasDateAndTime = (state: { get: (k: string) => unknown }): boolean =>
    Boolean(getField(state, 'date') && getField(state, 'time'))

const runSlotNegotiationIfNeeded = async (
    state: { get: (k: string) => unknown; update: (data: Record<string, unknown>) => Promise<unknown> },
    body?: string
): Promise<{ block: boolean; message?: string }> => {
    const date = getField(state, 'date')
    const time = getField(state, 'time')
    if (!date || !time) return { block: false }

    const result = await negotiateAppointmentSlot(state, date, time, body)
    if (result.status === 'ok') return { block: false }
    if (result.status === 'error') return { block: true, message: result.message }
    return { block: true, message: result.message }
}

const promptForNextStep = async (
    state: { get: (k: string) => unknown },
    flowDynamic: (msg: string) => Promise<unknown>,
    rejections: Rejections = {}
): Promise<void> => {
    const base = buildNextPromptBase(state)
    if (!base) return
    await flowDynamic(composePrompt(base, rejections))
}

export const appointmentFlow = addKeyword<Provider, Database>(utils.setEvent('APPOINTMENT_FLOW'))
    .addAction(async (ctx, { state, flowDynamic, endFlow }) => {
        await state.update({ appointmentBookingActive: true })
        const initial = (state.get('appointmentInitialMessage') as string | undefined) ?? ctx.body
        let initialRejections: Rejections = {}
        if (initial && !state.get('appointmentExtracted')) {
            try {
                const extracted = await extractAppointmentFields(initial)
                initialRejections = await mergeExtraction(state, extracted)
            } catch (error) {
                console.error('[appointment] Initial extraction failed:', error)
            }
            const direct = tryDirectNormalize(initial)
            initialRejections = mergeRejections(initialRejections, {
                rejectedDate: direct.rejectedDate,
                rejectedTime: direct.rejectedTime,
            })
            await state.update({ appointmentExtracted: true })
        }

        if (hasDateAndTime(state)) {
            const slot = await runSlotNegotiationIfNeeded(state, initial)
            if (slot.block && slot.message) {
                await flowDynamic(slot.message)
                return
            }
        }

        if (readyToBook(state)) {
            const result = await tryBook(ctx, state)
            await flowDynamic(result.message)
            if (result.ok) return endFlow()
            if (result.clearField === null) return endFlow()
        }

        await promptForNextStep(state, flowDynamic, initialRejections)
    })
    .addAction({ capture: true }, async (ctx, { state, fallBack, flowDynamic, endFlow, gotoFlow }) => {
        const rerouted = await dispatchByIntent(ctx, state, gotoFlow)
        if (rerouted) return

        const body = ctx.body.trim()
        const nonEmailMissing = getMissingNonEmail(state)
        const emailMissing = !getField(state, 'email')
        const onlyEmailMissing = nonEmailMissing.length === 0 && emailMissing
        let rejections: Rejections = {}

        if (onlyEmailMissing) {
            const email = extractEmail(body)
            if (email) {
                await state.update({ [FIELD_STATE_KEY.email]: email })
            } else {
                return fallBack('No reconoci un correo valido. Escribelo (ej: tu@correo.com).')
            }
        } else {
            const direct = tryDirectNormalize(body)
            const directEmail = extractEmail(body)
            const directHasAnyDateTime =
                Boolean(direct.date || direct.time || direct.rejectedDate || direct.rejectedTime)
            const looksLikeSingleField = !directHasAnyDateTime && !directEmail

            if (
                nonEmailMissing.includes('name') &&
                looksLikePersonName(body) &&
                looksLikeSingleField
            ) {
                await state.update({ [FIELD_STATE_KEY.name]: body })
            } else if (nonEmailMissing.length === 1 && nonEmailMissing[0] === 'name' && body.length <= 60 && looksLikeSingleField) {
                await state.update({ [FIELD_STATE_KEY.name]: body })
            } else if (
                !getField(state, 'service') &&
                nonEmailMissing.length === 0 &&
                emailMissing &&
                body.length <= 120 &&
                looksLikeSingleField &&
                !looksLikePersonName(body)
            ) {
                await state.update({ [FIELD_STATE_KEY.service]: mapServiceToCatalog(body) })
            } else {
                try {
                    const extracted = await extractAppointmentFields(body)
                    rejections = await mergeExtraction(state, extracted)
                } catch (error) {
                    console.error('[appointment] Re-extraction failed:', error)
                }
                if (direct.date && !getField(state, 'date')) {
                    await state.update({ [FIELD_STATE_KEY.date]: direct.date })
                }
                if (direct.time && !getField(state, 'time')) {
                    await state.update({ [FIELD_STATE_KEY.time]: direct.time })
                }
                if (directEmail && !getField(state, 'email')) {
                    await state.update({ [FIELD_STATE_KEY.email]: directEmail })
                }
                rejections = mergeRejections(rejections, {
                    rejectedDate: direct.rejectedDate,
                    rejectedTime: direct.rejectedTime,
                })
            }
        }

        if (hasDateAndTime(state)) {
            const slot = await runSlotNegotiationIfNeeded(state, body)
            if (slot.block && slot.message) {
                return fallBack(slot.message)
            }
        }

        if (!readyToBook(state)) {
            const base = buildNextPromptBase(state)
            return fallBack(composePrompt(base, rejections))
        }

        const result = await tryBook(ctx, state)
        await flowDynamic(result.message)
        if (result.ok) return endFlow()
        if (result.clearField === null) return endFlow()
        return fallBack(buildNextPromptBase(state))
    })
