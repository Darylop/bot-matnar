import { addKeyword, utils } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { MemoryDB as Database } from '@builderbot/bot'
import {
    CalendarConfigurationError,
    formatAppointmentsListMessage,
    isCalendarNotFoundError,
    listUpcomingAppointmentsByPhone,
} from '../services/calendar.service'
import { clearAppointmentState } from './cancel.flow'

const calendarUnreachable = (error: unknown): boolean =>
    error instanceof CalendarConfigurationError || isCalendarNotFoundError(error)

export const listAppointmentsFlow = addKeyword<Provider, Database>(
    utils.setEvent('LIST_APPOINTMENTS_FLOW')
).addAction(async (ctx, { state, flowDynamic, endFlow }) => {
        try {
            const appointments = await listUpcomingAppointmentsByPhone(ctx.from)
            await flowDynamic(formatAppointmentsListMessage(appointments))
        } catch (error) {
            console.error('[list-appointments] Error fetching appointments:', error)
            if (calendarUnreachable(error)) {
                await flowDynamic('No puedo consultar la agenda ahora, intenta en un minuto.')
            } else {
                await flowDynamic('Hubo un problema al consultar tus citas. Intentemos de nuevo.')
            }
        }

        await clearAppointmentState(state)
        return endFlow()
    })
