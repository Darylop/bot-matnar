/**
 * Retries a call when the API returns transient errors (503 overloaded, 429 rate limit, 500).
 * Works for both Gemini and Groq error shapes (they expose `.status` similarly).
 */
export async function withTransientRetry<T>(
    fn: () => Promise<T>,
    attempts = 3,
    baseDelayMs = 600,
    tag = 'llm'
): Promise<T> {
    let lastError: unknown
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn()
        } catch (error) {
            lastError = error
            const status = (error as { status?: number })?.status
            const retriable = status === 503 || status === 429 || status === 500
            if (!retriable || i === attempts - 1) throw error
            const wait = baseDelayMs * Math.pow(2, i)
            console.warn(`[${tag}] Transient ${status}, retrying in ${wait}ms (attempt ${i + 1}/${attempts})`)
            await new Promise((r) => setTimeout(r, wait))
        }
    }
    throw lastError
}
