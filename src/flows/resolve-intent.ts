import { classifyIntent, Intent } from '../services/ai.service'
import {
    isClearlyOffTopic,
    looksLikeGreeting,
    mentionsService,
    parseMainMenuChoice,
} from '../context/services.catalog'
import { looksLikeAffirmative } from '../utils/affirmative'
import { getDeterministicIntent } from './flow-guard'

type StateReader = { get: (key: string) => unknown }

/**
 * Clasifica con IA y aplica overrides de contexto (menu activo, "si" tras ofrecer cita, etc.).
 */
export async function resolveIntent(text: string, state: StateReader): Promise<Intent> {
    const deterministic = getDeterministicIntent(text)
    if (deterministic) return deterministic

    let intent: Intent = 'welcome'

    try {
        intent = await classifyIntent(text)
    } catch (error) {
        console.error('[resolve-intent] Classification failed, defaulting to welcome:', error)
        if (looksLikeGreeting(text)) return 'welcome'
        if (mentionsService(text) && !isClearlyOffTopic(text)) return 'services'
        return 'welcome'
    }

    const menuActive = state.get('chatMainMenuActive') === true
    const menuChoice = parseMainMenuChoice(text, menuActive)

    if (menuActive && menuChoice === 'appointment') return 'appointment'
    if (menuActive && menuChoice === 'services') return 'services'

    if (state.get('chatOfferedSchedule') === true && looksLikeAffirmative(text)) {
        return 'appointment'
    }

    if (intent === 'unknown') {
        if (!isClearlyOffTopic(text) && (mentionsService(text) || state.get('chatOfferedSchedule') === true)) {
            return 'services'
        }
    }

    return intent
}
