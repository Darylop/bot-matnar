import {
    CalendarConfigurationError,
    checkAvailability,
    findNextAvailableSlot,
    isCalendarNotFoundError,
} from '../services/calendar.service'
import { formatTime12h, formatWeekdayFriendly } from '../utils/appointment-datetime'
import { looksLikeAffirmative, looksLikeNegativeOnly, looksLikeSlotAcceptance } from '../utils/affirmative'

export type SlotFieldReader = {
    get: (k: string) => unknown
    update: (data: Record<string, unknown>) => Promise<unknown>
}

const OFFER_DATE_KEY = 'appointmentOfferedDate'
const OFFER_TIME_KEY = 'appointmentOfferedTime'
const AWAITING_ALT_KEY = 'appointmentAwaitingAlternateSlot'

export const SLOT_STATE_KEYS = [OFFER_DATE_KEY, OFFER_TIME_KEY, AWAITING_ALT_KEY] as const

export const clearSlotNegotiationState = async (state: SlotFieldReader): Promise<void> => {
    await state.update({
        [OFFER_DATE_KEY]: '',
        [OFFER_TIME_KEY]: '',
        [AWAITING_ALT_KEY]: false,
    })
}

const getOfferedSlot = (state: SlotFieldReader): { date: string; time: string } | null => {
    const date = state.get(OFFER_DATE_KEY)
    const time = state.get(OFFER_TIME_KEY)
    if (typeof date === 'string' && date && typeof time === 'string' && time) {
        return { date, time }
    }
    return null
}

const setOfferedSlot = async (
    state: SlotFieldReader,
    date: string,
    time: string
): Promise<void> => {
    await state.update({
        [OFFER_DATE_KEY]: date,
        [OFFER_TIME_KEY]: time,
        [AWAITING_ALT_KEY]: false,
    })
}

const buildConflictOfferMessage = (
    requestedDate: string,
    requestedTime: string,
    offered: { date: string; time: string }
): string => {
    const reqDay = formatWeekdayFriendly(requestedDate)
    const reqTime = formatTime12h(requestedTime)
    const offDay = formatWeekdayFriendly(offered.date)
    const offTime = formatTime12h(offered.time)

    if (requestedDate === offered.date) {
        return `Lo siento, ya hay una reunion asignada el ${reqDay} a las ${reqTime}. ¿Te sirve a las ${offTime}?`
    }
    return `Lo siento, ya hay una reunion asignada el ${reqDay} a las ${reqTime}. ¿Te sirve el ${offDay} a las ${offTime}?`
}

export type SlotNegotiationResult =
    | { status: 'ok' }
    | { status: 'prompt'; message: string }
    | { status: 'error'; message: string }

/**
 * Valida el hueco elegido y gestiona la conversacion de alternativas.
 * Llamar despues de fusionar fecha/hora del mensaje del usuario.
 */
export async function negotiateAppointmentSlot(
    state: SlotFieldReader,
    date: string,
    time: string,
    body?: string
): Promise<SlotNegotiationResult> {
    const offered = getOfferedSlot(state)
    const awaitingAlternate = state.get(AWAITING_ALT_KEY) === true

    if (body && offered) {
        if (looksLikeSlotAcceptance(body) || looksLikeAffirmative(body)) {
            await state.update({
                appointmentDate: offered.date,
                appointmentTime: offered.time,
                [OFFER_DATE_KEY]: '',
                [OFFER_TIME_KEY]: '',
                [AWAITING_ALT_KEY]: false,
            })
            return { status: 'ok' }
        }
        if (looksLikeNegativeOnly(body)) {
            await state.update({
                [OFFER_DATE_KEY]: '',
                [OFFER_TIME_KEY]: '',
                [AWAITING_ALT_KEY]: true,
                appointmentTime: '',
            })
            return { status: 'prompt', message: '¿Que otro dia u hora te conviene?' }
        }
    }

    if (awaitingAlternate && body && looksLikeNegativeOnly(body)) {
        return { status: 'prompt', message: '¿Que otro dia u hora te conviene?' }
    }

    try {
        const available = await checkAvailability(date, time)
        if (available) {
            await clearSlotNegotiationState(state)
            return { status: 'ok' }
        }

        const next = await findNextAvailableSlot(date, time)
        if (!next) {
            await state.update({
                appointmentTime: '',
                [AWAITING_ALT_KEY]: true,
                [OFFER_DATE_KEY]: '',
                [OFFER_TIME_KEY]: '',
            })
            return {
                status: 'prompt',
                message:
                    'Ese horario ya esta ocupado y no encuentro otro hueco cercano. ¿Que otro dia u hora te conviene?',
            }
        }

        await setOfferedSlot(state, next.date, next.time)
        return {
            status: 'prompt',
            message: buildConflictOfferMessage(date, time, next),
        }
    } catch (error) {
        console.error('[appointment] Slot negotiation error:', error)
        if (error instanceof CalendarConfigurationError || isCalendarNotFoundError(error)) {
            return {
                status: 'error',
                message: 'No puedo consultar la agenda ahora. Vuelve a intentarlo en un minuto.',
            }
        }
        return {
            status: 'error',
            message: 'No pude verificar la disponibilidad. ¿Me repites el dia y la hora?',
        }
    }
}
