/**
 * Normaliza fecha y hora capturadas en WhatsApp al formato esperado por calendar.service:
 * fecha DD/MM/AAAA, hora HH:MM (24h).
 *
 * Ejemplos aceptados (fecha): 15/01/2026, 15-1-26, 2026-01-15, 15 de enero 2026, hoy, mañana,
 *   lunes…viernes (proxima ocurrencia en el calendario: si ya paso ese dia en la semana, la de la semana siguiente).
 * Ejemplos aceptados (hora): 10:00, 10.30, 2:30 pm, 14h30, "a las 14" dentro de una frase mas larga.
 */

const DEFAULT_TIMEZONE = 'America/Bogota'

export function getAppointmentTimeZone(): string {
    return (process.env.TIMEZONE ?? DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE
}

export function getYmdInTimeZone(date: Date, timeZone: string): { year: number; month: number; day: number } {
    const str = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date)
    const [year, month, day] = str.split('-').map(Number)
    return { year, month, day }
}

function ymdToDdMmYyyy(y: number, m: number, d: number): string {
    return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`
}

/** Años YY: 00-69 -> 20YY, 70-99 -> 19YY */
function expandTwoDigitYear(yy: number): number {
    if (yy >= 100) return yy
    return yy <= 69 ? 2000 + yy : 1900 + yy
}

function isValidGregorianDay(day: number, month: number, year: number): boolean {
    if (year < 1970 || year > 2100) return false
    if (month < 1 || month > 12 || day < 1 || day > 31) return false
    const dt = new Date(Date.UTC(year, month - 1, day))
    return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day
}

function utcNoonMatchingCalendarDay(y: number, m: number, d: number, timeZone: string): Date {
    let t = Date.UTC(y, m - 1, d, 12, 0, 0)
    for (let i = 0; i < 10; i++) {
        const p = getYmdInTimeZone(new Date(t), timeZone)
        if (p.year === y && p.month === m && p.day === d) return new Date(t)
        const diffDays = Math.round(
            (Date.UTC(y, m - 1, d) - Date.UTC(p.year, p.month - 1, p.day)) / 86400000
        )
        t += diffDays * 86400000
    }
    return new Date(t)
}

function addCalendarDays(
    y: number,
    month: number,
    day: number,
    deltaDays: number,
    timeZone: string
): { year: number; month: number; day: number } {
    const base = utcNoonMatchingCalendarDay(y, month, day, timeZone)
    const shifted = new Date(base.getTime() + deltaDays * 86400000)
    return getYmdInTimeZone(shifted, timeZone)
}

function stripDiacritics(s: string): string {
    return s.normalize('NFD').replace(/\p{M}/gu, '')
}

/** Lunes=1 … Domingo=7 (igual que getIsoWeekdayInZone). */
const SPANISH_WEEKDAY_TO_ISO: Record<string, number> = {
    lunes: 1,
    martes: 2,
    miercoles: 3,
    jueves: 4,
    viernes: 5,
    sabado: 6,
    domingo: 7,
}

const NEXT_WEEK_HINTS = [
    'semana que viene',
    'proxima semana',
    'semana proxima',
    'semana siguiente',
    'siguiente semana',
    'otra semana',
] as const

const FILLER_WORDS = new Set([
    'el', 'la', 'los', 'las', 'de', 'del', 'para', 'en', 'a',
    'este', 'esta', 'ese', 'esa',
    'proximo', 'proxima', 'siguiente', 'que', 'viene',
])

/**
 * Proxima fecha civil que cae en ese dia de la semana (segun calendario en `timeZone`).
 *
 * Acepta expresiones como:
 * - "lunes", "el lunes", "para el lunes", "este lunes"
 * - "proximo lunes", "el proximo lunes", "lunes que viene"
 * - "lunes de la semana que viene", "el lunes de la proxima semana"
 * - "la semana que viene el lunes" (orden invertido)
 *
 * Reglas:
 * - Sin "semana que viene/proxima semana": usa la proxima ocurrencia (esta semana si el dia
 *   aun no paso, la siguiente si ya paso).
 * - Con "semana que viene/proxima semana": fuerza el dia dentro de la siguiente semana ISO
 *   (lunes a domingo), aunque en orden de calendario aun caiga esta misma semana.
 */
function resolveRelativeSpanishWeekday(
    lowered: string,
    referenceNow: Date,
    timeZone: string
): { year: number; month: number; day: number } | null {
    const weekdayMatch = lowered.match(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/)
    if (!weekdayMatch) return null
    const weekday = weekdayMatch[1]
    const targetIso = SPANISH_WEEKDAY_TO_ISO[weekday]
    if (!targetIso) return null

    const forceNextWeek = NEXT_WEEK_HINTS.some((hint) => lowered.includes(hint))

    // Reject if there are unexpected tokens (so we don't match noise like "hoy es lunes").
    let remainder = lowered
    for (const hint of NEXT_WEEK_HINTS) remainder = remainder.split(hint).join(' ')
    remainder = remainder.replace(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/g, ' ')
    const leftoverTokens = remainder.split(/\s+/).filter((w) => w.length > 0)
    if (leftoverTokens.some((w) => !FILLER_WORDS.has(w))) return null

    const today = getYmdInTimeZone(referenceNow, timeZone)
    const todayStr = ymdToDdMmYyyy(today.year, today.month, today.day)
    const todayIso = getIsoWeekdayInZone(todayStr, timeZone)
    if (todayIso === null) return null

    let daysAhead: number
    if (forceNextWeek) {
        // Days to the Monday of the next ISO week, then offset to target weekday.
        const daysUntilNextMonday = todayIso === 1 ? 7 : 8 - todayIso
        daysAhead = daysUntilNextMonday + (targetIso - 1)
    } else {
        daysAhead = (targetIso - todayIso + 7) % 7
    }

    return addCalendarDays(today.year, today.month, today.day, daysAhead, timeZone)
}

const MONTH_NAMES_ES: Record<string, number> = {
    enero: 1,
    febrero: 2,
    marzo: 3,
    abril: 4,
    mayo: 5,
    junio: 6,
    julio: 7,
    agosto: 8,
    septiembre: 9,
    setiembre: 9,
    octubre: 10,
    noviembre: 11,
    diciembre: 12,
}

/**
 * Devuelve DD/MM/AAAA o null si no se puede interpretar.
 */
export function normalizeAppointmentDate(
    raw: string,
    referenceNow: Date = new Date(),
    timeZone: string = getAppointmentTimeZone()
): string | null {
    const input = raw.trim().replace(/\s+/g, ' ')
    if (!input) return null

    const lowered = stripDiacritics(input.toLowerCase())

    const today = getYmdInTimeZone(referenceNow, timeZone)
    if (lowered === 'hoy') {
        return ymdToDdMmYyyy(today.year, today.month, today.day)
    }
    if (lowered === 'manana' || lowered === 'mañana') {
        const t = addCalendarDays(today.year, today.month, today.day, 1, timeZone)
        return ymdToDdMmYyyy(t.year, t.month, t.day)
    }
    if (lowered === 'pasado manana' || lowered === 'pasado mañana') {
        const t = addCalendarDays(today.year, today.month, today.day, 2, timeZone)
        return ymdToDdMmYyyy(t.year, t.month, t.day)
    }

    const fromWeekday = resolveRelativeSpanishWeekday(lowered, referenceNow, timeZone)
    if (fromWeekday) {
        return ymdToDdMmYyyy(fromWeekday.year, fromWeekday.month, fromWeekday.day)
    }

    const iso = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (iso) {
        const year = Number(iso[1])
        const month = Number(iso[2])
        const day = Number(iso[3])
        if (isValidGregorianDay(day, month, year)) return ymdToDdMmYyyy(year, month, day)
        return null
    }

    const dmy = input.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/)
    if (dmy) {
        const day = Number(dmy[1])
        const month = Number(dmy[2])
        const yPart = Number(dmy[3])
        const year = yPart < 100 ? expandTwoDigitYear(yPart) : yPart
        if (isValidGregorianDay(day, month, year)) return ymdToDdMmYyyy(year, month, day)
        return null
    }

    // Flexible "DD [de] MES [[de|del] YYYY]" with optional weekday prefix.
    // Matches: "26 de mayo", "26 mayo", "26 de mayo 2026", "26 de mayo de 2026",
    //          "viernes 26 de mayo", "el viernes 26 de mayo", "para el viernes 26 mayo 2026".
    // Year defaults to current year; rolls to next year if the date already passed.
    const textMonthFlex = lowered.match(
        /^(?:el\s+|para\s+(?:el\s+)?|este\s+)?(?:(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+)?(\d{1,2})\s+(?:de\s+)?([a-z]+)(?:\s+(?:de\s+|del\s+)?(\d{4}))?$/
    )
    if (textMonthFlex) {
        const day = Number(textMonthFlex[1])
        const month = MONTH_NAMES_ES[textMonthFlex[2]]
        if (!month) return null

        let year: number
        if (textMonthFlex[3]) {
            year = Number(textMonthFlex[3])
        } else {
            const candidateUtc = Date.UTC(today.year, month - 1, day)
            const todayUtc = Date.UTC(today.year, today.month - 1, today.day)
            year = candidateUtc < todayUtc ? today.year + 1 : today.year
        }

        if (isValidGregorianDay(day, month, year)) return ymdToDdMmYyyy(year, month, day)
        return null
    }

    return null
}

function parseHourMinute24(h: number, minute: number): { h: number; m: number } | null {
    if (h < 0 || h > 23 || minute < 0 || minute > 59) return null
    return { h, m: minute }
}

/** Hora en formato 12h (1-12) a 0-23 */
function to24From12(h12: number, isPm: boolean): number {
    if (h12 < 1 || h12 > 12) return -1
    if (isPm) return h12 === 12 ? 12 : h12 + 12
    return h12 === 12 ? 0 : h12
}

const formatHHmm = (h: number, m: number): string =>
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

/**
 * Convierte una hora interna en formato 24h ("HH:MM") al formato 12h amigable
 * para el usuario ("9:00 am", "2:30 pm", "12:00 pm"). Si el input no es valido
 * lo devuelve sin cambios para no romper mensajes ya construidos.
 */
export function formatTime12h(timeHHmm: string): string {
    const t = timeHHmm.match(/^(\d{1,2}):(\d{2})$/)
    if (!t) return timeHHmm
    const h24 = Number(t[1])
    const min = Number(t[2])
    if (h24 < 0 || h24 > 23 || min < 0 || min > 59) return timeHHmm
    const period = h24 >= 12 ? 'pm' : 'am'
    const h12base = h24 % 12
    const h12 = h12base === 0 ? 12 : h12base
    return `${h12}:${String(min).padStart(2, '0')} ${period}`
}

/** Rango horario laboral formateado para mostrar al usuario (12h). */
export const BUSINESS_HOURS_LABEL = '9 am a 6 pm'

/**
 * Cuando el usuario dice una hora sin am/pm explicito (p.ej. "a las 4"),
 * y la lectura literal AM cae fuera del horario laboral pero la version PM
 * cae dentro, asumimos PM. Asi "a las 4" -> 16:00, "a las 5" -> 17:00, etc.
 *
 * Solo se aplica a horas 1-12 sin marcador am/pm. No tocamos 0, 13-23 ni
 * casos donde la AM ya es valida (9, 10, 11, 12).
 */
function resolveAmbiguousAmPm(h: number, m: number): { h: number; m: number } {
    if (h < 1 || h > 12) return { h, m }
    if (isWithinBusinessHours(formatHHmm(h, m))) return { h, m }
    const pm = h === 12 ? 12 : h + 12
    if (isWithinBusinessHours(formatHHmm(pm, m))) return { h: pm, m }
    return { h, m }
}

/**
 * Devuelve HH:MM (24h, dos digitos en hora) o null.
 * Primero se interpretan sufijos am/pm para no confundir "9:00 pm" con las 09:00 en 24h.
 */
export function normalizeAppointmentTime(raw: string): string | null {
    const s = raw.trim().toLowerCase().replace(/\s+/g, ' ')
    if (!s) return null

    const withSuffix = s.match(/^(\d{1,2})(?::|\.)(\d{2})\s*([ap])\.?m\.?$/)
    if (withSuffix) {
        const h12 = Number(withSuffix[1])
        const minute = Number(withSuffix[2])
        const isPm = withSuffix[3] === 'p'
        const hour = to24From12(h12, isPm)
        const res = parseHourMinute24(hour, minute)
        if (!res) return null
        return `${String(res.h).padStart(2, '0')}:${String(res.m).padStart(2, '0')}`
    }

    const hourOnlyAmPm = s.match(/^(\d{1,2})\s*([ap])\.?m\.?$/)
    if (hourOnlyAmPm) {
        const h12 = Number(hourOnlyAmPm[1])
        const isPm = hourOnlyAmPm[2] === 'p'
        const hour = to24From12(h12, isPm)
        const res = parseHourMinute24(hour, 0)
        if (!res) return null
        return `${String(res.h).padStart(2, '0')}:${String(res.m).padStart(2, '0')}`
    }

    const hLetter = s.match(/^(\d{1,2})\s*h\s*(\d{2})$/)
    if (hLetter) {
        const res = parseHourMinute24(Number(hLetter[1]), Number(hLetter[2]))
        if (!res) return null
        const adj = resolveAmbiguousAmPm(res.h, res.m)
        return formatHHmm(adj.h, adj.m)
    }

    const h24 = s.match(/^(\d{1,2})[h:](\d{2})$/)
    if (h24) {
        const res = parseHourMinute24(Number(h24[1]), Number(h24[2]))
        if (!res) return null
        const adj = resolveAmbiguousAmPm(res.h, res.m)
        return formatHHmm(adj.h, adj.m)
    }

    const dotOrColon = s.match(/^(\d{1,2})[:.](\d{2})$/)
    if (dotOrColon) {
        const res = parseHourMinute24(Number(dotOrColon[1]), Number(dotOrColon[2]))
        if (!res) return null
        const adj = resolveAmbiguousAmPm(res.h, res.m)
        return formatHHmm(adj.h, adj.m)
    }

    // Hora embebida en una frase ("Desarrollo, a las 14, por parte de X")
    const aLasAmPm = s.match(/\ba las (\d{1,2})\s*([ap])\.?m\.?\b/)
    if (aLasAmPm) {
        const h12 = Number(aLasAmPm[1])
        const isPm = aLasAmPm[2] === 'p'
        const hour = to24From12(h12, isPm)
        const res = parseHourMinute24(hour, 0)
        if (!res) return null
        return `${String(res.h).padStart(2, '0')}:${String(res.m).padStart(2, '0')}`
    }

    const aLas = s.match(/\ba las (\d{1,2})(?::(\d{2}))?\b/)
    if (aLas) {
        const res = parseHourMinute24(Number(aLas[1]), aLas[2] ? Number(aLas[2]) : 0)
        if (!res) return null
        const adj = resolveAmbiguousAmPm(res.h, res.m)
        return formatHHmm(adj.h, adj.m)
    }

    return null
}

/** Lunes=1 ... Domingo=7 (ISO weekday) en la fecha civil dd/mm/yyyy dentro de la zona IANA. */
export function getIsoWeekdayInZone(ddMmYyyy: string, timeZone: string = getAppointmentTimeZone()): number | null {
    const m = ddMmYyyy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
    if (!m) return null
    const day = Number(m[1])
    const month = Number(m[2])
    const year = Number(m[3])
    const inst = utcNoonMatchingCalendarDay(year, month, day, timeZone)
    const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(inst)
    const map: Record<string, number> = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    return map[wd] ?? null
}

export function isBusinessWeekday(ddMmYyyy: string, timeZone?: string): boolean {
    const d = getIsoWeekdayInZone(ddMmYyyy, timeZone)
    return d !== null && d >= 1 && d <= 5
}

/**
 * Inicio de cita a las HH:MM. Horario laboral 09:00-18:00 inclusive como hora de inicio:
 * la ventana de 30 min puede terminar como tarde a las 18:30, asi "a las 6 (= 18:00)"
 * cuenta como dentro del horario.
 */
export function isWithinBusinessHours(timeHHmm: string): boolean {
    const t = timeHHmm.match(/^(\d{2}):(\d{2})$/)
    if (!t) return false
    const h = Number(t[1])
    const min = Number(t[2])
    const start = h * 60 + min
    const end = start + 30
    const open = 9 * 60
    const close = 18 * 60 + 30
    return start >= open && end <= close
}

const WEEKDAY_NAMES_ES = [
    '',
    'lunes',
    'martes',
    'miercoles',
    'jueves',
    'viernes',
    'sabado',
    'domingo',
] as const

/** Nombre del dia de la semana en español (ej. "viernes") para mensajes al usuario. */
export function formatWeekdayFriendly(ddMmYyyy: string, timeZone?: string): string {
    const iso = getIsoWeekdayInZone(ddMmYyyy, timeZone)
    if (!iso) return ddMmYyyy
    return WEEKDAY_NAMES_ES[iso] ?? ddMmYyyy
}

const SLOT_STEP_MINUTES = 30
const BUSINESS_FIRST_SLOT = 9 * 60
/** Ultima hora de inicio valida (18:00); despues pasa al siguiente dia habil. */
const BUSINESS_LAST_SLOT_START = 18 * 60

/**
 * Avanza al siguiente hueco de 30 min dentro del horario laboral; si no cabe en el dia,
 * salta al proximo dia habil a las 09:00.
 */
export function addBusinessSlotStep(
    date: string,
    time: string,
    timeZone: string = getAppointmentTimeZone()
): { date: string; time: string } {
    const [h, m] = time.split(':').map(Number)
    const nextMinutes = h * 60 + m + SLOT_STEP_MINUTES

    if (nextMinutes <= BUSINESS_LAST_SLOT_START) {
        const nh = Math.floor(nextMinutes / 60)
        const nm = nextMinutes % 60
        return { date, time: formatHHmm(nh, nm) }
    }

    const [day, month, year] = date.split('/').map(Number)
    let cursor = addCalendarDays(year, month, day, 1, timeZone)
    for (let i = 0; i < 14; i++) {
        const candidate = ymdToDdMmYyyy(cursor.year, cursor.month, cursor.day)
        if (isBusinessWeekday(candidate, timeZone)) {
            return { date: candidate, time: '09:00' }
        }
        cursor = addCalendarDays(cursor.year, cursor.month, cursor.day, 1, timeZone)
    }

    return { date, time: '09:00' }
}
