import 'dotenv/config'
import { createBot, createProvider, createFlow } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { welcomeFlow } from './flows/welcome.flow'
import { welcomeMenuFlow } from './flows/welcome-menu.flow'
import { servicesFlow } from './flows/services.flow'
import { appointmentFlow } from './flows/appointment.flow'
import { cancelFlow } from './flows/cancel.flow'
import { editFlow } from './flows/edit.flow'
import { listAppointmentsFlow } from './flows/list-appointments.flow'

const PORT = process.env.PORT ?? 3008

const logProcessError = (label: string, error: unknown): void => {
    console.error(`[bot-matnar] ${label}:`, error)
}

process.on('unhandledRejection', (reason) => {
    logProcessError('Promesa rechazada sin capturar', reason)
})

/** Baileys reemplaza los listeners al crear el provider; volvemos a registrar el nuestro. */
const attachFatalErrorLogging = (): void => {
    process.on('uncaughtException', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
            console.error(
                `[bot-matnar] El puerto ${PORT} ya esta en uso. Cierra la otra instancia o cambia PORT en .env`
            )
        }
        logProcessError('Excepcion no capturada (revisa tambien baileys.log)', error)
    })
}

const main = async () => {
    const adapterFlow = createFlow([
        welcomeFlow,
        welcomeMenuFlow,
        servicesFlow,
        appointmentFlow,
        cancelFlow,
        editFlow,
        listAppointmentsFlow,
    ])

    const adapterProvider = createProvider(Provider, {
        version: [2, 3000, 1035824857],
    })
    attachFatalErrorLogging()

    adapterProvider.on('auth_failure', (instructions: string[]) => {
        console.error('[bot-matnar] Fallo de autenticacion WhatsApp:')
        for (const line of instructions) console.error(`  - ${line}`)
        console.error('  Revisa baileys.log en la raiz del proyecto.')
    })

    adapterProvider.on('require_action', (payload: { instructions?: string[] }) => {
        console.log('[bot-matnar] Accion requerida (QR o vinculacion):')
        for (const line of payload.instructions ?? []) console.log(`  ${line}`)
    })

    adapterProvider.on('ready', () => {
        console.log('[bot-matnar] WhatsApp conectado correctamente.')
    })

    const adapterDB = new Database()

    const { handleCtx, httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

    // Send a message to a number via HTTP (useful for notifications or testing)
    adapterProvider.server.post(
        '/v1/messages',
        handleCtx(async (bot, req, res) => {
            const { number, message, urlMedia } = req.body
            await bot.sendMessage(number, message, { media: urlMedia ?? null })
            return res.end('sent')
        })
    )

    // Blacklist management
    adapterProvider.server.post(
        '/v1/blacklist',
        handleCtx(async (bot, req, res) => {
            const { number, intent } = req.body
            if (intent === 'remove') bot.blacklist.remove(number)
            if (intent === 'add') bot.blacklist.add(number)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', number, intent }))
        })
    )

    httpServer(+PORT)
    console.log(`[bot-matnar] Servidor en http://localhost:${PORT} — esperando conexion WhatsApp...`)
}

main().catch((error) => {
    logProcessError('No se pudo iniciar el bot', error)
    process.exit(1)
})
