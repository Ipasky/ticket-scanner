# ticket-scanner

Haz una foto a un tiquet y la aplicación lo lee sola: establecimiento, fecha, importe, líneas y categoría. Si conectas tu cuenta del banco, junta los tiquets con los cargos de la tarjeta, los Bizum y los recibos, y te enseña en qué y dónde gastas.

Es una aplicación web para **una persona**, pensada para instalarla en tu ordenador o en un servidor de casa. Tus fotos y tus movimientos se guardan en tu máquina, en dos ficheros SQLite. La interfaz está en español.

> *English: self-hosted receipt scanner (Google Gemini) with optional read-only bank sync (Enable Banking, PSD2). Node.js + SQLite, Spanish UI.*

---

## Índice

1. [Qué puedes hacer](#qué-puedes-hacer)
2. [Qué datos salen de tu máquina](#qué-datos-salen-de-tu-máquina)
3. [Instalación rápida](#instalación-rápida)
4. [Conectar Gemini (obligatorio)](#conectar-gemini-obligatorio)
5. [Mapa y establecimientos (opcional)](#mapa-y-establecimientos-opcional)
6. [Conectar el banco (opcional)](#conectar-el-banco-opcional)
7. [Ponerlo en un servidor](#ponerlo-en-un-servidor)
8. [Guía de uso](#guía-de-uso)
9. [Copias de seguridad](#copias-de-seguridad)
10. [Desarrollo](#desarrollo)

---

## Qué puedes hacer

### Tiquets
- **Subir una foto o un PDF** (una factura, una entrada) desde el móvil o el ordenador. Gemini lee el establecimiento, la dirección, la fecha y la hora, el importe, la moneda, las líneas, el tipo de documento y la forma de pago.
- **Varios tiquets en una foto**: si fotografías tres a la vez, salen tres fichas, cada una marcada sobre la foto.
- **Lo que no se puede leer se queda vacío**, nunca inventado: un importe ilegible queda sin importe y la ficha se marca para revisar. Una foto nunca se pierde, aunque la IA falle.
- **Ficha del tiquet** para revisar y corregir: establecimiento y categoría arriba, el pago del banco con el que está enlazado, importe y fecha, pagado entre varios (y cuál es tu parte), dirección, líneas…
- **Volver a analizar** con otro modelo si la lectura no te convence.
- **Otras monedas**: los tiquets en otra divisa se convierten a euros con el cambio de ese día.

### Panel de gastos
- Gasto del mes, comparado con tu gasto habitual, y previsión a fin de mes.
- Calendario del mes con el gasto de cada día; al pasar por encima, el detalle.
- Gasto por categorías (gráfico de anillo) y gasto a lo largo del tiempo.
- **Historial** con buscador, filtros y orden, que mezcla tiquets y movimientos del banco sin contar nada dos veces.
- Panel de **Bizum e ingresos**, aparte de los gastos.

### Establecimientos y mapa
- Cada sitio es un **establecimiento** con su ficha: dónde está, qué tiquets y cargos tiene, y qué es.
- **Verificación con Google Maps**: el establecimiento se busca en Google y se queda con su nombre, dirección y ubicación reales. Si hay varios candidatos, eliges el bueno.
- **Mapa** de dónde gastas, agrupado por zonas.
- Unir dos establecimientos que son el mismo sitio, marcar uno como tienda online (sin ubicación) o marcarlo como suscripción.

### Banco (opcional)
- **Lectura de tus movimientos** mediante [Enable Banking](https://enablebanking.com) (PSD2, **solo lectura**: la aplicación no puede hacer pagos).
- **Descarga automática** cada 6 horas y botón para actualizar a mano.
- **Entiende los conceptos**: pago con tarjeta, Bizum enviado o recibido, transferencia, recibo, devolución…
- **Une cada cargo con su tiquet** (mismo importe, mismos días, mismo sitio). Un cargo con tiquet no se cuenta dos veces.
- **Unifica nombres**: «MCDONALDS MANRESA» y «MCDONALD'S» acaban en el mismo establecimiento (con Gemini y Google Maps).
- **Categoriza** solo y aprende de lo que corriges a mano.
- **Suscripciones**: detecta cobros que se repiten (mensuales, anuales…), te deja confirmarlos o añadirlos, y los próximos cobros salen en el calendario.
- **Importar extractos antiguos** en Excel o en PDF, para tener más historia que la que da la conexión, y **convertir un extracto PDF a Excel**.
- **Gastos compartidos**: marca que un pago fue entre varios y cuánto fue tu parte; los restaurantes a partir de cierto importe te lo preguntan solos.

### Más
- **Se instala como app** en el móvil y en el ordenador (PWA).
- **En tiempo real** entre dispositivos: subes un tiquet en el móvil y aparece en el ordenador.
- **Temas** claro y oscuro, con varias paletas de color.

---

## Qué datos salen de tu máquina

Todo se guarda en local: `database/` (las bases SQLite) y `uploads/` (las fotos). Solo sale lo imprescindible para cada función, y solo si la activas:

| Servicio | Qué recibe | Cuándo |
|---|---|---|
| **Google Gemini** | La foto o el PDF del tiquet. Nombres de comercios del banco y conceptos, para identificarlos y categorizarlos | Al analizar un tiquet; en segundo plano con el banco |
| **Google Places** (opcional) | Nombre y dirección del establecimiento | Al verificar un establecimiento nuevo |
| **Google Maps** (opcional) | Lo que ve cualquier mapa web: la zona que miras | Al abrir el mapa |
| **Nominatim / OpenStreetMap** (opcional) | La dirección del establecimiento | Una vez por establecimiento, para situarlo |
| **Enable Banking** (opcional) | Tu permiso de acceso al banco | Al conectar y en cada descarga |
| **Frankfurter** | Moneda y fecha | Al convertir un tiquet en otra moneda |

Los extractos que importas (Excel o PDF) se leen **en tu navegador**; al servidor solo llegan las filas. La interfaz carga algunas librerías desde CDN públicos (Tailwind, SheetJS, pdf.js).

> ⚠️ **Gemini gratuito**: con la capa gratuita de la API, Google puede usar lo que envías para mejorar sus productos. Si no quieres que tus tiquets se usen así, activa la facturación en tu proyecto de Google AI Studio (ver las [condiciones de la API de Gemini](https://ai.google.dev/gemini-api/terms)).

---

## Instalación rápida

Para probarlo en tu ordenador en unos minutos.

### Requisitos
- **Node.js 24 o superior** ([descargar](https://nodejs.org)).
- **Git**.
- Una **clave de Gemini** (gratis, ver el siguiente apartado).

### Pasos

```bash
git clone https://github.com/Ipasky/ticket-scanner.git
cd ticket-scanner
npm install
cp .env.example .env        # en Windows (PowerShell): Copy-Item .env.example .env
```

Abre `.env` con un editor y rellena, como mínimo:

```ini
GEMINI_API_KEY=tu-clave-de-gemini
GEMINI_MODELOS=gemini-2.5-pro,gemini-flash-latest

# Entrar con contraseña (para tu ordenador). En un servidor, ver "Ponerlo en un servidor".
AUTH_MODE=local
AUTH_PASSWORD_HASH=      # lo genera el comando de abajo
SESSION_SECRET=          # lo genera el comando de abajo
```

Genera la contraseña (te la pide dos veces, sin mostrarla, e imprime la línea que va en `AUTH_PASSWORD_HASH`):

```bash
npm run hash-password
```

Genera el secreto de la sesión y pégalo en `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Arranca:

```bash
npm start
```

Abre **http://localhost:3000**, entra con tu contraseña y sube tu primer tiquet.

> Si `npm install` falla al compilar `better-sqlite3`, te faltan las herramientas de compilación: en Windows, marca *"Tools for Native Modules"* al instalar Node; en Linux, `sudo apt install build-essential python3`; en macOS, `xcode-select --install`.

---

## Conectar Gemini (obligatorio)

Gemini es el modelo de Google que lee las fotos.

1. Entra en **[Google AI Studio → API keys](https://aistudio.google.com/app/apikey)** con tu cuenta de Google.
2. Pulsa **Create API key** y cópiala.
3. Pégala en `.env`, en `GEMINI_API_KEY`.
4. Elige los modelos en `GEMINI_MODELOS`, **del preferido al de respaldo**, separados por comas:

   ```ini
   GEMINI_MODELOS=gemini-2.5-pro,gemini-flash-latest
   ```

   Si el primero está saturado o se queda sin cuota, la aplicación pasa sola al siguiente. Al subir una foto puedes forzar **Mejor** (el primero) o **Rápido** (el último).

Para ver qué modelos tiene disponibles tu clave:

```bash
node src/check_models.js
```

---

## Mapa y establecimientos (opcional)

Sin nada de esto la aplicación funciona igual, pero sin mapa y sin verificar los establecimientos.

### Situar los establecimientos (gratis, OpenStreetMap)

Nominatim pide que cada aplicación se identifique. Pon un nombre y tu correo:

```ini
NOMINATIM_USER_AGENT=ticket-scanner/1.0 (tu-correo@ejemplo.com)
GEO_PAIS=España
```

Para situar de golpe los establecimientos que ya tengas: `npm run geocodificar`.

### Verificación con Google y mapa (Google Maps Platform)

Hacen falta **dos claves** de [Google Cloud](https://console.cloud.google.com/apis/credentials), en un proyecto con facturación activada (los usos normales de una persona caben de sobra en la cuota gratuita mensual de Google):

| Variable | Activa la API | Restríngela a |
|---|---|---|
| `GOOGLE_PLACES_API_KEY` | **Places API (New)** | Solo esa API. La usa el servidor |
| `GOOGLE_MAPS_API_KEY` | **Maps JavaScript API** | Solo esa API **y** tu dominio (*Restricción de sitios web*). Es visible en el navegador |

Opcional: `GOOGLE_MAPS_MAP_ID` con un Map ID propio para el estilo del mapa.

---

## Conectar el banco (opcional)

La conexión usa **Enable Banking**, un proveedor autorizado de acceso a cuentas (PSD2). Para uso personal es **gratis** en modo restringido: solo puedes leer las cuentas que tú mismo enlaces.

### 1. Registrar tu aplicación en Enable Banking

1. Crea una cuenta en **[enablebanking.com](https://enablebanking.com/sign-in/)** y espera el correo de confirmación.
2. En el **[panel de control → Applications](https://enablebanking.com/cp/applications)**, registra una aplicación nueva:
   - Entorno: **Production** (Sandbox es solo para pruebas con bancos de mentira).
   - Clave privada: deja la opción por defecto, *generar en el navegador*. **El navegador descarga un fichero `.pem`**: guárdalo, no se puede volver a descargar.
   - **Redirect URL**: la dirección con la que abres la aplicación, seguida de `/banco/vuelta`. Por ejemplo `https://gastos.tudominio.com/banco/vuelta`. En producción Enable Banking exige `https`. No hace falta que sea accesible desde internet: la usa tu navegador.
   - Nombre, descripción, correo y enlaces de privacidad y condiciones: en modo restringido no se comprueban, puedes poner la misma URL de la aplicación.
3. Apunta el **Application ID** (un identificador tipo `12345678-1234-…`). El `.pem` se llama igual.
4. En la aplicación recién creada, pulsa **Link accounts**, elige tu banco y autoriza. **Este paso es obligatorio**: sin él no se ve ninguna cuenta. La aplicación quedará como *Restricted* y *Active*; es lo esperado.

### 2. Configurar ticket-scanner

Copia el `.pem` a la carpeta `keys/` del proyecto (está en el `.gitignore`: nunca se sube) y rellena en `.env`:

```ini
ENABLEBANKING_APP_ID=12345678-1234-1234-1234-123456789012
ENABLEBANKING_KEY_PATH=keys/12345678-1234-1234-1234-123456789012.pem
BANCO_REDIRECT_URL=https://gastos.tudominio.com/banco/vuelta   # exactamente la registrada
BANCO_ASPSP=Santander      # el nombre del banco tal como aparece en Enable Banking
BANCO_PAIS=ES
```

### 3. Conectar desde la aplicación

1. Reinicia el servidor y abre la ventana **Banco**.
2. Pulsa **Conectar con el banco**, autoriza en la web de tu banco y volverás a la aplicación.
3. **Marca las cuentas que quieres leer** (nacen sin marcar).
4. La primera descarga trae los últimos meses que dé tu banco (normalmente unos 90 días). Para más historia, **importa un extracto** (abajo).

### Cosas a saber
- El permiso dura lo que permita el banco (como mucho 180 días). Cuando caduque, pulsa **Renovar el permiso**.
- Los bancos limitan los accesos automáticos (unos 4 al día). La aplicación descarga cada 6 horas y, si el banco pone límite, espera al día siguiente. El botón **Sincronizar ahora** no gasta ese cupo.
- La lectura de conceptos está afinada con los de **Santander**. Con otros bancos los movimientos se descargan igual, pero puede que reconozca peor el comercio de cada pago.

### Importar extractos antiguos

En la ventana **Banco → Importar extracto**, elige el fichero que descargas de tu banca online:
- **Excel** (`.xls`, `.xlsx`, `.csv`) con las columnas *Fecha operación, Fecha valor, Concepto, Importe* y *Saldo*, y el IBAN en las primeras filas.
- **PDF** de extracto de cuenta (formato de Santander). Antes de importar se comprueba que todos los saldos cuadran; si falta o sobra una línea, te dice dónde.

**Convertir PDF a Excel** hace lo mismo pero te descarga el Excel, por si quieres guardarlo o revisarlo. Lo que ya estaba (por la conexión o por otro extracto) no se duplica.

---

## Ponerlo en un servidor

Para usarlo desde el móvil fuera de casa conviene tenerlo en un servidor (una Raspberry Pi, un NAS, un VPS…) y **detrás de un portal de acceso**. En ese modo la aplicación no gestiona contraseñas: confía en el usuario que le dice el portal.

```ini
AUTH_MODE=proxy
AUTH_PROXY_IPS_PERMITIDAS=127.0.0.1,::1     # desde dónde llega el portal (en K3s: 10.42.0.0/16)
AUTH_PROXY_HEADER=Remote-User               # la cabecera con el usuario
AUTH_PORTAL_URL=https://auth.tudominio.com
AUTH_LOGOUT_URL=https://auth.tudominio.com/logout
```

| Portal | `AUTH_PROXY_HEADER` |
|---|---|
| Authelia | `Remote-User` (por defecto) |
| oauth2-proxy | `X-Forwarded-User` |
| Cloudflare Access | `Cf-Access-Authenticated-User-Email` |

> ⚠️ **El puerto de la aplicación no debe ser accesible si no es a través del portal.** Cualquiera que llegue directamente podría hacerse pasar por ti con una cabecera. `AUTH_PROXY_IPS_PERMITIDAS` rechaza lo que no venga del portal, pero cierra también el puerto con el cortafuegos.

Otros consejos:
- Sirve la aplicación por **HTTPS** (lo exige el banco y lo necesita la app instalable).
- Si usas `AUTH_MODE=local` con HTTPS, pon `AUTH_COOKIE_SECURE=true`.
- Para que arranque sola, usa un servicio de `systemd`, `pm2` o un contenedor.

---

## Guía de uso

1. **Sube un tiquet** con el botón de subir (en el móvil puedes hacer la foto directamente). Puedes elegir el modo (Automático, Mejor, Rápido). En unos segundos aparece en el historial.
2. **Revísalo**: abre la ficha. Arriba están el establecimiento y la categoría; la bolita verde junto al nombre indica que el sitio está verificado en Google. Corrige lo que haga falta y guarda.
3. **Establecimientos**: con la flecha ↗ junto al nombre vas a su ficha, donde puedes verificarlo en Google, ponerle la dirección pegando la de Google Maps, marcarlo como online o unirlo con otro.
4. **Banco**: en el historial los pagos sin tiquet salen con el aviso *Falta el tiquet*. Al abrir un movimiento puedes cambiar su tipo y su categoría, enlazarlo con su tiquet, marcarlo como compartido, decir que no cuenta como gasto (un traspaso entre tus cuentas) o marcarlo como suscripción.
5. **Cambiar el establecimiento de un pago** solo cambia ese pago. Si quieres cambiarlo en todos los pagos con ese nombre en el banco, marca la casilla que aparece, y te pedirá confirmación.
6. **Panel**: el calendario, las categorías y el mapa se actualizan solos con cada cambio, también en tus otros dispositivos.

---

## Copias de seguridad

Todo lo tuyo está en dos carpetas. Cópialas con el servidor parado (o copia también los ficheros `-wal` y `-shm`):

- `database/` → `tickets.db` (tiquets y establecimientos) y `banco.db` (movimientos).
- `uploads/` → las fotos originales, tal cual las subiste.

Y guarda aparte tu `.env` y la carpeta `keys/`.

---

## Desarrollo

| Comando | Para qué |
|---|---|
| `npm start` | Arranca el servidor (puerto `PORT`, por defecto 3000) |
| `npm test` | Pruebas (`node:test`, sin dependencias) |
| `npm run hash-password` | Genera el hash de la contraseña del modo local |
| `npm run geocodificar` | Sitúa en el mapa los establecimientos pendientes |
| `npm run iconos` | Regenera los iconos de la app instalable |
| `node src/check_models.js` | Lista los modelos de Gemini de tu clave |

**Stack**: Node.js ≥ 24, Express, better-sqlite3, `@google/genai`. El frontend es HTML, Tailwind y JavaScript sin framework, sin paso de compilación. Todas las variables de configuración están explicadas en [`.env.example`](.env.example).

```
src/
  app.js            servidor Express
  routes/           rutas de la API
  controllers/      tiquets y estadísticas
  services/         Gemini, banco, establecimientos, mapa, autenticación…
  public/           la interfaz (index.html, app.js) y la PWA
scripts/            utilidades (contraseña, iconos, geocodificación)
tests/              pruebas
database/ uploads/  tus datos (fuera de git)
```

## Licencia

[MIT](LICENSE) © 2026 Isaac Pascual
