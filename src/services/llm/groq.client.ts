import Groq from 'groq-sdk'
import { ChatTurn, LLMClient } from './types'
import { withTransientRetry } from './retry'

export class GroqClient implements LLMClient {
    private readonly modelName: string
    private readonly client: Groq

    constructor(apiKey: string, modelName: string) {
        this.client = new Groq({ apiKey })
        this.modelName = modelName
    }

    async complete(prompt: string, options?: { temperature?: number }): Promise<string> {
        const result = await withTransientRetry(
            () =>
                this.client.chat.completions.create({
                    model: this.modelName,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: options?.temperature ?? 0,
                }),
            3,
            600,
            'groq'
        )
        return result.choices[0]?.message?.content?.trim() ?? ''
    }

    async chat(
        systemPrompt: string,
        history: ChatTurn[],
        userMessage: string,
        options?: { temperature?: number }
    ): Promise<string> {
        const messages: Groq.Chat.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            ...history.map((t) => ({ role: t.role, content: t.content })),
            { role: 'user', content: userMessage },
        ]
        const result = await withTransientRetry(
            () =>
                this.client.chat.completions.create({
                    model: this.modelName,
                    messages,
                    temperature: options?.temperature ?? 0.7,
                }),
            3,
            600,
            'groq'
        )
        return result.choices[0]?.message?.content?.trim() ?? ''
    }

    async completeJson<T>(prompt: string, options?: { temperature?: number }): Promise<T> {
        const result = await withTransientRetry(
            () =>
                this.client.chat.completions.create({
                    model: this.modelName,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: options?.temperature ?? 0,
                    response_format: { type: 'json_object' },
                }),
            3,
            600,
            'groq'
        )
        const text = result.choices[0]?.message?.content?.trim() ?? '{}'
        return JSON.parse(text) as T
    }
}
