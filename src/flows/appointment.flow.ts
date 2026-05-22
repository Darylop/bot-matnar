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
    BUSINESS_DATE_FIELD_LABEL,
    BUSINESS_TIME_FIELD_LABEL,
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
import { getDeterministicIntent } from './flow-guard'
import { hasPendingSlotOffer, negotiateAppointmentSlot } from './appointment-slot'
import { looksLikeAffirmative, looksLikeSlotAcceptance } from '../utils/affirmative'
import {
    buildAfterHoursRejectionLine,
    buildBookingContinuationHint,
    buildBusinessHoursReply,
    buildEmailPrompt,
    buildInitialAppointmentPrompt,
    INVALID_EMAIL_FORMAT_PROMPT,
    looksLikeEmailAttemptWithoutAt,
    buildMissingFieldsPrompt,
    buildPostSlotDetailsPrompt,
    COMPLETE_APPOINTMENT_DETAILS_PROMPT,
    seedAppointmentServiceFromLastTopic,
    userAsksAboutAppointmentHours,
    WEEKEND_REJECTION_MESSAGE,
} from '../utils/appointment-messages'

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

/** Respuestas de confirmacion de horario que no son nombres de persona. */
const isInvalidStoredName = (raw: string | null): boolean => {
    if (!raw) return false
    return looksLikeSlotAcceptance(raw) || looksLikeAffirmative(raw)
}

const getEffectiveName = (state: { get: (k: string) => unknown }): string | null => {
    const name = getField(state, 'name')
    if (name && isInvalidStoredName(name)) return null
    return name
}

const clearInvalidName = async (
    state: { update: (data: Record<string, unknown>) => Promise<unknown>; get: (k: string) => unknown }
): Promise<void> => {
    if (isInvalidStoredName(getField(state, 'name'))) {
        await state.update({ [FIELD_STATE_KEY.name]: '' })
    }
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
    if (rej.rejectedTime) parts.push(buildAfterHoursRejectionLine(formatTime12h(rej.rejectedTime)))
    if (rej.rejectedDate) parts.push(WEEKEND_REJECTION_MESSAGE)
    return parts.join(' ')
}

/** Rechazos (fin de semana / hora) van solos; no mezclar con "me faltan nombre y fecha". */
const composeUserPrompt = (
    state: { get: (k: string) => unknown },
    rejections: Rejections
): string => {
    if (rejections.rejectedDate || rejections.rejectedTime) {
        return buildRejectionPrefix(rejections)
    }
    return buildNextPromptBase(state)
}

const mergeExtraction = async (
    state: { update: (data: Record<string, unknown>) => Promise<unknown>; get: (k: string) => unknown },
    extracted: AppointmentFields
): Promise<Rejections> => {
    const patch: Record<string, string> = {}
    const rejections: Rejections = {}
    if (!getEffectiveName(state) && extracted.name && !isInvalidStoredName(extracted.name)) {
        patch[FIELD_STATE_KEY.name] = extracted.name
    }
    if (extracted.service) {
        const current = getField(state, 'service')
        if (!current || extracted.service !== current) {
            patch[FIELD_STATE_KEY.service] = extracted.service
        }
    }
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
    return REQUIRED_FIELDS.filter((k) => {
        if (k === 'name') return !getEffectiveName(state)
        return !getField(state, k)
    })
}

const resolveServiceForBooking = (state: { get: (k: string) => unknown }): string => {
    const explicit = getField(state, 'service')
    if (explicit) return explicit
    return DEFAULT_APPOINTMENT_SERVICE
}

const getMissingNonEmail = (state: { get: (k: string) => unknown }): FieldKey[] => {
    return getMissing(state).filter((k) => k !== 'email')
}

/** Nombre de persona (evita mandar "Dary Lopez" al clasificador de intenciones). */
const looksLikePersonName = (raw: string): boolean => {
    const t = raw.trim()
    if (!t || t.length > 50) return false
    if (isInvalidStoredName(t)) return false
    if (getDeterministicIntent(t)) return false
    if (/@|\d{2,}/.test(t)) return false
    if (/\b(cancelar|cancela|quiero|agendar|reservar|cita|reunion|servicio|chiste|menu|salir|sirve)\b/i.test(t)) {
        return false
    }
    if (t.split(/\s+/).length > 4) return false
    return /^[\p{L}\s'.-]+$/u.test(t)
}

const friendlyFieldLabel: Record<FieldKey, string> = {
    name: 'tu nombre',
    service: 'el servicio (opcional)',
    date: BUSINESS_DATE_FIELD_LABEL,
    time: BUSINESS_TIME_FIELD_LABEL,
    email: 'tu correo',
}

const buildMissingPrompt = (missing: FieldKey[], name: string | null): string => {
    const validName = name && !isInvalidStoredName(name) ? name : null
    const labels = missing.map((k) => friendlyFieldLabel[k])
    return buildMissingFieldsPrompt(labels, validName)
}

const buildPostSlotPrompt = (state: { get: (k: string) => unknown }): string =>
    buildPostSlotDetailsPrompt({
        nameMissing: !getEffectiveName(state),
        emailMissing: !getField(state, 'email'),
    })

const buildHoursReplyForState = (state: { get: (k: string) => unknown }): string => {
    const missing = getMissingNonEmail(state)
    return buildBusinessHoursReply(
        buildBookingContinuationHint({
            needsName: missing.includes('name'),
            needsDate: missing.includes('date'),
            needsTime: missing.includes('time'),
            hasDateAndTime: hasDateAndTime(state),
        })
    )
}

const isSlotConfirmationMessage = (body: string): boolean =>
    looksLikeSlotAcceptance(body) || looksLikeAffirmative(body)

const collectFinalDetails = async (
    state: { get: (k: string) => unknown; update: (data: Record<string, unknown>) => Promise<unknown> },
    body: string
): Promise<{ prompt: string } | { ready: true }> => {
    await clearInvalidName(state)

    const email = extractEmail(body)
    if (email) {
        await state.update({ [FIELD_STATE_KEY.email]: email })
    }

    const nameMissing = !getEffectiveName(state)
    const emailMissing = !getField(state, 'email')
    const onlyNeedsEmail = emailMissing && !nameMissing

    if (onlyNeedsEmail && !email && (body.includes('@') || looksLikeEmailAttemptWithoutAt(body))) {
        return { prompt: INVALID_EMAIL_FORMAT_PROMPT }
    }

    if (!email && nameMissing && looksLikePersonName(body) && body.length <= 40) {
        await state.update({ [FIELD_STATE_KEY.name]: body.trim() })
    }

    if (getMissing(state).length === 0) {
        return { ready: true }
    }

    if (isSlotConfirmationMessage(body)) {
        return { prompt: buildPostSlotPrompt(state) }
    }

    return { prompt: buildPostSlotPrompt(state) }
}

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
    await clearInvalidName(state)
    const name = getEffectiveName(state)!
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

/**
 * Email se pide al final una vez completos nombre, fecha y hora. Si todavia faltan
 * datos basicos, no acribillamos al usuario con "y tu correo" en cada prompt.
 */
const isEmailOnlyMessage = (body: string): boolean => {
    const email = extractEmail(body)
    if (!email) return false
    const rest = body.replace(new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').trim()
    return rest.replace(/[.,!?¡¿\s-]/g, '').length === 0
}

const buildNextPromptBase = (state: { get: (k: string) => unknown }): string => {
    if (hasPendingSlotOffer(state)) return ''

    const nameMissing = !getEffectiveName(state)
    const emailMissing = !getField(state, 'email')

    if (hasDateAndTime(state)) {
        if (nameMissing && emailMissing) return COMPLETE_APPOINTMENT_DETAILS_PROMPT
        if (nameMissing) return 'Perfecto. ¿Como te llamas?'
        if (emailMissing) return buildEmailPrompt()
        return ''
    }

    const missingNonEmail = getMissingNonEmail(state)
    if (missingNonEmail.length > 0) {
        if (!getField(state, 'name') && !getField(state, 'date') && !getField(state, 'time')) {
            return buildInitialAppointmentPrompt()
        }
        return buildMissingPrompt(missingNonEmail, getEffectiveName(state))
    }
    if (emailMissing) return buildEmailPrompt()
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
    const msg = composeUserPrompt(state, rejections)
    if (!msg) return
    await flowDynamic(msg)
}

export const appointmentFlow = addKeyword<Provider, Database>(utils.setEvent('APPOINTMENT_FLOW'))
    .addAction(async (ctx, { state, flowDynamic, endFlow, gotoFlow }) => {
        await state.update({ appointmentBookingActive: true })
        await seedAppointmentServiceFromLastTopic(state)
        const initial = (state.get('appointmentInitialMessage') as string | undefined) ?? ctx.body
        if (initial && getDeterministicIntent(initial)) {
            const rerouted = await dispatchByIntent({ body: initial }, state, gotoFlow)
            if (rerouted) return
        }
        let initialRejections: Rejections = {}
        const initialIsShortAck =
            Boolean(initial) && (isSlotConfirmationMessage(initial) || looksLikeAffirmative(initial))
        if (initial && !state.get('appointmentExtracted') && !initialIsShortAck) {
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
        } else if (initialIsShortAck) {
            await state.update({ appointmentExtracted: true })
        }

        if (initial && userAsksAboutAppointmentHours(initial) && !hasDateAndTime(state)) {
            await flowDynamic(buildHoursReplyForState(state))
            return
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

        if (userAsksAboutAppointmentHours(body)) {
            return fallBack(buildHoursReplyForState(state))
        }
        const nonEmailMissing = getMissingNonEmail(state)
        const emailMissing = !getField(state, 'email')
        const nameMissing = !getEffectiveName(state)
        const slotConfirmed = hasDateAndTime(state) && !hasPendingSlotOffer(state)
        const collectingAfterSlot =
            slotConfirmed && (nameMissing || emailMissing) && nonEmailMissing.every((k) => k === 'name')
        let rejections: Rejections = {}

        if (hasPendingSlotOffer(state) && hasDateAndTime(state)) {
            const slot = await runSlotNegotiationIfNeeded(state, body)
            if (slot.block && slot.message) {
                return fallBack(slot.message)
            }
            if (!hasPendingSlotOffer(state) && isSlotConfirmationMessage(body)) {
                const details = await collectFinalDetails(state, body)
                if ('prompt' in details && details.prompt) {
                    return fallBack(details.prompt)
                }
            }
        }

        if (collectingAfterSlot || (nonEmailMissing.length === 0 && emailMissing)) {
            const details = await collectFinalDetails(state, body)
            if ('ready' in details) {
                // sigue abajo a tryBook
            } else {
                return fallBack(details.prompt)
            }
        } else if (isSlotConfirmationMessage(body) && hasDateAndTime(state)) {
            await clearInvalidName(state)
            return fallBack(buildPostSlotPrompt(state))
        } else {
            const direct = tryDirectNormalize(body)
            const directEmail = extractEmail(body)
            const directHasAnyDateTime =
                Boolean(direct.date || direct.time || direct.rejectedDate || direct.rejectedTime)
            const looksLikeSingleField = !directHasAnyDateTime && !directEmail

            if (
                nonEmailMissing.includes('name') &&
                looksLikePersonName(body) &&
                looksLikeSingleField &&
                !isSlotConfirmationMessage(body)
            ) {
                await state.update({ [FIELD_STATE_KEY.name]: body })
            } else if (
                nonEmailMissing.length === 1 &&
                nonEmailMissing[0] === 'name' &&
                body.length <= 60 &&
                looksLikeSingleField &&
                !isSlotConfirmationMessage(body)
            ) {
                await state.update({ [FIELD_STATE_KEY.name]: body })
            } else if (
                !getField(state, 'service') &&
                nonEmailMissing.length === 0 &&
                emailMissing &&
                body.length <= 120 &&
                looksLikeSingleField &&
                !looksLikePersonName(body) &&
                !isSlotConfirmationMessage(body)
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
            const slotBody = isEmailOnlyMessage(body) ? undefined : body
            const slot = await runSlotNegotiationIfNeeded(state, slotBody)
            if (slot.block && slot.message) {
                return fallBack(slot.message)
            }
        }

        if (!readyToBook(state)) {
            return fallBack(composeUserPrompt(state, rejections))
        }

        const result = await tryBook(ctx, state)
        await flowDynamic(result.message)
        if (result.ok) return endFlow()
        if (result.clearField === null) return endFlow()
        return fallBack(buildNextPromptBase(state))
    })
