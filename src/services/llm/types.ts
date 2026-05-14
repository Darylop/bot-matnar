export type ChatTurn = {
    role: 'user' | 'assistant'
    content: string
}

export interface LLMClient {
    /** Single-shot completion. */
    complete(prompt: string, options?: { temperature?: number }): Promise<string>

    /** Multi-turn chat with an optional system instruction. */
    chat(
        systemPrompt: string,
        history: ChatTurn[],
        userMessage: string,
        options?: { temperature?: number }
    ): Promise<string>

    /** Completion that must return valid JSON parseable as type T. */
    completeJson<T>(prompt: string, options?: { temperature?: number }): Promise<T>
}
