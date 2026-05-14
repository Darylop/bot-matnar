import { MATNAR_SERVICES } from '../context/services.catalog'
import {
    getAppointmentTimeZone,
    normalizeAppointmentDate,
    normalizeAppointmentTime,
} from '../utils/appointment-datetime'
import { getLLM } from './llm'

export type AppointmentFields = {
    name: string | null
    service: string | null
    date: string | null  // DD/MM/YYYY
    time: string | null  // HH:MM 24h
}

type RawExtraction = {
    name: string | null
    service: string | null
    date_phrase: string | null
    time_phrase: string | null
}

const stripDiacritics = (s: string): string =>
    s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

const SERVICE_KEYWORDS: Array<{ catalog: string; keywords: string[] }> = [
    {
        catalog: 'Desarrollo web a medida (React, Next.js, Node.js, TypeScript)',
        keywords: ['desarrollo web', 'pagina web', 'sitio web', 'web', 'react', 'next', 'nodejs', 'node js', 'typescript', 'desarrollo'],
    },
    {
        catalog: 'Aplicaciones moviles (React Native)',
        keywords: ['aplicacion movil', 'app movil', 'movil', 'mobile', 'react native', 'android', 'ios'],
    },
    {
        catalog: 'Tiendas y soluciones de e-commerce',
        keywords: ['tienda', 'ecommerce', 'e-commerce', 'comercio electronico', 'shopify', 'woocommerce'],
    },
    {
        catalog: 'Diseno UI/UX y experiencia de usuario',
        keywords: ['ui', 'ux', 'diseno', 'experiencia de usuario', 'interfaz'],
    },
    {
        catalog: 'Consultoria tecnologica y arquitectura de software',
        keywords: ['consultoria', 'arquitectura', 'asesoria tecnica'],
    },
    {
        catalog: 'Integraciones con APIs y sistemas externos',
        keywords: ['integracion', 'api', 'webhook'],
    },
    {
        catalog: 'Automatizaciones y bots (como este)',
        keywords: ['automatizacion', 'bot', 'chatbot', 'rpa'],
    },
    {
        catalog: 'Transformacion digital para empresas',
        keywords: ['transformacion digital', 'digitalizacion'],
    },
]

/**
 * Tries to map a free-text service mention to one of the catalog entries.
 * Returns the catalog string if matched, otherwise the original cleaned text.
 */
export function mapServiceToCatalog(raw: string): string {
    const text = stripDiacritics(raw.trim())
    if (!text) return raw.trim()

    for (const entry of SERVICE_KEYWORDS) {
        if (entry.keywords.some((kw) => text.includes(kw))) {
            return entry.catalog
        }
    }
    return raw.trim()
}

const buildPrompt = (message: string): string => {
    const catalogLines = MATNAR_SERVICES.map((s, i) => `${i + 1}. ${s}`).join('\n')
    return `Eres un extractor de datos para agendar citas. Analiza el mensaje del usuario y devuelve SOLO un JSON con estos cuatro campos. Usa null si el campo NO aparece de forma clara en el mensaje. No inventes datos.

Campos:
- name: nombre del usuario si lo menciona ("me llamo Jose" -> "Jose"). Sin titulos.
- service: el servicio o tema que le interesa, en las palabras del usuario ("Desarrollo", "una app movil", "consultoria"). Si dice algo generico como "una consulta" o no menciona servicio, usa null.
- date_phrase: la expresion COMPLETA de fecha que dijo el usuario, incluyendo modificadores de semana. Reordenala a la forma "[el] DIA de la semana que viene" cuando el usuario mencione "semana que viene", "proxima semana", "semana siguiente" o similar (en cualquier orden de las palabras). Ejemplos: "viernes" -> "viernes"; "el lunes" -> "el lunes"; "lunes de la semana que viene" -> "el lunes de la semana que viene"; "la semana que viene el lunes" -> "el lunes de la semana que viene"; "para la proxima semana el martes" -> "el martes de la proxima semana"; "15/01/2026" -> "15/01/2026"; "manana" -> "manana". null si no hay fecha en el mensaje.
- time_phrase: la expresion textual de la hora tal como el usuario la dijo ("3 pm", "2:30 pm", "14:00"). null si no hay hora.

Catalogo de servicios oficiales (para tu referencia, pero devuelve las palabras del usuario, no el item del catalogo):
${catalogLines}

Mensaje del usuario:
"""
${message}
"""

Responde SOLO con el JSON, sin comentarios ni markdown. El JSON debe tener exactamente las claves: name, service, date_phrase, time_phrase.`
}

/**
 * Extracts appointment fields from a user message using the configured LLM, then
 * normalizes date and time through the existing regex-based validators. Service is
 * mapped to the catalog when possible, or kept as free text.
 *
 * All fields are nullable: only present when clearly stated by the user.
 */
export async function extractAppointmentFields(message: string): Promise<AppointmentFields> {
    const trimmed = message.trim()
    if (!trimmed) {
        return { name: null, service: null, date: null, time: null }
    }

    let parsed: RawExtraction
    try {
        parsed = await getLLM().completeJson<RawExtraction>(buildPrompt(trimmed), { temperature: 0 })
    } catch (error) {
        console.error('[extractor] Failed to extract fields:', error)
        return { name: null, service: null, date: null, time: null }
    }

    const tz = getAppointmentTimeZone()
    const date = parsed.date_phrase
        ? normalizeAppointmentDate(parsed.date_phrase, new Date(), tz)
        : null
    const time = parsed.time_phrase
        ? normalizeAppointmentTime(parsed.time_phrase)
        : null
    const service = parsed.service ? mapServiceToCatalog(parsed.service) : null
    const name = parsed.name ? parsed.name.trim() : null

    return {
        name: name && name.length > 0 ? name : null,
        service,
        date,
        time,
    }
}
