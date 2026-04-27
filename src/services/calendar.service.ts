import { google } from 'googleapis'
import path from 'path'

export type AppointmentData = {
    name: string
    reason: string
    date: string  // format: DD/MM/YYYY
    time: string  // format: HH:MM (24h)
    phone: string
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

/**
 * Checks if the 30-minute slot starting at date+time is free.
 * Returns true if no events overlap in that window.
 */
export async function checkAvailability(date: string, time: string): Promise<boolean> {
    const calendar = getCalendarClient()
    const timezone = process.env.TIMEZONE ?? 'America/Bogota'
    const calendarId = process.env.GOOGLE_CALENDAR_ID ?? 'primary'

    const startStr = buildDateTimeString(date, time)
    // Calculate end time (+30 min) by parsing the string manually
    const [datePart, timePart] = startStr.split('T')
    const [h, m] = timePart.split(':').map(Number)
    const totalMinutes = h * 60 + m + 30
    const endH = String(Math.floor(totalMinutes / 60)).padStart(2, '0')
    const endM = String(totalMinutes % 60).padStart(2, '0')
    const endStr = `${datePart}T${endH}:${endM}:00`

    const response = await calendar.events.list({
        calendarId,
        timeMin: `${startStr}+00:00`,
        timeMax: `${endStr}+00:00`,
        timeZone: timezone,
        singleEvents: true,
        orderBy: 'startTime',
    })

    return (response.data.items?.length ?? 0) === 0
}

/**
 * Creates a 30-minute calendar event and returns the event link.
 */
export async function createAppointment(data: AppointmentData): Promise<string> {
    const calendar = getCalendarClient()
    const timezone = process.env.TIMEZONE ?? 'America/Bogota'
    const calendarId = process.env.GOOGLE_CALENDAR_ID ?? 'primary'

    const startStr = buildDateTimeString(data.date, data.time)
    const [datePart, timePart] = startStr.split('T')
    const [h, m] = timePart.split(':').map(Number)
    const totalMinutes = h * 60 + m + 30
    const endH = String(Math.floor(totalMinutes / 60)).padStart(2, '0')
    const endM = String(totalMinutes % 60).padStart(2, '0')
    const endStr = `${datePart}T${endH}:${endM}:00`

    const event = await calendar.events.insert({
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

    return event.data.htmlLink ?? ''
}
