import { google } from 'googleapis'
import path from 'path'

export type AppointmentData = {
    name: string
    reason: string
    date: string  // format: DD/MM/YYYY
    time: string  // format: HH:MM (24h)
    phone: string
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

const getCalendarClient = () => {
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

/**
 * Checks if the 30-minute slot starting at date+time is free.
 * Returns true if no events overlap in that window.
 */
export async function checkAvailability(date: string, time: string): Promise<boolean> {
    const calendar = getCalendarClient()
    const { timezone, calendarId } = getCalendarConfig()

    const startStr = buildDateTimeString(date, time)
    // Calculate end time (+30 min) by parsing the string manually
    const [datePart, timePart] = startStr.split('T')
    const [h, m] = timePart.split(':').map(Number)
    const totalMinutes = h * 60 + m + 30
    const endH = String(Math.floor(totalMinutes / 60)).padStart(2, '0')
    const endM = String(totalMinutes % 60).padStart(2, '0')
    const endStr = `${datePart}T${endH}:${endM}:00`

    let response
    try {
        response = await calendar.events.list({
            calendarId,
            timeMin: `${startStr}+00:00`,
            timeMax: `${endStr}+00:00`,
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

    return (response.data.items?.length ?? 0) === 0
}

/**
 * Creates a 30-minute calendar event and returns the event link.
 */
export async function createAppointment(data: AppointmentData): Promise<string> {
    const calendar = getCalendarClient()
    const { timezone, calendarId } = getCalendarConfig()

    const startStr = buildDateTimeString(data.date, data.time)
    const [datePart, timePart] = startStr.split('T')
    const [h, m] = timePart.split(':').map(Number)
    const totalMinutes = h * 60 + m + 30
    const endH = String(Math.floor(totalMinutes / 60)).padStart(2, '0')
    const endM = String(totalMinutes % 60).padStart(2, '0')
    const endStr = `${datePart}T${endH}:${endM}:00`

    let event
    try {
        event = await calendar.events.insert({
            calendarId,
            requestBody: {
                summary: `Consulta Matnar - ${data.name}`,
                description: [
                    `Cliente: ${data.name}`,
                    `WhatsApp: ${data.phone}`,
                    `Motivo: ${data.reason}`,
                ].join('\n'),
                start: {
                    dateTime: startStr,
                    timeZone: timezone,
                },
                end: {
                    dateTime: endStr,
                    timeZone: timezone,
                },
            },
        })
    } catch (error) {
        if (isCalendarNotFoundError(error)) {
            logCalendarNotFoundHint(calendarId)
        }
        throw error
    }

    return event.data.htmlLink ?? ''
}
