/**
 * Parte una respuesta larga en varios mensajes estilo WhatsApp.
 *
 * - Si el texto es corto y no tiene saltos dobles, se envia como un unico mensaje.
 * - Si trae bloques separados por `\n\n` (doble salto de linea), cada bloque se
 *   convierte en un mensaje independiente.
 * - Si algun bloque sigue siendo demasiado largo, se rompe por oraciones para
 *   evitar mensajes incomodos de leer en WhatsApp.
 */

const MAX_SINGLE_MESSAGE_LEN = 350
const MAX_PART_LEN = 700

const splitLongParagraph = (paragraph: string): string[] => {
    const sentences = paragraph
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    if (sentences.length <= 1) return [paragraph.trim()]

    const out: string[] = []
    let buffer = ''
    for (const sentence of sentences) {
        const candidate = buffer ? `${buffer} ${sentence}` : sentence
        if (candidate.length > MAX_PART_LEN && buffer) {
            out.push(buffer.trim())
            buffer = sentence
        } else {
            buffer = candidate
        }
    }
    if (buffer) out.push(buffer.trim())
    return out
}

export function splitWhatsappMessages(raw: string): string[] {
    const text = raw.trim()
    if (!text) return []

    if (text.length <= MAX_SINGLE_MESSAGE_LEN && !text.includes('\n\n')) {
        return [text]
    }

    const paragraphs = text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)

    const messages: string[] = []
    for (const paragraph of paragraphs) {
        if (paragraph.length <= MAX_PART_LEN) {
            messages.push(paragraph)
            continue
        }
        messages.push(...splitLongParagraph(paragraph))
    }

    return messages.length > 0 ? messages : [text]
}
