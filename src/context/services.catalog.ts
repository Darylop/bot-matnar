/**
 * Catálogo canónico de servicios Matnar (una sola fuente de verdad para prompt y futuros flujos).
 */
export type MatnarServiceEntry = {
    title: string
    description: string
}

export const MATNAR_SERVICE_ENTRIES: readonly MatnarServiceEntry[] = [
    {
        title: 'Desarrollo web a medida (React, Next.js, Node.js, TypeScript)',
        description:
            'Creamos sitios y aplicaciones web a tu medida: corporativos, landings, paneles de administracion y productos digitales. Usamos React, Next.js, Node.js y TypeScript para que sea rapido, escalable y facil de mantener.',
    },
    {
        title: 'Aplicaciones moviles (React Native)',
        description:
            'Desarrollamos apps para iOS y Android con React Native, compartiendo gran parte del codigo. Ideal si quieres llegar a tus usuarios en el movil con una experiencia nativa y lanzamientos mas agiles.',
    },
    {
        title: 'Tiendas y soluciones de e-commerce',
        description:
            'Montamos tiendas online y flujos de venta: catalogo, carrito, pagos y gestion de pedidos. Te ayudamos a elegir la plataforma o desarrollo a medida segun el volumen y las integraciones que necesites.',
    },
    {
        title: 'Diseno UI/UX y experiencia de usuario',
        description:
            'Investigamos a tus usuarios, armamos wireframes y prototipos, y disenamos interfaces claras y atractivas. El objetivo es que tu producto se entienda facil, se vea profesional y convierta mejor.',
    },
    {
        title: 'Consultoria tecnologica y arquitectura de software',
        description:
            'Revisamos tu stack, procesos y codigo para proponer mejoras de arquitectura, rendimiento y seguridad. Te acompanamos en decisiones tecnicas antes de invertir en un desarrollo grande.',
    },
    {
        title: 'Integraciones con APIs y sistemas externos',
        description:
            'Conectamos tu software con APIs, ERPs, CRMs, pasarelas de pago y herramientas que ya uses. Automatizamos el intercambio de datos para que no dupliques trabajo ni copies informacion a mano.',
    },
    {
        title: 'Automatizaciones y bots (como este)',
        description:
            'Automatizamos tareas repetitivas y creamos bots (WhatsApp, web, internos) que atienden consultas, agendan citas o enlazan sistemas. Como este asistente, pero adaptado a tu negocio.',
    },
    {
        title: 'Transformacion digital para empresas',
        description:
            'Te acompanamos para digitalizar procesos, herramientas y canales de atencion. Definimos prioridades, implementamos soluciones y capacitamos al equipo para que el cambio se sostenga.',
    },
] as const

export const MATNAR_SERVICES = MATNAR_SERVICE_ENTRIES.map((e) => e.title) as readonly string[]

const SERVICE_EMOJIS = ['🌐', '📱', '🛒', '🎨', '💡', '🔌', '🤖', '🚀'] as const

export function getServiceEmoji(index1Based: number): string {
    return SERVICE_EMOJIS[index1Based - 1] ?? ''
}

export function getServiceEntry(index1Based: number): MatnarServiceEntry | null {
    const entry = MATNAR_SERVICE_ENTRIES[index1Based - 1]
    return entry ?? null
}

export function getServiceDescription(index1Based: number): string {
    return getServiceEntry(index1Based)?.description ?? ''
}

export function formatServicesNumberedList(): string {
    return MATNAR_SERVICES.map((line, i) => {
        const emoji = SERVICE_EMOJIS[i]
        return emoji ? `${i + 1}. ${emoji} ${line}` : `${i + 1}. ${line}`
    }).join('\n')
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
 * Patrones tipicos que el bot NO debe responder porque caen fuera del alcance
 * (servicios de Matnar + reuniones). Se evalua antes de llamar al LLM como
 * red de seguridad por si el clasificador deja pasar el mensaje como "chat".
 */
const OFF_TOPIC_PATTERNS: RegExp[] = [
    // Chistes / humor / juegos
    /\bchistes?\b/,
    /\bbroma\b/,
    /\badivinanzas?\b/,
    /\bjuga(r|mos)\b/,
    /\bhistoria(s)?\b.*\b(cuenta|cuentame|narrame|inventa)\b/,
    /\b(cuenta|cuentame|narrame|inventa)\b.*\bhistoria/,
    /\bpoema\b/,
    /\bcancion\b/,
    // Identidad del bot
    /\bquien\s+te\s+(hizo|creo|programo|desarrollo|construyo|fabrico|invento|entreno)\b/,
    /\bquien\s+(eres|sos)\b/,
    /\bque\s+(eres|sos)\b/,
    /\beres\s+(una|un)\s+(ia|inteligencia|chatgpt|gpt|robot|bot|maquina|modelo)\b/,
    /\b(modelo\s+de\s+lenguaje|llm)\b/,
    /\bcomo\s+funcionas\b/,
    // Opiniones / debates
    /\bque\s+opinas\b/,
    /\bque\s+piensas\b/,
    /\btu\s+opinion\b/,
    // Cultura general fuera del negocio
    /\b(clima|tiempo|temperatura)\b.*\b(hoy|manana|hace|esta)\b/,
    /\bfutbol\b/,
    /\b(politica|elecciones|presidente)\b/,
    /\breceta\b/,
    /\b(traduce|traduceme|tradu[cz]ir)\b/,
    /\bresuelve\b.*\b(ecuacion|problema|calculo)\b/,
    /\bcalcula\b.*\b\d/,
    /\bescribe(me)?\b.*\b(ensayo|articulo|cuento|texto)\b/,
]

/**
 * True cuando el mensaje es claramente off-topic para el asistente de Matnar.
 */
export function isClearlyOffTopic(raw: string): boolean {
    const t = normalizeForIntent(raw)
    if (!t) return false
    return OFF_TOPIC_PATTERNS.some((re) => re.test(t))
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

/** Cierre informativo sobre reuniones (sin preguntas tipo "quieres agendar?"). */
export const MEETING_INFO_FOOTER =
    'Para mas informacion, hacemos reuniones de 30 min sobre el servicio que te interese 📅'

export type MainMenuChoice = 'about' | 'services' | 'appointment'

const MENU_ABOUT_RE =
    /\b(sobre\s+nosotros|quienes\s+son|quienes\s+somos|about\s+us|la\s+empresa|conocer\s+matnar)\b/
const MENU_APPOINTMENT_RE =
    /\b(agendar\s+(una\s+)?cita|agendar\s+cita|reservar\s+cita|sacar\s+cita|quiero\s+agendar)\b/

export function buildMainMenuReply(): string {
    return [
        'Hola! Soy el asistente de Matnar 😊',
        'Elige una opcion:',
        '1. Sobre nosotros',
        '2. Servicios',
        '3. Agendar cita',
    ].join('\n')
}

export function buildAboutUsReply(): string {
    return [
        'Somos Matnar 😊',
        'Creamos soluciones digitales a medida para negocios y emprendedores: desarrollo web, apps moviles, e-commerce, automatizaciones y transformacion digital.',
        MEETING_INFO_FOOTER,
        'Escribe *menu* para volver al inicio.',
    ].join('\n\n')
}

/**
 * Opcion del menu principal. Los numeros 1-3 solo aplican cuando `menuContext`
 * es true (el usuario acaba de ver el menu), para no confundirlos con el catalogo.
 */
export function parseMainMenuChoice(raw: string, menuContext: boolean): MainMenuChoice | null {
    const t = normalizeForIntent(raw)
    if (!t) return null

    if (menuContext) {
        if (t === '1') return 'about'
        if (t === '2') return 'services'
        if (t === '3') return 'appointment'
    }

    if (MENU_ABOUT_RE.test(t)) return 'about'
    if (t === 'servicios' || t === 'servicio') return 'services'
    if (MENU_APPOINTMENT_RE.test(t)) return 'appointment'

    return null
}

export function looksLikeBackToMenu(raw: string): boolean {
    const t = normalizeForIntent(raw)
    return /^(menu|inicio|volver|principal|opciones)$/.test(t)
}

export const SERVICES_ACTIONS_FOOTER =
    'Si ya tienes cita: escribe *modificar cita* o *cancelar cita*.\nEscribe *menu* para volver al inicio.'

export function buildServicesReply(): string {
    return [
        'Estos son los servicios que tenemos en Matnar 👇',
        formatServicesNumberedList(),
        MEETING_INFO_FOOTER,
        SERVICES_ACTIONS_FOOTER,
    ].join('\n\n')
}

/** Saludo corto sin otra intencion (hola, buenos dias, que tal). */
export function looksLikeGreeting(raw: string): boolean {
    const t = normalizeForIntent(raw)
    if (!t || t.length > 45) return false
    const patterns: RegExp[] = [
        /^(hola+|holaa+|hey|hi|hello|saludos)\s*[!.?]*$/,
        /^buen(os|as)\s+(dia|dias|tarde|tardes|noche|noches)\s*[!.?]*$/,
        /^que\s+tal\s*[!.?]*$/,
        /^como\s+estas\s*[!.?]*$/,
        /^buenas\s*[!.?]*$/,
    ]
    return patterns.some((re) => re.test(t))
}

/** Bienvenida: saludo + menu principal (no lista todos los servicios de golpe). */
export function buildWelcomeReply(): string {
    return buildMainMenuReply()
}

/**
 * Detecta si el usuario hace referencia a un servicio del catalogo por su numero
 * (ej. "el 2", "numero 3", "que es el 4", "cuentame del 5"). Devuelve el indice
 * 1-based y el texto del servicio si el numero esta dentro del catalogo.
 */
const STANDALONE_NUMBER_RE = /^(?:el\s+|la\s+|los\s+|numero\s+|#\s*)*(\d{1,2})\s*[.?!)]?$/
const NUMBER_QUERY_RE = /\b(?:que\s+(?:es|son|incluye|hace[ns]?|ofrece[ns]?)|explic[ae]me|cuent[ae]me|c[ouó]ntame|info(?:rmacion)?(?:\s+(?:de|del|sobre))?|sobre|dime(?:\s+(?:de|del|sobre|que\s+(?:es|incluye)))?|h[aá]blame(?:\s+(?:de|del|sobre))?|detalle[s]?(?:\s+(?:de|del|sobre))?|me\s+interesa|quiero\s+(?:saber\s+)?(?:de|del|sobre|mas)|elijo|escojo|me\s+quedo\s+con)\s+(?:el\s+|la\s+|del\s+|numero\s+|n[uú]mero\s+|#\s*)*(\d{1,2})\b/

export type ServiceNumberRef = {
    index: number
    service: string
    description: string
}

export type FindServiceByNumberOptions = {
    /**
     * Si es true, un mensaje que es solo un numero (ej. "4") se interpreta como
     * servicio del catalogo. Debe ser false cuando el usuario acaba de ver el menu
     * principal (1-3), para no confundir la opcion "2" con el servicio #2.
     */
    catalogContext?: boolean
}

export function findServiceByNumberQuery(
    raw: string,
    options: FindServiceByNumberOptions = {}
): ServiceNumberRef | null {
    const t = normalizeForIntent(raw)
    if (!t || t.length > 80) return null

    let match: RegExpMatchArray | null = null
    if (options.catalogContext) {
        match = t.match(STANDALONE_NUMBER_RE)
        if (!match) match = t.match(/\bopcion\s+(\d{1,2})\b/)
    }
    if (!match) match = t.match(NUMBER_QUERY_RE)
    if (!match) return null

    const n = Number.parseInt(match[1], 10)
    if (!Number.isFinite(n) || n < 1 || n > MATNAR_SERVICE_ENTRIES.length) return null
    const entry = MATNAR_SERVICE_ENTRIES[n - 1]
    return { index: n, service: entry.title, description: entry.description }
}

/**
 * Palabras que mencionan algun servicio del catalogo de Matnar. Red de seguridad
 * para cuando el clasificador del LLM devuelve "unknown" pero el mensaje claramente
 * habla de un servicio que ofrecemos (ej: "quiero hacer una pagina web").
 */
const SERVICE_MENTION_PATTERNS: RegExp[] = [
    /\b(pagina|sitio|portal|landing)\s+web\b/,
    /\bdesarrollo\s+web\b/,
    /\bweb\s+(a\s+medida|corporativ[ao]|profesional)\b/,
    /\b(app|aplicacion)\s+(movil|mobile)\b/,
    /\breact\s+native\b/,
    /\bandroid\b/,
    /\bios\b/,
    /\b(tienda|comercio)\s+(online|electronico|virtual)\b/,
    /\b(e[\s-]?commerce|ecommerce)\b/,
    /\bshopify\b/,
    /\bwoocommerce\b/,
    /\b(ui|ux)\b/,
    /\bdiseno\s+(de\s+)?(interfaz|experiencia)\b/,
    /\bconsultoria\s+(tecnologica|de\s+software|tecnica)\b/,
    /\barquitectura\s+(de\s+)?software\b/,
    /\b(integracion(es)?|api[s]?)\b/,
    /\bautomatiza(cion|r)\b/,
    /\b(chatbot|bot)s?\b/,
    /\b(transformacion|digitalizacion)\s+digital\b/,
    /\bdigitalizar\b/,
]

export function mentionsService(raw: string): boolean {
    const t = normalizeForIntent(raw)
    if (!t) return false
    return SERVICE_MENTION_PATTERNS.some((re) => re.test(t))
}
