import { GoogleGenerativeAI } from '@google/generative-ai'
import { BUSINESS_CONTEXT } from '../context/business.context'

// Free model: gemini-2.0-flash — change here if Google updates the free tier model name
const GEMINI_MODEL = 'gemini-2.0-flash'

const getGenAI = () => {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set in environment variables')
    return new GoogleGenerativeAI(apiKey)
}

export type GeminiMessage = {
    role: 'user' | 'model'
    parts: { text: string }[]
}

/**
 * Classifies user intent as 'chat' or 'appointment'.
 * Uses a lightweight Gemini call with a strict prompt.
 */
export async function classifyIntent(text: string): Promise<'chat' | 'appointment'> {
    const genAI = getGenAI()
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL })

    const prompt = `Clasifica la intencion del usuario en UNA sola palabra: "chat" o "appointment".

Criterios:
- "appointment": el usuario quiere agendar, programar o reservar una cita, llamada, reunion, o hablar con alguien del equipo de Matnar
- "chat": todo lo demas (preguntas, saludos, solicitudes de informacion, curiosidades, etc.)

Mensaje del usuario: "${text}"

Responde SOLO con la palabra "chat" o "appointment", sin puntuacion ni explicacion:`

    const result = await model.generateContent(prompt)
    const response = result.response.text().trim().toLowerCase()

    return response.includes('appointment') ? 'appointment' : 'chat'
}

/**
 * Generates a conversational response using the business context as system instruction.
 * Maintains conversation history for coherent multi-turn dialogue.
 */
export async function generateChatResponse(
    history: GeminiMessage[],
    userMessage: string
): Promise<string> {
    const genAI = getGenAI()
    const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction: BUSINESS_CONTEXT,
    })

    const chat = model.startChat({ history })
    const result = await chat.sendMessage(userMessage)
    return result.response.text()
}
