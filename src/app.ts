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

const PORT = process.env.PORT ?? 3008

const main = async () => {
    const adapterFlow = createFlow([
        welcomeFlow,
        welcomeMenuFlow,
        servicesFlow,
        appointmentFlow,
        cancelFlow,
        editFlow,
    ])

    const adapterProvider = createProvider(Provider, {
        version: [2, 3000, 1035824857],
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
}

main()
