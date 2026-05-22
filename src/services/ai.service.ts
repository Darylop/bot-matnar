import { BUSINESS_CONTEXT } from '../context/business.context'
import { ChatTurn, getLLM } from './llm'

export type GeminiMessage = {
    role: 'user' | 'model'
    parts: { text: string }[]
}

const toChatTurns = (history: GeminiMessage[]): ChatTurn[] =>
    history.map((m) => ({
        role: m.role === 'model' ? 'assistant' : 'user',
        content: m.parts.map((p) => p.text).join(''),
    }))

export type Intent =
    | 'welcome'
    | 'services'
    | 'appointment'
    | 'list_appointments'
    | 'cancel'
    | 'edit'
    | 'unknown'

const ALLOWED_INTENTS: ReadonlyArray<Intent> = [
    'welcome',
    'services',
    'appointment',
    'list_appointments',
    'cancel',
    'edit',
    'unknown',
]

/**
 * Clasifica la intencion del usuario con IA (una etiqueta).
 */
export async function classifyIntent(text: string): Promise<Intent> {
    const prompt = `Clasifica la intencion del usuario en UNA sola palabra de esta lista exacta:
"welcome", "services", "appointment", "list_appointments", "cancel", "edit", "unknown".

EL BOT SOLO SIRVE PARA: informacion de Matnar/servicios, agendar reuniones, consultar citas propias, modificar o cancelar citas.

- "welcome": saludos o inicio de conversacion SIN otra peticion concreta. Ejemplos: "hola", "hola!", "buenos dias", "que tal", "menu", "inicio".
- "services": dudas, consultas o interes sobre los servicios de Matnar, el catalogo, precios orientativos, como trabajan, o que ofrecen. Ejemplos: "tengo dudas", "que servicios tienen", "quiero una pagina web", "cuanto cuesta", "me interesa e-commerce", "info sobre desarrollo web". NO uses "services" si pide agendar en el mismo mensaje.
- "appointment": quiere AGENDAR, RESERVAR o CREAR una cita/llamada/reunion nueva. Ejemplos: "quiero agendar", "agendar cita", "reservar una llamada".
- "list_appointments": quiere VER o CONSULTAR sus citas ya agendadas, sin cambiarlas. Ejemplos: "cuales son mis citas", "que cita tengo", "dime mis reuniones".
- "cancel": quiere CANCELAR o ANULAR citas ya existentes. Ejemplos: "cancela mi cita", "borra la reunion", "cancela todas las citas".
- "edit": quiere MODIFICAR, CAMBIAR o REPROGRAMAR una cita existente (fecha, hora, servicio). Ejemplos: "cambiar mi cita", "moverla al viernes". NO uses "edit" si solo pregunta que cita tiene.
- "unknown": temas fuera de alcance (chistes, politica, clima, tareas escolares, codigo ajeno, identidad del bot/IA, cultura general).

Reglas:
- "hola quiero agendar" -> appointment
- "hola" solo -> welcome
- "tengo dudas" o "tengo una duda" -> services
- Ante duda entre "services" y "unknown", elige "services" solo si menciona Matnar, servicios digitales o negocio; si no, "unknown".

Mensaje del usuario: "${text}"

Responde SOLO con una palabra de la lista, en minusculas, sin puntuacion ni explicacion:`

    const raw = await getLLM().complete(prompt, { temperature: 0 })
    const cleaned = raw.trim().toLowerCase().replace(/[^a-z]/g, '')
    const exact = ALLOWED_INTENTS.find((label) => cleaned === label)
    if (exact) return exact
    const partial = ALLOWED_INTENTS.find((label) => cleaned.includes(label))
    return partial ?? 'welcome'
}

/**
 * Generates a conversational response using the business context as system instruction.
 * Maintains conversation history for coherent multi-turn dialogue.
 */
export async function generateChatResponse(
    history: GeminiMessage[],
    userMessage: string
): Promise<string> {
    return getLLM().chat(BUSINESS_CONTEXT, toChatTurns(history), userMessage, { temperature: 0.7 })
}
