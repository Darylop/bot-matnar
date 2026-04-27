import { addKeyword, utils } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { MemoryDB as Database } from '@builderbot/bot'
import { checkAvailability, createAppointment } from '../services/calendar.service'

const DATE_REGEX = /^\d{2}\/\d{2}\/\d{4}$/
const TIME_REGEX = /^\d{2}:\d{2}$/

export const appointmentFlow = addKeyword<Provider, Database>(utils.setEvent('APPOINTMENT_FLOW'))
    .addAnswer(
        'Perfecto, te ayudo a agendar tu llamada de consultoria con el equipo de Matnar.\n\n¿Cual es tu nombre completo?',
        { capture: true },
        async (ctx, { state }) => {
            await state.update({ appointmentName: ctx.body.trim() })
        }
    )
    .addAnswer(
        '¿Cual es el motivo o tema principal que quieres tratar en la llamada?',
        { capture: true },
        async (ctx, { state }) => {
            await state.update({ appointmentReason: ctx.body.trim() })
        }
    )
    .addAnswer(
        '¿Que fecha prefieres para la llamada?\nEscribe en formato DD/MM/AAAA  (ej: 15/01/2025)',
        { capture: true },
        async (ctx, { state, fallBack }) => {
            const date = ctx.body.trim()
            if (!DATE_REGEX.test(date)) {
                return fallBack('Por favor escribe la fecha en formato DD/MM/AAAA (ej: 15/01/2025)')
            }
            await state.update({ appointmentDate: date })
        }
    )
    .addAnswer(
        '¿A que hora prefieres la llamada?\nEscribe en formato HH:MM en horario de 24h (ej: 10:00)\nAtendemos de lunes a viernes de 09:00 a 18:00.',
        { capture: true },
        async (ctx, { state, fallBack }) => {
            const time = ctx.body.trim()
            if (!TIME_REGEX.test(time)) {
                return fallBack('Por favor escribe la hora en formato HH:MM (ej: 10:00 o 14:30)')
            }

            const date = state.get('appointmentDate') as string

            try {
                const available = await checkAvailability(date, time)
                if (!available) {
                    return fallBack(
                        `El horario ${time} del ${date} ya esta ocupado. Por favor elige otra hora.`
                    )
                }
            } catch (error) {
                // If calendar check fails, log and continue to avoid blocking the user
                console.error('[appointment] Error checking availability:', error)
            }

            await state.update({ appointmentTime: time })
        }
    )
    .addAction(async (ctx, { flowDynamic, state }) => {
        const name = state.get('appointmentName') as string
        const reason = state.get('appointmentReason') as string
        const date = state.get('appointmentDate') as string
        const time = state.get('appointmentTime') as string

        try {
            await createAppointment({ name, reason, date, time, phone: ctx.from })

            await flowDynamic(
                [
                    '¡Listo! Tu llamada ha sido agendada exitosamente.',
                    '',
                    `Nombre: ${name}`,
                    `Fecha: ${date}`,
                    `Hora: ${time}`,
                    `Duracion: 30 minutos`,
                    '',
                    'Nuestro equipo se pondra en contacto contigo para confirmar. ¡Hasta pronto!',
                ].join('\n')
            )
        } catch (error) {
            console.error('[appointment] Error creating event:', error)
            await flowDynamic(
                'Hubo un problema al registrar tu cita. Por favor intenta de nuevo o escribenos directamente.'
            )
        }
    })
