import { GoogleGenerativeAI } from '@google/generative-ai'
import { ChatTurn, LLMClient } from './types'
import { withTransientRetry } from './retry'

export class GeminiClient implements LLMClient {
    private readonly modelName: string
    private readonly client: GoogleGenerativeAI

    constructor(apiKey: string, modelName: string) {
        this.client = new GoogleGenerativeAI(apiKey)
        this.modelName = modelName
    }

    private model(systemInstruction?: string) {
        return this.client.getGenerativeModel({
            model: this.modelName,
            ...(systemInstruction ? { systemInstruction } : {}),
        })
    }

    async complete(prompt: string, options?: { temperature?: number }): Promise<string> {
        const model = this.client.getGenerativeModel({
            model: this.modelName,
            generationConfig: { temperature: options?.temperature ?? 0 },
        })
        const result = await withTransientRetry(() => model.generateContent(prompt), 3, 600, 'gemini')
        return result.response.text()
    }

    async chat(
        systemPrompt: string,
        history: ChatTurn[],
        userMessage: string,
        options?: { temperature?: number }
    ): Promise<string> {
        const model = this.client.getGenerativeModel({
            model: this.modelName,
            systemInstruction: systemPrompt,
            generationConfig: { temperature: options?.temperature ?? 0.7 },
        })
        const geminiHistory = history.map((turn) => ({
            role: (turn.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
            parts: [{ text: turn.content }],
        }))
        const chat = model.startChat({ history: geminiHistory })
        const result = await withTransientRetry(() => chat.sendMessage(userMessage), 3, 600, 'gemini')
        return result.response.text()
    }

    async completeJson<T>(prompt: string, options?: { temperature?: number }): Promise<T> {
        const model = this.client.getGenerativeModel({
            model: this.modelName,
            generationConfig: {
                responseMimeType: 'application/json',
                temperature: options?.temperature ?? 0,
            },
        })
        const result = await withTransientRetry(() => model.generateContent(prompt), 3, 600, 'gemini')
        return JSON.parse(result.response.text()) as T
    }
}
