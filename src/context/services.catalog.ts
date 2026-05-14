/**
 * Catálogo canónico de servicios Matnar (una sola fuente de verdad para prompt y futuros flujos).
 */
export const MATNAR_SERVICES = [
    'Desarrollo web a medida (React, Next.js, Node.js, TypeScript)',
    'Aplicaciones moviles (React Native)',
    'Tiendas y soluciones de e-commerce',
    'Diseno UI/UX y experiencia de usuario',
    'Consultoria tecnologica y arquitectura de software',
    'Integraciones con APIs y sistemas externos',
    'Automatizaciones y bots (como este)',
    'Transformacion digital para empresas',
] as const

export function formatServicesBulletList(): string {
    return MATNAR_SERVICES.map((line) => `- ${line}`).join('\n')
}

function normalizeForIntent(raw: string): string {
    return raw
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}

/**
 * Detecta si el usuario pide el catálogo u oferta de servicios (respuesta determinista en el flujo de chat).
 */
export function userAsksForServices(raw: string): boolean {
    const t = normalizeForIntent(raw)
    if (t.length > 280) return false

    const patterns: RegExp[] = [
        /\bquisier(a|as)\s+saber\b.*\bservic/,
        /\bquiero\s+saber\b.*\bservic/,
        /\bque\s+servicios?\b/,
        /\bservicios?\b.*\b(ofrece|ofrecen|tienen|dan|brindan|prestan|hacen)\b/,
        /\b(ofrece|ofrecen)\b.*\bservicios?\b/,
        /\bcatalogo\b/,
        /\blista\s+de\s+servicios\b/,
        /\ben\s+que\s+(os\s+)?ayudan\b/,
        /\bcomo\s+pueden\s+ayudar\b/,
        /\bque\s+hacen\b.*\bmatnar\b/,
        /\bmatnar\b.*\bservicios?\b/,
        /\bservicios?\b.*\bmatnar\b/,
    ]

    return patterns.some((re) => re.test(t))
}

export function buildServicesReply(): string {
    return [
        'Con gusto. Estos son los servicios que ofrecemos en Matnar:',
        '',
        formatServicesBulletList(),
        '',
        'Si quieres detalle de alguno o agendar una consultoria gratuita de 30 minutos, dimelo.',
    ].join('\n')
}
