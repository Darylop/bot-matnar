import { looksLikeBackToMenu, looksLikeGreeting, userAsksForServices } from '../context/services.catalog'

type StateReader = { get: (key: string) => unknown }

const stripDiacritics = (s: string): string =>
    s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

const CANCEL_CITA_RE =
    /\b(cancela|cancelar|anular|borra|borrar|elimina|eliminar)\b.*\b(cita|reunion|reserva)\b/
const EDIT_CITA_RE =
    /\b(modificar|cambiar|mover|reprogramar|editar|actualizar)\b.*\b(cita|reunion|reserva)\b/

/** El usuario quiere salir del flujo actual hacia menu, servicios, cancelar o editar. */
export function looksLikeFlowInterrupt(raw: string): boolean {
    const t = stripDiacritics(raw)
    if (!t) return false
    if (looksLikeBackToMenu(raw)) return true
    if (looksLikeGreeting(raw)) return true
    if (userAsksForServices(raw)) return true
    if (CANCEL_CITA_RE.test(t) || EDIT_CITA_RE.test(t)) return true
    if (/\b(agendar|reservar)\b.*\b(cita|reunion|llamada)\b/.test(t)) return true
    return false
}

export function isAppointmentBookingActive(state: StateReader): boolean {
    return state.get('appointmentBookingActive') === true
}

/**
 * Durante agendar / cancelar / editar no reclasificamos con IA salvo interrupcion explicita
 * (menu, cancelar cita, modificar cita, nuevo agendar, etc.).
 */
export function shouldSkipIntentDispatch(state: StateReader, text: string): boolean {
    if (state.get('pendingCancelEventId')) return true
    if (state.get('editEventId')) return true

    if (isAppointmentBookingActive(state)) {
        return !looksLikeFlowInterrupt(text)
    }

    return false
}
