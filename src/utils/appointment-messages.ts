import {
    BUSINESS_DAYS_LABEL,
    BUSINESS_HOURS_LABEL,
    BUSINESS_SCHEDULE_LABEL,
} from './appointment-datetime'
import { mapServiceToCatalog } from '../services/extractor.service'

const stripForMatch = (raw: string): string =>
    raw
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()

/** Pregunta informativa sobre horario de citas (no es una fecha/hora concreta). */
export function userAsksAboutAppointmentHours(raw: string): boolean {
    const t = stripForMatch(raw)
    if (!t) return false
    if (/\b(que|cuales)\s+horari[oa]s?\b/.test(t)) return true
    if (/\bhorari[oa]\s+(puedo|podemos|hay|tienen|atienden|disponible)\b/.test(t)) return true
    if (/\b(puedo|podemos|se\s+puede)\s+agendar\b.*\b(que|a\s+que)\s+horas?\b/.test(t)) return true
    if (/\ba\s+que\s+hora(s)?\s+(puedo|podemos|se\s+puede)\b/.test(t)) return true
    if (/\by\s+que\s+horario\b/.test(t)) return true
    if (/\bdisponibilidad\s+(de\s+)?horarios?\b/.test(t)) return true
    if (/\bcuando\s+(atienden|abren|cierran|puedo\s+agendar)\b/.test(t)) return true
    return false
}

export const BUSINESS_SCHEDULE_REPLY = `El horario para citas es de ${BUSINESS_SCHEDULE_LABEL}.`

export const APPOINTMENT_BOOKING_NUDGE =
    'Si quieres agendar, dime que dia y hora te acomoda o escribe *agendar cita*.'

export const APPOINTMENT_KICKOFF_PROMPT =
    `Muy bien, necesitare tu nombre, el dia y la hora que te resulte, nuestro horario es de ${BUSINESS_SCHEDULE_LABEL}.`

export const buildInitialAppointmentPrompt = (): string => APPOINTMENT_KICKOFF_PROMPT

/**
 * Pre-selecciona el servicio del que el usuario pidio informacion (chatLastMentionedService).
 * No sobrescribe si ya hay servicio explicito en la cita.
 */
export async function seedAppointmentServiceFromLastTopic(state: {
    get: (key: string) => unknown
    update: (data: Record<string, unknown>) => Promise<unknown>
}): Promise<void> {
    const current = state.get('appointmentService')
    if (typeof current === 'string' && current.trim().length > 0) return

    const last = state.get('chatLastMentionedService')
    if (typeof last === 'string' && last.trim().length > 0) {
        await state.update({ appointmentService: mapServiceToCatalog(last) })
    }
}

export const buildEmailPrompt = (): string =>
    'Genial. ¿Me pasas tu correo para enviarte la invitacion con el link de la reunion?'

export const INVALID_EMAIL_FORMAT_PROMPT =
    'El correo debe ser en formato con @. Ejemplo: tu@correo.com'

/** Texto sin @ que parece usuario/correo mal escrito (no un nombre corto). */
export function looksLikeEmailAttemptWithoutAt(raw: string): boolean {
    const t = raw.trim()
    if (!t || t.includes('@')) return false
    if (/\s/.test(t)) return false
    if (t.length < 8) return false
    return /^[\p{L}0-9._-]+$/u.test(t)
}

/** Cuando ya hay dia y hora validos; solo faltan datos de contacto. */
export const COMPLETE_APPOINTMENT_DETAILS_PROMPT =
    'Perfecto, para completar tu cita indicame tu nombre y correo para enviartela.'

export const buildPostSlotDetailsPrompt = (opts: {
    nameMissing: boolean
    emailMissing: boolean
}): string => {
    const { nameMissing, emailMissing } = opts
    if (nameMissing && emailMissing) return COMPLETE_APPOINTMENT_DETAILS_PROMPT
    if (nameMissing) return 'Perfecto ese horario. ¿Como te llamas?'
    if (emailMissing) return buildEmailPrompt()
    return ''
}

export const WEEKEND_REJECTION_MESSAGE =
    `Ese dia es fin de semana; nuestro horario es de ${BUSINESS_SCHEDULE_LABEL}. ¿Que otro dia te viene bien?`

export const buildWeekendRejectionLine = (): string => WEEKEND_REJECTION_MESSAGE

export const buildAfterHoursRejectionLine = (timeLabel: string): string =>
    `${timeLabel} queda fuera del horario de citas (${BUSINESS_HOURS_LABEL}). ¿Probamos con otra hora?`

type BookingContinuation = {
    needsName: boolean
    needsDate: boolean
    needsTime: boolean
    hasDateAndTime: boolean
}

export const buildBookingContinuationHint = (ctx: BookingContinuation): string => {
    if (ctx.hasDateAndTime && ctx.needsName) {
        return 'Cuando quieras, dime tu nombre y seguimos con la reserva.'
    }
    if (!ctx.needsDate && !ctx.needsTime && !ctx.needsName) {
        return 'Si ya tienes dia y hora en mente, dimelas y coordinamos tu cita.'
    }
    if (ctx.needsDate && ctx.needsTime) {
        return 'Si ya tienes dia y hora en mente, dimelas y coordinamos tu cita.'
    }
    if (ctx.needsDate) return `¿Que dia te queda bien (${BUSINESS_DAYS_LABEL})?`
    if (ctx.needsTime) return `¿A que hora te acomoda (${BUSINESS_HOURS_LABEL})?`
    if (ctx.needsName) return '¿Como te llamas? Asi personalizo la invitacion.'
    return 'Cuando quieras, seguimos con tu cita.'
}

export const buildBusinessHoursReply = (continuation: string): string =>
    continuation ? `${BUSINESS_SCHEDULE_REPLY}\n\n${continuation}` : BUSINESS_SCHEDULE_REPLY

const SCHEDULE_REMINDER = `nuestro horario es de ${BUSINESS_SCHEDULE_LABEL}`

export const buildMissingFieldsPrompt = (
    missingLabels: string[],
    name: string | null
): string => {
    if (missingLabels.length === 0) return ''

    const okPrefix = name?.trim() ? `Ok, ${name.trim()}, ` : ''
    const needsDate = missingLabels.some((l) => l.includes('fecha'))
    const needsTime = missingLabels.some((l) => l.includes('hora'))
    const needsName = missingLabels.some((l) => l.includes('nombre'))
    const needsEmail = missingLabels.some((l) => l.includes('correo'))

    if (needsName && missingLabels.length === 1) return '¿Como te llamas?'
    if (needsEmail && missingLabels.length === 1) return buildEmailPrompt()

    if (needsDate && needsTime) {
        return `${okPrefix}me falta la fecha y hora, ${SCHEDULE_REMINDER}.`
    }
    if (needsDate) {
        return `Perfecto, ¿que dia te queda bien (${BUSINESS_DAYS_LABEL})?`
    }
    if (needsTime) {
        return 'Perfecto, ¿a que hora quieres la reunion?'
    }
    if (needsName) return `${okPrefix}¿como te llamas?`

    return `${okPrefix}me falta un poco mas de informacion para tu cita.`
}
