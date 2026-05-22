import { addKeyword, utils } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { MemoryDB as Database } from '@builderbot/bot'
import {
    buildAboutUsReply,
    buildMainMenuReply,
    buildServicesReply,
    findServiceByNumberQuery,
    getServiceEmoji,
    isClearlyOffTopic,
    looksLikeBackToMenu,
    MEETING_INFO_FOOTER,
    mentionsService,
    parseMainMenuChoice,
    SERVICE_DETAIL_APPOINTMENT_CTA,
    SERVICES_ACTIONS_FOOTER,
    userAsksForServices,
} from '../context/services.catalog'
import {
    APPOINTMENT_BOOKING_NUDGE,
    buildBusinessHoursReply,
    userAsksAboutAppointmentHours,
} from '../utils/appointment-messages'
import { generateChatResponse, GeminiMessage } from '../services/ai.service'
import { mapServiceToCatalog } from '../services/extractor.service'
import { splitWhatsappMessages } from '../utils/split-message'
import { dispatchByIntent } from './dispatch-intent'

const OUT_OF_SCOPE_REPLY =
    `Eso ya se sale un poco de lo mio 😅\n\nTe puedo ayudar con los servicios de Matnar o con tu cita.\n\n${MEETING_INFO_FOOTER}\n\n${SERVICES_ACTIONS_FOOTER}`

const LLM_UNAVAILABLE_REPLY =
    'Disculpa, ando con un problema tecnico ahorita 🙏 Dame un par de minutos y volvemos.'

const SCHEDULE_CTA_RE =
    /\b(agend(?:a|ar|amos|emos)|reservar(?:la)?|reuni[oó]n(?:es)?|llamada|30\s*min|coordin(?:ar|amos)|reuniones?\s+de\s+30)\b/i

const responseOffersSchedule = (text: string): boolean => SCHEDULE_CTA_RE.test(text)

const friendlyErrorMessage = (status: number | undefined): string => {
    if (status === 503 || status === 429) return 'Uy, estoy saturado un momento 🙏 Intentalo en un minuto.'
    if (status === 401 || status === 403) return LLM_UNAVAILABLE_REPLY
    return 'Tuve un problemita con tu mensaje 🙏 ¿Me lo repites?'
}

const buildNumberRefReply = (index: number, service: string, description: string): string => {
    const emoji = getServiceEmoji(index)
    const heading = emoji ? `${index}. ${emoji} ${service} ✨` : `${index}. ${service} ✨`
    const body = description.trim() ? `${heading}\n\n${description.trim()}` : heading
    return `${body}\n\n${SERVICE_DETAIL_APPOINTMENT_CTA}`
}

const buildServicesResponse = async (
    ctx: { body: string },
    state: { get: (k: string) => unknown; update: (data: Record<string, unknown>) => Promise<unknown> }
): Promise<string> => {
    const history: GeminiMessage[] = (state.get('chatHistory') as GeminiMessage[] | undefined) ?? []
    const outOfScope = state.get('outOfScope') === true
    const llmUnavailable = state.get('llmUnavailable') === true

    if (mentionsService(ctx.body)) {
        await state.update({ chatLastMentionedService: mapServiceToCatalog(ctx.body) })
    }

    const menuActive = state.get('chatMainMenuActive') === true
    const menuChoice = parseMainMenuChoice(ctx.body, menuActive)
    const menuNav = state.get('servicesInitialMessage')
    const fromMainMenuServices =
        typeof menuNav === 'string' &&
        menuNav.length > 0 &&
        parseMainMenuChoice(menuNav, true) === 'services'

    const catalogContext = state.get('chatServicesCatalogActive') === true
    const numberRef = findServiceByNumberQuery(ctx.body, { catalogContext })

    if (outOfScope || isClearlyOffTopic(ctx.body)) {
        await state.update({ outOfScope: false })
        return OUT_OF_SCOPE_REPLY
    }
    if (looksLikeBackToMenu(ctx.body)) {
        await state.update({ chatMainMenuActive: true, chatServicesCatalogActive: false })
        return buildMainMenuReply()
    }
    if (userAsksAboutAppointmentHours(ctx.body)) {
        return buildBusinessHoursReply(APPOINTMENT_BOOKING_NUDGE)
    }
    if (menuChoice === 'about') return buildAboutUsReply()
    if (menuChoice === 'services' || fromMainMenuServices || userAsksForServices(ctx.body)) {
        await state.update({ servicesInitialMessage: '', chatMainMenuActive: false })
        return buildServicesReply()
    }
    if (numberRef) {
        await state.update({ chatLastMentionedService: numberRef.service })
        return buildNumberRefReply(numberRef.index, numberRef.service, numberRef.description)
    }
    if (llmUnavailable) {
        await state.update({ llmUnavailable: false })
        return LLM_UNAVAILABLE_REPLY
    }

    return generateChatResponse(history, ctx.body)
}

export const servicesFlow = addKeyword<Provider, Database>(utils.setEvent('SERVICES_FLOW'))
    .addAction(async (ctx, { flowDynamic, state }) => {
        try {
            const response = await buildServicesResponse(ctx, state)
            const history: GeminiMessage[] = (state.get('chatHistory') as GeminiMessage[] | undefined) ?? []
            const updatedHistory: GeminiMessage[] = [
                ...history,
                { role: 'user' as const, parts: [{ text: ctx.body }] },
                { role: 'model' as const, parts: [{ text: response }] },
            ].slice(-20)

            const showingCatalog = response.includes('Estos son los servicios que tenemos en Matnar')
            await state.update({
                chatHistory: updatedHistory,
                chatOfferedSchedule: responseOffersSchedule(response),
                chatMainMenuActive: false,
                servicesInitialMessage: '',
                chatServicesCatalogActive: showingCatalog,
            })
            await flowDynamic(splitWhatsappMessages(response))
        } catch (error) {
            console.error('[services] Error:', error)
            const status = (error as { status?: number })?.status
            await flowDynamic(splitWhatsappMessages(friendlyErrorMessage(status)))
        }
    })
    .addAction({ capture: true }, async (ctx, { flowDynamic, state, gotoFlow }) => {
        const rerouted = await dispatchByIntent(ctx, state, gotoFlow)
        if (rerouted) return

        try {
            const response = await buildServicesResponse(ctx, state)
            const history: GeminiMessage[] = (state.get('chatHistory') as GeminiMessage[] | undefined) ?? []
            const updatedHistory: GeminiMessage[] = [
                ...history,
                { role: 'user' as const, parts: [{ text: ctx.body }] },
                { role: 'model' as const, parts: [{ text: response }] },
            ].slice(-20)

            const showingCatalog = response.includes('Estos son los servicios que tenemos en Matnar')
            await state.update({
                chatHistory: updatedHistory,
                chatOfferedSchedule: responseOffersSchedule(response),
                servicesInitialMessage: '',
                chatServicesCatalogActive: showingCatalog,
            })
            await flowDynamic(splitWhatsappMessages(response))
        } catch (error) {
            console.error('[services] Capture error:', error)
            const status = (error as { status?: number })?.status
            await flowDynamic(splitWhatsappMessages(friendlyErrorMessage(status)))
        }
    })
