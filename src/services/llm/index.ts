import { GeminiClient } from './gemini.client'
import { GroqClient } from './groq.client'
import { LLMClient } from './types'

export type Provider = 'gemini' | 'groq'

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'
// Groq's current stable production model with the best free-tier limits.
// See https://console.groq.com/docs/models for the latest list.
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile'

let cached: LLMClient | null = null
let cachedProvider: Provider | null = null

const resolveProvider = (): Provider => {
    const raw = (process.env.AI_PROVIDER ?? 'gemini').trim().toLowerCase()
    if (raw === 'groq') return 'groq'
    return 'gemini'
}

const buildClient = (provider: Provider): LLMClient => {
    if (provider === 'groq') {
        const apiKey = process.env.GROQ_API_KEY
        if (!apiKey) throw new Error('GROQ_API_KEY is not set (required when AI_PROVIDER=groq)')
        const model = (process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL).trim()
        return new GroqClient(apiKey, model)
    }
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set')
    const model = (process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL).trim()
    return new GeminiClient(apiKey, model)
}

/**
 * Returns the configured LLM client. Cached for the lifetime of the process.
 * Switch providers by setting AI_PROVIDER=gemini|groq in .env.
 */
export function getLLM(): LLMClient {
    const provider = resolveProvider()
    if (cached && cachedProvider === provider) return cached
    cached = buildClient(provider)
    cachedProvider = provider
    console.log(`[llm] Using provider: ${provider}`)
    return cached
}

export type { LLMClient, ChatTurn } from './types'
