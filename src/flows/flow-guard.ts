import {
    isClearlyOffTopic,
    looksLikeBackToMenu,
    looksLikeGreeting,
    userAsksForServices,
} from '../context/services.catalog'
import type { Intent } from '../services/ai.service'

type StateReader = { get: (key: string) => unknown }

const stripDiacritics = (s: string): string =>
    s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

const CITA_WORD = '(?:citas?|cutas?|sitas?|reuniones?|reservas?)'

const CANCEL_CITA_RE = new RegExp(
    `\\b(cancela|cancelar|anular|borra|borrar|elimina|eliminar)\\b.*\\b${CITA_WORD}\\b`
)
const EDIT_CITA_RE = new RegExp(
    `\\b(modificar|cambiar|mover|reprogramar|editar|actualizar)\\b.*\\b${CITA_WORD}\\b`
)

const EXIT_RE = /^(salir|exit|stop|parar|terminar|atras|atrás|cancelar)$/

/** Quiere cancelar todas las citas del contacto. */
export function looksLikeCancelAllRequest(raw: string): boolean {
    const t = stripDiacritics(raw)
    if (!t) return false
    if (
        /\b(cancela|cancelar|anular|borra|borrar|elimina|eliminar)\s+(?:todas?|todo)\b/.test(t) &&
        /\b(citas?|reuniones?|reservas?)\b/.test(t)
    ) {
        return true
    }
    if (/\b(cancela|cancelar|borra|borrar|elimina|eliminar)\s+(?:todas?|todo)\s+(?:mis\s+)?(?:las\s+)?(?:citas?|reuniones?|reservas?)\b/.test(t)) {
        return true
    }
    if (/\b(?:todas?|todo)\s+(?:mis\s+)?(?:las\s+)?(?:citas?|reuniones?|reservas?)\b/.test(t) && /\b(cancela|borra|elimina|anular)\b/.test(t)) {
        return true
    }
    return false
}

/** Quiere cancelar una cita existente (tolera typos: cuta, sita). */
export function looksLikeCancelRequest(raw: string): boolean {
    const t = stripDiacritics(raw)
    if (!t) return false
    if (looksLikeCancelAllRequest(raw)) return true
    if (CANCEL_CITA_RE.test(t)) return true
    if (/\bquiero\s+cancelar\b/.test(t)) return true
    if (/\bcancelar\s+(?:esta|la|mi|una)?\s*(?:citas?|cutas?|sitas?|reuniones?|reservas?)\b/.test(t)) return true
    return false
}

/** Quiere modificar / reprogramar una cita. */
export function looksLikeEditRequest(raw: string): boolean {
    const t = stripDiacritics(raw)
    if (!t) return false
    if (EDIT_CITA_RE.test(t)) return true
    if (/\b(modificar|cambiar|reprogramar|mover)\s+(?:esta|la|mi)?\s*(?:cita|cuta|sita|reunion)\b/.test(t)) {
        return true
    }
    return false
}

/** Quiere ver sus citas agendadas (sin modificarlas). */
export function looksLikeListAppointmentsRequest(raw: string): boolean {
    const t = stripDiacritics(raw)
    if (!t) return false
    if (looksLikeCancelRequest(raw) || looksLikeEditRequest(raw)) return false
    if (t === 'mis citas') return true
    if (/\b(agendar|reservar|sacar)\b/.test(t) && !/\b(cuales|que|mis|ver|dime|consultar|tengo)\b/.test(t)) {
        return false
    }
    if (/\b(cuales|que)\s+(son\s+)?(mis\s+)?(citas|reuniones|reservas)\b/.test(t)) return true
    if (/\b(mis|ver|mostrar|consultar|listar)\s+(citas|reuniones|reservas)\b/.test(t)) return true
    if (/\b(que|cuales)\s+cita\s+tengo\b/.test(t)) return true
    if (/\bdime\s+(que|cuales|cual)\s+(cita|reunion)\b/.test(t)) return true
    if (/\b(que|cuales)\s+reunion\s+tengo\b/.test(t)) return true
    if (/\btengo\s+(alguna\s+)?cita\b/.test(t) && /\b(agendada|programada|asignada|pendiente)\b/.test(t)) {
        return true
    }
    if (/\bcitas\s+(agendadas|programadas|pendientes)\b/.test(t)) return true
    if (/\bver\s+mi(s)?\s+cita(s)?\b/.test(t)) return true
    return false
}

/** Rechaza modificar la cita (solo queria consultar o cambio de idea). */
export function looksLikeDeclineEdit(raw: string): boolean {
    const t = stripDiacritics(raw)
    if (!t) return false
    if (/\bno\s+quiero\s+modificar/.test(t)) return true
    if (/\bno\s+quiero\s+(mover|cambiar|reprogramar|editar)\b/.test(t)) return true
    if (/\bno\s+la\s+quiero\s+cambiar\b/.test(t)) return true
    if (/\bdejala\s+(asi|como\s+esta)\b/.test(t)) return true
    if (/\bsolo\s+queria\s+(ver|saber|consultar)\b/.test(t)) return true
    return false
}

/** El usuario quiere salir del flujo actual hacia menu, servicios, cancelar o editar. */
export function looksLikeFlowInterrupt(raw: string): boolean {
    const t = stripDiacritics(raw)
    if (!t) return false
    if (looksLikeBackToMenu(raw)) return true
    if (looksLikeGreeting(raw)) return true
    if (userAsksForServices(raw)) return true
    if (EXIT_RE.test(t)) return true
    if (/\b(salir|salgo|dejalo|olvidalo|olvida|no quiero agendar)\b/.test(t)) return true
    if (looksLikeCancelRequest(raw) || looksLikeListAppointmentsRequest(raw) || looksLikeEditRequest(raw)) {
        return true
    }
    if (looksLikeDeclineEdit(raw)) return true
    if (/\b(agendar|reservar)\b.*\b(cita|reunion|llamada)\b/.test(t)) return true
    if (isClearlyOffTopic(raw)) return true
    return false
}

/**
 * Intencion por reglas (sin IA). Si devuelve valor, dispatch debe enrutar siempre,
 * incluso durante agendar / cancelar / editar.
 */
export function getDeterministicIntent(text: string): Intent | null {
    if (looksLikeCancelRequest(text)) return 'cancel'
    if (looksLikeListAppointmentsRequest(text)) return 'list_appointments'
    if (looksLikeEditRequest(text)) return 'edit'
    if (looksLikeBackToMenu(text)) return 'welcome'
    const t = stripDiacritics(text)
    if (EXIT_RE.test(t)) return 'welcome'
    if (looksLikeGreeting(text)) return 'welcome'
    if (userAsksForServices(text)) return 'services'
    if (isClearlyOffTopic(text)) return 'unknown'
    return null
}

export function isAppointmentBookingActive(state: StateReader): boolean {
    return state.get('appointmentBookingActive') === true
}

/**
 * Durante agendar / cancelar / editar no reclasificamos con IA salvo interrupcion explicita.
 */
export function shouldSkipIntentDispatch(state: StateReader, text: string): boolean {
    if (getDeterministicIntent(text)) return false

    if (state.get('pendingCancelEventId') || state.get('pendingCancelAll') || state.get('editEventId')) {
        return !looksLikeFlowInterrupt(text)
    }

    if (isAppointmentBookingActive(state)) {
        return !looksLikeFlowInterrupt(text)
    }

    return false
}
