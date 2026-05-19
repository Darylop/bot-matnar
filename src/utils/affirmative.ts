/**
 * Detecta respuestas afirmativas cortas tipo "si", "claro", "ok", "vale", "dale".
 * Pensado para resolver contexto cuando el bot acaba de hacer una propuesta concreta
 * (por ejemplo "¿agendamos 30 min?"). Solo dispara con mensajes muy cortos para
 * evitar falsos positivos tipo "ok pero antes dame mas info".
 */
const AFFIRMATIVE_PHRASES = new Set([
    'si',
    'sí',
    's',
    'sip',
    'claro',
    'claro que si',
    'claro que sí',
    'confirmo',
    'confirmar',
    'adelante',
    'de acuerdo',
    'ok',
    'okay',
    'okey',
    'vale',
    'listo',
    'dale',
    'dalee',
    'por supuesto',
    'seguro',
    'por favor',
    'hazlo',
    'hagamoslo',
    'hagámoslo',
    'agendalo',
    'agéndalo',
    'agendala',
    'agéndala',
    'agenda',
    'agendemos',
    'agendamos',
    'si por favor',
    'sí por favor',
    'si claro',
    'sí claro',
    'si dale',
    'sí dale',
])

const cleanShortReply = (raw: string): string =>
    raw
        .trim()
        .toLowerCase()
        .replace(/[.,!?¡¿]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()

export function looksLikeAffirmative(raw: string): boolean {
    if (!raw) return false
    const cleaned = cleanShortReply(raw)
    if (!cleaned || cleaned.length > 25) return false
    return AFFIRMATIVE_PHRASES.has(cleaned)
}

const SLOT_ACCEPT_PHRASES = new Set([
    ...AFFIRMATIVE_PHRASES,
    'me sirve',
    'si me sirve',
    'sí me sirve',
    'me sirve esa hora',
    'esa hora me sirve',
    'perfecto esa hora',
    'dale esa hora',
    'esta bien esa hora',
    'está bien esa hora',
    'ok esa hora',
    'de acuerdo esa hora',
])

/** Aceptacion de un horario alternativo propuesto por el bot. */
export function looksLikeSlotAcceptance(raw: string): boolean {
    if (!raw) return false
    const cleaned = cleanShortReply(raw)
    if (!cleaned || cleaned.length > 40) return false
    return SLOT_ACCEPT_PHRASES.has(cleaned)
}

const NEGATIVE_PHRASES = new Set([
    'no',
    'nop',
    'nope',
    'no gracias',
    'no quiero',
    'no me sirve',
    'mejor no',
    'negativo',
    'para nada',
])

/**
 * Respuesta negativa corta sin nueva fecha/hora en el mismo mensaje.
 * Mensajes como "no, mejor el lunes a las 10" no cuentan como negativo puro.
 */
export function looksLikeNegativeOnly(raw: string): boolean {
    if (!raw) return false
    const cleaned = cleanShortReply(raw)
    if (!cleaned || cleaned.length > 35) return false
    if (NEGATIVE_PHRASES.has(cleaned)) return true
    return /^no$/.test(cleaned)
}
