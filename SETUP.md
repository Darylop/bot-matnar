# Configuracion del Bot de WhatsApp - Matnar

Este bot requiere dos claves externas: **Gemini AI** (para respuestas y clasificacion de intenciones) y **Google Calendar** (para agendar llamadas).

---

## 1. Copia el archivo de variables de entorno

```bash
cp .env.example .env
```

Edita el archivo `.env` con los valores reales que obtienes en los pasos siguientes.

---

## 2. API Key de Gemini (Google AI Studio)

El bot usa el modelo `gemini-2.0-flash`, que es **gratuito** en Google AI Studio.

**Pasos:**
1. Ve a [https://aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Inicia sesion con tu cuenta de Google
3. Haz clic en **"Create API key"**
4. Copia la clave generada
5. Pegala en `.env`:
   ```
   GEMINI_API_KEY=AIzaSy...
   ```

> **Limites del free tier:** 15 solicitudes por minuto / 1,500 por dia. Suficiente para un bot de WhatsApp en produccion normal.

---

## 3. Google Calendar (Service Account)

El bot necesita permiso para leer y crear eventos en tu calendario.

### 3.1 Crear el proyecto en Google Cloud Console

1. Ve a [https://console.cloud.google.com](https://console.cloud.google.com)
2. Crea un proyecto nuevo o selecciona uno existente
3. En el menu lateral, ve a **"APIs y servicios" > "Biblioteca"**
4. Busca **"Google Calendar API"** y haz clic en **"Habilitar"**

### 3.2 Crear la cuenta de servicio (Service Account)

1. Ve a **"APIs y servicios" > "Credenciales"**
2. Haz clic en **"Crear credenciales" > "Cuenta de servicio"**
3. Dale un nombre (ej: `matnar-bot`) y haz clic en **"Crear y continuar"**
4. En el paso de roles, puedes omitirlo y hacer clic en **"Listo"**
5. En la lista de cuentas de servicio, haz clic en la que acabas de crear
6. Ve a la pestana **"Claves"**
7. Haz clic en **"Agregar clave" > "Crear clave nueva"**
8. Selecciona formato **JSON** y descarga el archivo

### 3.3 Guardar el archivo de credenciales

1. Crea la carpeta `credentials/` en la raiz del proyecto:
   ```bash
   mkdir credentials
   ```
2. Mueve el archivo JSON descargado a esa carpeta y renombralo:
   ```
   credentials/google-service-account.json
   ```
3. Verifica que `credentials/` esta en el `.gitignore` (ya esta incluido)

### 3.4 Compartir el calendario con la cuenta de servicio

1. Abre [Google Calendar](https://calendar.google.com)
2. En el panel izquierdo, haz clic en los 3 puntos del calendario que quieres usar
3. Selecciona **"Configuracion y uso compartido"**
4. En la seccion **"Compartir con personas especificas"**, agrega el email de la cuenta de servicio
   - El email tiene este formato: `matnar-bot@tu-proyecto.iam.gserviceaccount.com`
   - Lo encuentras en el archivo JSON bajo la clave `"client_email"`
5. Dale permiso **"Hacer cambios en eventos"**
6. Haz clic en **"Enviar"**

### 3.5 Obtener el ID del calendario

1. En la configuracion del calendario (mismo lugar del paso anterior)
2. Baja hasta la seccion **"Integrar el calendario"**
3. Copia el **"ID del calendario"**
   - Si es tu calendario principal, el ID es tu Gmail (ej: `tucorreo@gmail.com`)
   - Si es un calendario separado, tiene el formato `abc123@group.calendar.google.com`
4. Pegalo en `.env`:
   ```
   GOOGLE_CALENDAR_ID=tucorreo@gmail.com
   ```

---

## 4. Configurar el timezone

Edita `TIMEZONE` en `.env` con la zona horaria de tu negocio:

| Pais        | Timezone               |
|-------------|------------------------|
| Colombia    | America/Bogota         |
| Mexico      | America/Mexico_City    |
| Peru        | America/Lima           |
| Chile       | America/Santiago       |
| Argentina   | America/Argentina/Buenos_Aires |
| Espana      | Europe/Madrid          |

---

## 5. Personalizar el contexto del negocio

Edita el archivo `src/context/business.context.ts` con la informacion real de Matnar:
- Descripcion del negocio
- Servicios especificos con precios o categorias
- Tono de comunicacion deseado
- Preguntas frecuentes
- Cualquier regla especifica del negocio

---

## 6. Instalar dependencias y ejecutar

```bash
# Instalar dependencias
npm install

# Desarrollo (con hot reload)
npm run dev

# Produccion
npm run build && npm start
```

Al iniciar por primera vez, el bot mostrara un QR en la terminal. Escanea con WhatsApp desde **Dispositivos vinculados > Vincular un dispositivo**.

---

## Resumen del archivo .env completo

```env
GEMINI_API_KEY=AIzaSy...
GOOGLE_CALENDAR_ID=tucorreo@gmail.com
GOOGLE_SERVICE_ACCOUNT_PATH=./credentials/google-service-account.json
PORT=3008
TIMEZONE=America/Bogota
```
