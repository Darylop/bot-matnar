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

/**
 * Classifies user intent as 'chat' or 'appointment' using the configured LLM provider.
 */
export async function classifyIntent(text: string): Promise<'chat' | 'appointment'> {
    const prompt = `Clasifica la intencion del usuario en UNA sola palabra: "chat" o "appointment".

Criterios:
- "appointment": el usuario quiere agendar, programar o reservar una cita, llamada, reunion, o hablar con alguien del equipo de Matnar
- "chat": todo lo demas (preguntas, saludos, solicitudes de informacion, curiosidades, etc.)
- Importante: si solo pide informacion sobre servicios, catalogo, que ofrece Matnar, precios orientativos sin pedir cita, o dudas generales, eso es "chat", no "appointment".

Mensaje del usuario: "${text}"

Responde SOLO con la palabra "chat" o "appointment", sin puntuacion ni explicacion:`

    const raw = await getLLM().complete(prompt, { temperature: 0 })
    return raw.trim().toLowerCase().includes('appointment') ? 'appointment' : 'chat'
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
