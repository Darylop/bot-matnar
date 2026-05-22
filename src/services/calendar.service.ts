import { google, calendar_v3 } from 'googleapis'
import path from 'path'
import crypto from 'crypto'
import {
    addBusinessSlotStep,
    formatTime12h,
    getAppointmentTimeZone,
    isBusinessWeekday,
    isWithinBusinessHours,
} from '../utils/appointment-datetime'

export type AppointmentData = {
    name: string
    reason: string
    date: string  // format: DD/MM/YYYY
    time: string  // format: HH:MM (24h)
    phone: string
    email?: string | null
}

export type AppointmentResult = {
    eventId: string
    htmlLink: string
    meetLink: string | null
    addToCalendarUrl: string
    /** True si el cliente quedo agregado como `attendee` del evento (recibe invitacion por correo). */
    attendeeInvited: boolean
}

export class CalendarConfigurationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'CalendarConfigurationError'
    }
}

/**
 * Builds a local datetime string (no Z suffix) so Google Calendar
 * interprets it in the timezone specified separately.
 * Format: YYYY-MM-DDTHH:MM:SS
 */
const buildDateTimeString = (date: string, time: string): string => {
    const [day, month, year] = date.split('/')
    const [hour, minute] = time.split(':')
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:00`
}

const hasOAuthCredentials = (): boolean => {
    return Boolean(
        process.env.GOOGLE_OAUTH_CLIENT_ID &&
            process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
            process.env.GOOGLE_OAUTH_REFRESH_TOKEN
    )
}

/**
 * Devuelve `true` si la API actual puede agregar invitados y crear Google Meet
 * en eventos del calendario configurado. Hoy lo asociamos al uso de OAuth: una
 * service account sin Domain-Wide Delegation no puede invitar atendees ni
 * generar Meet en cuentas Gmail personales, mientras que OAuth con refresh
 * token del dueno del calendario si puede.
 */
export const canInviteAttendees = (): boolean => hasOAuthCredentials()

const getCalendarClient = () => {
    if (hasOAuthCredentials()) {
        const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!.trim()
        const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET!.trim()
        const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN!.trim()
        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret)
        oauth2Client.setCredentials({ refresh_token: refreshToken })
        return google.calendar({ version: 'v3', auth: oauth2Client })
    }

    const keyFile = path.resolve(
        process.env.GOOGLE_SERVICE_ACCOUNT_PATH ?? './credentials/google-service-account.json'
    )
    const auth = new google.auth.GoogleAuth({
        keyFile,
        scopes: ['https://www.googleapis.com/auth/calendar'],
    })
    return google.calendar({ version: 'v3', auth })
}

const getCalendarConfig = () => {
    const timezone = (process.env.TIMEZONE ?? 'America/Bogota').trim()
    const calendarId = (process.env.GOOGLE_CALENDAR_ID ?? 'primary').trim()

    if (!calendarId) {
        throw new CalendarConfigurationError(
            'GOOGLE_CALENDAR_ID esta vacio. Configura un ID de calendario valido en .env.'
        )
    }

    return { timezone, calendarId }
}

export const isCalendarNotFoundError = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false

    const maybeError = error as {
        code?: number
        status?: number
        response?: { status?: number }
    }

    return maybeError.code === 404 || maybeError.status === 404 || maybeError.response?.status === 404
}

/** Log claro cuando la API devuelve 404 (muy frecuente si el calendario no esta compartido con la service account). */
const logCalendarNotFoundHint = (calendarId: string): void => {
    console.error(
        `[calendar] 404 Not Found para calendarId="${calendarId}". ` +
            'Con GoogleAuth por service account: en Google Calendar, comparte este calendario con el campo `client_email` ' +
            'del JSON de credenciales (permiso "Hacer cambios en los eventos" o superior). ' +
            'Verifica que GOOGLE_CALENDAR_ID sea exactamente el "ID del calendario" de Ajustes > Integrar calendario.'
    )
}

const APPOINTMENT_DURATION_MS = 30 * 60 * 1000

type YmdHm = { year: number; month: number; day: number; hour: number; minute: number }

const getYmdHmInTimeZone = (instant: Date, timeZone: string): YmdHm => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(instant)

    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
    let hour = get('hour')
    if (hour === 24) hour = 0
    return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') }
}

/** Convierte fecha/hora civil (DD/MM/AAAA, HH:MM) en la zona del negocio a instante UTC (ms). */
export const wallClockToUtcMillis = (
    ddMmYyyy: string,
    hhMm: string,
    timeZone: string = getAppointmentTimeZone()
): number => {
    const [day, month, year] = ddMmYyyy.split('/').map(Number)
    const [hour, minute] = hhMm.split(':').map(Number)
    let t = Date.UTC(year, month - 1, day, hour, minute, 0)

    for (let i = 0; i < 48; i++) {
        const p = getYmdHmInTimeZone(new Date(t), timeZone)
        if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) {
            return t
        }
        const target = year * 525_960 + month * 43_800 + day * 1_440 + hour * 60 + minute
        const actual = p.year * 525_960 + p.month * 43_800 + p.day * 1_440 + p.hour * 60 + p.minute
        t += (target - actual) * 60_000
    }

    return t
}

const parseEventInstant = (
    ev: calendar_v3.Schema$Event,
    timeZone: string
): { startMs: number; endMs: number } | null => {
    const startRaw = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00` : null)
    const endRaw = ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T00:00:00` : null)
    if (!startRaw || !endRaw) return null
    const startMs = Date.parse(startRaw)
    const endMs = Date.parse(endRaw)
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null
    if (!ev.start?.dateTime && ev.start?.date) {
        // Evento de dia completo: fin exclusivo al dia siguiente
        return { startMs, endMs: endMs || startMs + 86400000 }
    }
    return { startMs, endMs }
}

const slotOverlapsEvents = (
    slotStartMs: number,
    slotEndMs: number,
    events: calendar_v3.Schema$Event[]
): boolean => {
    return events.some((ev) => {
        const bounds = parseEventInstant(ev, '')
        if (!bounds) return false
        return bounds.startMs < slotEndMs && bounds.endMs > slotStartMs
    })
}

/**
 * Comprueba si el hueco de 30 minutos (date+time) esta libre.
 * Pasa `ignoreEventId` al reprogramar para no contar el propio evento.
 */
export async function checkAvailability(
    date: string,
    time: string,
    ignoreEventId?: string
): Promise<boolean> {
    const calendar = getCalendarClient()
    const { timezone, calendarId } = getCalendarConfig()

    const slotStartMs = wallClockToUtcMillis(date, time, timezone)
    const slotEndMs = slotStartMs + APPOINTMENT_DURATION_MS
    const dayStartMs = wallClockToUtcMillis(date, '00:00', timezone)
    const dayEndMs = wallClockToUtcMillis(date, '23:59', timezone) + 60_000

    let response
    try {
        response = await calendar.events.list({
            calendarId,
            timeMin: new Date(dayStartMs).toISOString(),
            timeMax: new Date(dayEndMs).toISOString(),
            timeZone: timezone,
            singleEvents: true,
            orderBy: 'startTime',
        })
    } catch (error) {
        if (isCalendarNotFoundError(error)) {
            logCalendarNotFoundHint(calendarId)
        }
        throw error
    }

    const items = response.data.items ?? []
    const filtered = ignoreEventId ? items.filter((ev) => ev.id !== ignoreEventId) : items
    return !slotOverlapsEvents(slotStartMs, slotEndMs, filtered)
}

/**
 * Primer hueco libre a partir de date+time (incluido), en pasos de 30 min y dias habiles.
 */
export async function findNextAvailableSlot(
    date: string,
    time: string,
    maxAttempts = 80
): Promise<{ date: string; time: string } | null> {
    let candidateDate = date
    let candidateTime = time

    for (let i = 0; i < maxAttempts; i++) {
        if (isBusinessWeekday(candidateDate) && isWithinBusinessHours(candidateTime)) {
            if (await checkAvailability(candidateDate, candidateTime)) {
                return { date: candidateDate, time: candidateTime }
            }
        }
        const next = addBusinessSlotStep(candidateDate, candidateTime)
        candidateDate = next.date
        candidateTime = next.time
    }

    return null
}

/**
 * Resumen de una cita ya guardada en Google Calendar, util para flujos de cancelar / editar.
 */
export type StoredAppointment = {
    eventId: string
    summary: string
    description: string
    /** ISO start, p.ej. "2026-05-15T10:00:00-05:00" o "2026-05-15T10:00:00" */
    startIso: string
    /** ISO end con el mismo formato que startIso */
    endIso: string
    email: string | null
    meetLink: string | null
}

const extractMeetLink = (event: calendar_v3.Schema$Event): string | null => {
    const entry = event.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === 'video')
    return entry?.uri ?? null
}

/**
 * Una service account sin Domain-Wide Delegation no puede crear Google Meet
 * en calendarios de cuentas Gmail personales: Google responde
 * `400 Invalid conference type value`. Detectamos ese caso para reintentar
 * el alta del evento sin `conferenceData`.
 */
const isInvalidConferenceTypeError = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false
    const maybeError = error as {
        code?: number
        status?: number
        errors?: Array<{ message?: string; reason?: string }>
    }
    if (maybeError.code !== 400 && maybeError.status !== 400) return false
    return (maybeError.errors ?? []).some(
        (e) => e?.message === 'Invalid conference type value.'
    )
}

/**
 * Una service account sin Domain-Wide Delegation tampoco puede invitar
 * atendees: Google responde `403 forbiddenForServiceAccounts`. En ese caso
 * reintentamos el alta sin `attendees` y dejamos solo el link "agregar a
 * calendario" como fallback.
 */
const isForbiddenForServiceAccountsError = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false
    const maybeError = error as {
        code?: number
        status?: number
        errors?: Array<{ message?: string; reason?: string }>
    }
    if (maybeError.code !== 403 && maybeError.status !== 403) return false
    return (maybeError.errors ?? []).some(
        (e) => e?.reason === 'forbiddenForServiceAccounts'
    )
}

const extractAttendeeEmail = (event: calendar_v3.Schema$Event): string | null => {
    const attendees = event.attendees ?? []
    const guest = attendees.find((a) => a.email && !a.organizer && !a.resource)
    return guest?.email ?? null
}

const mapEventToStoredAppointment = (ev: calendar_v3.Schema$Event): StoredAppointment => ({
    eventId: ev.id!,
    summary: ev.summary ?? '',
    description: ev.description ?? '',
    startIso: ev.start?.dateTime ?? ev.start?.date ?? '',
    endIso: ev.end?.dateTime ?? ev.end?.date ?? '',
    email: extractAttendeeEmail(ev),
    meetLink: extractMeetLink(ev),
})

/**
 * Lista todas las citas futuras del contacto (ordenadas por fecha).
 * Se basa en el marcador "WhatsApp: <phone>" en la descripcion del evento.
 */
export async function listUpcomingAppointmentsByPhone(phone: string): Promise<StoredAppointment[]> {
    const calendar = getCalendarClient()
    const { timezone, calendarId } = getCalendarConfig()

    const nowIso = new Date().toISOString()
    let response
    try {
        response = await calendar.events.list({
            calendarId,
            timeMin: nowIso,
            timeZone: timezone,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 50,
            q: phone,
        })
    } catch (error) {
        if (isCalendarNotFoundError(error)) {
            logCalendarNotFoundHint(calendarId)
        }
        throw error
    }

    const marker = `WhatsApp: ${phone}`
    const items = response.data.items ?? []
    return items
        .filter((ev) => ev.id && (ev.description ?? '').includes(marker))
        .map((ev) => mapEventToStoredAppointment(ev))
}

/**
 * Busca la proxima cita futura asociada a un numero de WhatsApp.
 */
export async function findUpcomingAppointmentByPhone(phone: string): Promise<StoredAppointment | null> {
    const list = await listUpcomingAppointmentsByPhone(phone)
    return list[0] ?? null
}

const APPOINTMENTS_LIST_FOOTER =
    'Para cancelar una: *cancelar cita* o *cancelar cita 1*\nPara cancelar todas: *cancelar todas las citas*\nPara cambiar fecha u hora: *modificar cita*\nEscribe *menu* para volver al inicio.'

/**
 * Mensaje de WhatsApp con el listado numerado de citas del contacto.
 */
export function formatAppointmentsListMessage(appointments: StoredAppointment[]): string {
    if (appointments.length === 0) {
        return `No tienes citas programadas por ahora 📅\n¿Quieres agendar una? Escribe *agendar cita* o elige la opcion 3 del menu.`
    }

    const header =
        appointments.length === 1
            ? 'Esta es tu cita pendiente 📅'
            : `Tienes ${appointments.length} citas programadas 📅`

    const lines: string[] = [header, '']
    appointments.forEach((apt, index) => {
        const fmt = formatStoredDateTime(apt.startIso)
        const { reason } = parseAppointmentDescription(apt.description)
        const service = reason || apt.summary || 'Reunion Matnar'
        if (fmt) {
            lines.push(`${index + 1}. ${service} — ${fmt.date} a las ${formatTime12h(fmt.time)}`)
        } else {
            lines.push(`${index + 1}. ${service}`)
        }
        if (apt.meetLink) lines.push(`   Meet: ${apt.meetLink}`)
    })
    lines.push('', APPOINTMENTS_LIST_FOOTER)
    return lines.join('\n')
}

/**
 * Elimina una cita por su id de evento.
 */
export async function deleteAppointment(eventId: string): Promise<void> {
    const calendar = getCalendarClient()
    const { calendarId } = getCalendarConfig()

    try {
        await calendar.events.delete({ calendarId, eventId })
    } catch (error) {
        if (isCalendarNotFoundError(error)) {
            logCalendarNotFoundHint(calendarId)
        }
        throw error
    }
}

/**
 * Mueve una cita existente a una nueva fecha/hora (y opcionalmente actualiza el motivo).
 *
 * Si se pasa `email`, se reemplaza el asistente y se conserva (o crea) el Meet asociado.
 */
export async function rescheduleAppointment(
    eventId: string,
    data: Pick<AppointmentData, 'name' | 'reason' | 'date' | 'time' | 'phone' | 'email'>
): Promise<AppointmentResult> {
    const calendar = getCalendarClient()
    const { timezone, calendarId } = getCalendarConfig()

    const { startStr, endStr } = buildEventWindow(data.date, data.time)

    const wantsAttendee = Boolean(data.email)
    const basePatch: calendar_v3.Schema$Event = {
        summary: `Consulta Matnar - ${data.name}`,
        description: buildDescription(data),
        start: { dateTime: startStr, timeZone: timezone },
        end: { dateTime: endStr, timeZone: timezone },
    }

    const patchBody: calendar_v3.Schema$Event = wantsAttendee
        ? {
              ...basePatch,
              attendees: [{ email: data.email!, displayName: data.name, responseStatus: 'needsAction' }],
          }
        : basePatch

    let event
    let attendeeInvited = false
    try {
        event = await calendar.events.patch({
            calendarId,
            eventId,
            sendUpdates: wantsAttendee ? 'all' : 'none',
            requestBody: patchBody,
        })
        attendeeInvited = wantsAttendee
    } catch (error) {
        if (isForbiddenForServiceAccountsError(error) && wantsAttendee) {
            console.warn(
                '[calendar] Attendees rejected on reschedule (service account sin Domain-Wide Delegation). ' +
                    'Reintentando sin attendees.'
            )
            const { attendees: _omit, ...patchNoAttendees } = patchBody
            event = await calendar.events.patch({
                calendarId,
                eventId,
                sendUpdates: 'none',
                requestBody: patchNoAttendees,
            })
        } else {
            if (isCalendarNotFoundError(error)) logCalendarNotFoundHint(calendarId)
            throw error
        }
    }

    if (!event.data.conferenceData) {
        try {
            event = await calendar.events.patch({
                calendarId,
                eventId,
                conferenceDataVersion: 1,
                sendUpdates: 'none',
                requestBody: {
                    conferenceData: {
                        createRequest: {
                            requestId: `matnar-${crypto.randomUUID()}`,
                            conferenceSolutionKey: { type: 'hangoutsMeet' },
                        },
                    },
                },
            })
        } catch (meetError) {
            if (isInvalidConferenceTypeError(meetError)) {
                console.warn(
                    '[calendar] Meet attach rejected on reschedule (likely service account on personal Gmail). ' +
                        'Continuing without Meet.'
                )
            } else {
                console.warn('[calendar] Could not attach Meet on reschedule:', meetError)
            }
        }
    }

    const meetLink = extractMeetLink(event.data)
    return {
        eventId,
        htmlLink: event.data.htmlLink ?? '',
        meetLink,
        addToCalendarUrl: buildAddToCalendarUrl(data, meetLink),
        attendeeInvited,
    }
}

/**
 * Extrae datos legibles ("name", "reason", "email") de la descripcion guardada por createAppointment.
 */
export function parseAppointmentDescription(description: string): {
    name: string | null
    reason: string | null
    email: string | null
} {
    const nameMatch = description.match(/^Cliente:\s*(.+)$/m)
    const reasonMatch = description.match(/^Motivo:\s*(.+)$/m)
    const emailMatch = description.match(/^Email:\s*(.+)$/m)
    return {
        name: nameMatch ? nameMatch[1].trim() : null,
        reason: reasonMatch ? reasonMatch[1].trim() : null,
        email: emailMatch ? emailMatch[1].trim() : null,
    }
}

/**
 * Convierte la fecha/hora ISO devuelta por Google Calendar a (DD/MM/YYYY, HH:MM)
 * interpretada en la zona horaria configurada del bot.
 */
export function formatStoredDateTime(isoString: string): { date: string; time: string } | null {
    if (!isoString) return null
    const dt = new Date(isoString)
    if (Number.isNaN(dt.getTime())) return null

    const timezone = (process.env.TIMEZONE ?? 'America/Bogota').trim()
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(dt)

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
    const year = get('year')
    const month = get('month')
    const day = get('day')
    let hour = get('hour')
    const minute = get('minute')
    if (hour === '24') hour = '00'
    if (!year || !month || !day || !hour || !minute) return null

    return { date: `${day}/${month}/${year}`, time: `${hour}:${minute}` }
}

const buildEventWindow = (date: string, time: string): { startStr: string; endStr: string } => {
    const startStr = buildDateTimeString(date, time)
    const [datePart, timePart] = startStr.split('T')
    const [h, m] = timePart.split(':').map(Number)
    const totalMinutes = h * 60 + m + 30
    const endH = String(Math.floor(totalMinutes / 60)).padStart(2, '0')
    const endM = String(totalMinutes % 60).padStart(2, '0')
    const endStr = `${datePart}T${endH}:${endM}:00`
    return { startStr, endStr }
}

const buildDescription = (data: Pick<AppointmentData, 'name' | 'phone' | 'reason' | 'email'>): string => {
    const lines = [`Cliente: ${data.name}`, `WhatsApp: ${data.phone}`, `Motivo: ${data.reason}`]
    if (data.email) lines.push(`Email: ${data.email}`)
    return lines.join('\n')
}

/**
 * Construye un link "Agregar a Google Calendar" prellenado para que el cliente
 * lo abra y guarde el evento en SU propio calendario. Necesario porque una
 * service account sin Domain-Wide Delegation no puede agregar attendees al
 * evento que creamos (devuelve 403 forbiddenForServiceAccounts).
 */
export function buildAddToCalendarUrl(data: Pick<AppointmentData, 'name' | 'reason' | 'date' | 'time'>, meetLink: string | null): string {
    const [day, month, year] = data.date.split('/')
    const [hour, minute] = data.time.split(':')
    const startMinutes = Number(hour) * 60 + Number(minute) + 30
    const endHour = String(Math.floor(startMinutes / 60)).padStart(2, '0')
    const endMinute = String(startMinutes % 60).padStart(2, '0')

    const startStr = `${year}${month.padStart(2, '0')}${day.padStart(2, '0')}T${hour.padStart(2, '0')}${minute.padStart(2, '0')}00`
    const endStr = `${year}${month.padStart(2, '0')}${day.padStart(2, '0')}T${endHour}${endMinute}00`

    const detailLines = [`Reunion con Matnar para hablar de ${data.reason}.`]
    if (meetLink) detailLines.push(`Google Meet: ${meetLink}`)

    const { timezone } = getCalendarConfig()
    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: `Consulta Matnar - ${data.name}`,
        dates: `${startStr}/${endStr}`,
        details: detailLines.join('\n'),
        ctz: timezone,
    })
    return `https://calendar.google.com/calendar/render?${params.toString()}`
}

/**
 * Crea una cita de 30 minutos en Google Calendar.
 *
 * Cuando se autentica via OAuth (con refresh token del dueno del calendario):
 *  - el cliente se agrega como `attendee` y Google le envia la invitacion al correo
 *    (sendUpdates='all'), asi el evento aparece automaticamente en su calendario,
 *  - se crea el Google Meet asociado al evento.
 *
 * Si se autentica via service account sin Domain-Wide Delegation, Google rechaza
 * ambas operaciones. Detectamos esos errores y reintentamos sin attendees y/o sin
 * conferenceData, devolviendo el link "Agregar a calendario" como fallback.
 */
export async function createAppointment(data: AppointmentData): Promise<AppointmentResult> {
    const calendar = getCalendarClient()
    const { timezone, calendarId } = getCalendarConfig()

    const { startStr, endStr } = buildEventWindow(data.date, data.time)

    const baseRequestBody: calendar_v3.Schema$Event = {
        summary: `Consulta Matnar - ${data.name}`,
        description: buildDescription(data),
        start: { dateTime: startStr, timeZone: timezone },
        end: { dateTime: endStr, timeZone: timezone },
        conferenceData: {
            createRequest: {
                requestId: `matnar-${crypto.randomUUID()}`,
                conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
        },
    }

    const wantsAttendee = Boolean(data.email)
    const requestBody: calendar_v3.Schema$Event = wantsAttendee
        ? {
              ...baseRequestBody,
              attendees: [{ email: data.email!, displayName: data.name, responseStatus: 'needsAction' }],
              guestsCanModify: false,
          }
        : baseRequestBody

    const insertEvent = async (
        body: calendar_v3.Schema$Event,
        opts: { conferenceDataVersion?: number; sendUpdates?: 'all' | 'externalOnly' | 'none' }
    ) => {
        return calendar.events.insert({
            calendarId,
            conferenceDataVersion: opts.conferenceDataVersion,
            sendUpdates: opts.sendUpdates ?? 'none',
            requestBody: body,
        })
    }

    let event: Awaited<ReturnType<typeof insertEvent>> | null = null
    let attendeeInvited = false

    try {
        event = await insertEvent(requestBody, {
            conferenceDataVersion: 1,
            sendUpdates: wantsAttendee ? 'all' : 'none',
        })
        attendeeInvited = wantsAttendee
    } catch (error) {
        if (isForbiddenForServiceAccountsError(error) && wantsAttendee) {
            console.warn(
                '[calendar] Attendees rejected (service account sin Domain-Wide Delegation). ' +
                    'Reintentando sin attendees.'
            )
            const { attendees: _omitAttendees, ...bodyNoAttendees } = requestBody
            try {
                event = await insertEvent(bodyNoAttendees, {
                    conferenceDataVersion: 1,
                    sendUpdates: 'none',
                })
            } catch (retryError) {
                if (isInvalidConferenceTypeError(retryError)) {
                    const { conferenceData: _omit, ...bodyMinimal } = bodyNoAttendees
                    event = await insertEvent(bodyMinimal, { sendUpdates: 'none' })
                } else {
                    if (isCalendarNotFoundError(retryError)) logCalendarNotFoundHint(calendarId)
                    throw retryError
                }
            }
        } else if (isInvalidConferenceTypeError(error)) {
            console.warn(
                '[calendar] Meet creation rejected (likely service account on personal Gmail). ' +
                    'Retrying event without conferenceData.'
            )
            const { conferenceData: _omit, ...bodyNoMeet } = requestBody
            try {
                event = await insertEvent(bodyNoMeet, {
                    sendUpdates: wantsAttendee ? 'all' : 'none',
                })
                attendeeInvited = wantsAttendee
            } catch (retryError) {
                if (isForbiddenForServiceAccountsError(retryError) && wantsAttendee) {
                    const { attendees: _omitAttendees, ...bodyMinimal } = bodyNoMeet
                    event = await insertEvent(bodyMinimal, { sendUpdates: 'none' })
                } else {
                    if (isCalendarNotFoundError(retryError)) logCalendarNotFoundHint(calendarId)
                    throw retryError
                }
            }
        } else {
            if (isCalendarNotFoundError(error)) logCalendarNotFoundHint(calendarId)
            throw error
        }
    }

    if (!event) throw new Error('No se pudo crear el evento.')

    const meetLink = extractMeetLink(event.data)
    return {
        eventId: event.data.id ?? '',
        htmlLink: event.data.htmlLink ?? '',
        meetLink,
        addToCalendarUrl: buildAddToCalendarUrl(data, meetLink),
        attendeeInvited,
    }
}
