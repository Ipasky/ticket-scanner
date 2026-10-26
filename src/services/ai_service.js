const { GoogleGenAI, Type } = require("@google/genai");
const path = require('path');
// Importante: forzar la ruta del .env como hicimos antes
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- REGLA ANTI-RAZONAMIENTO -------------------------------------------------
// El responseSchema valida la ESTRUCTURA (que el campo sea un string), no el
// CONTENIDO. El modelo ha llegado a guardar su propio razonamiento dentro de un
// campo, produciendo valores reales como:
//   "TARJETA ****6158 Quentin/anon format: TARJETA ****6158 -> TARJETA ****6158"
//   "TARJETA ****6158 Quentin/6158 -> TARJETA ****6158 (wait, let me fix ...)"
// Esta advertencia se cuelga de la descripción de TODOS los campos de texto
// libre. No es una garantía (el prompt nunca lo es), solo reduce la frecuencia.
// La garantía está en services/normalizacion.js, que descarta estos valores.
const SOLO_VALOR = ' Devuelve EXCLUSIVAMENTE el valor final, tal y como iría ' +
    'impreso en una etiqueta: sin explicaciones, sin razonamiento, sin ' +
    'alternativas, sin flechas "->", sin paréntesis aclaratorios, sin comillas, ' +
    'sin correcciones sobre la marcha y sin mencionar estas instrucciones. Si ' +
    'dudas entre dos lecturas, elige una y devuelve solo esa. Si no lo sabes, ' +
    'omite el campo.';

// --- SCHEMA DE SALIDA ESTRUCTURADA ------------------------------------------
// Google Gemini soporta responseSchema (subconjunto de OpenAPI 3). Al declararlo
// nos ahorramos pedir JSON en el prompt, quitar los fences a mano y rezar para
// que no meta comentarios. El SDK garantiza JSON parseable.
//
// Diseño: los campos comunes son columnas. Todo lo específico del tipo de
// documento (matrícula, andén, artista, número de factura...) va en `detalles`
// como array de pares {clave, valor}, para que el modelo pueda inventar
// atributos que yo no he previsto sin romper el schema.
//
// La salida es SIEMPRE un array de tiquets, también cuando la foto tiene uno
// solo (entonces es un array de longitud 1). Un único camino de código: dos
// rutas distintas para "una foto, un tiquet" y "una foto, varios" acabarían
// divergiendo con el tiempo y los arreglos se aplicarían solo a una.
const tiquetSchema = {
    type: Type.OBJECT,
    properties: {
        indice_en_foto: {
            type: Type.INTEGER,
            description:
                'Posición de este documento dentro de la foto, empezando en 0 y en ' +
                'ORDEN DE LECTURA: de arriba abajo, y de izquierda a derecha cuando ' +
                'dos están a la misma altura. Si la foto tiene un solo documento, 0.'
        },
        // El formato NATIVO de Gemini para cajas: [ymin, xmin, ymax, xmax]
        // normalizado a 0..1000. Es con el que se ha entrenado a detectar
        // objetos; pedirle fracciones {x,y,ancho,alto} le obligaba a convertir y
        // las cajas salían desplazadas.
        box_2d: {
            type: Type.ARRAY,
            nullable: true,
            items: { type: Type.INTEGER },
            description:
                'Caja que encierra ESTE documento completo (todo el papel, de borde ' +
                'a borde) dentro de la foto, como [ymin, xmin, ymax, xmax] ' +
                'normalizados de 0 a 1000. Solo sirve para dibujar un marco al ' +
                'revisar, nunca para recortar.'
        },
        tipo_documento: {
            type: Type.STRING,
            description:
                'Tipo del documento, texto libre en MAYÚSCULAS, de 1 a 4 palabras. ' +
                'Válidos: "COMPRA", "RESTAURANTE", "ENTRADA CONCIERTO", "PARKING", ' +
                '"BILLETE TREN", "PEAJE", "COMBUSTIBLE", "FACTURA".' + SOLO_VALOR
        },
        categoria: {
            type: Type.STRING,
            description:
                'Categoría de gasto, UNA sola palabra en MAYÚSCULAS. ' +
                'Válidos: "ALIMENTACION", "RESTAURACION", "TRANSPORTE", "OCIO", ' +
                '"ROPA", "HOGAR", "ELECTRONICA", "SALUD", "OTROS".' + SOLO_VALOR
        },
        nombre_establecimiento: {
            type: Type.STRING,
            description:
                'Nombre comercial del local u operador en MAYÚSCULAS, sin razón ' +
                'social, máximo 100 caracteres. Válidos: "MERCADONA", "RENFE", ' +
                '"SABA PARKING". NO válido: "MERCADONA S.A. (el de la calle Mayor, ' +
                'creo)".' + SOLO_VALOR
        },
        direccion: {
            type: Type.STRING,
            description: 'Calle y número, nada más. Válido: "CALLE MAYOR 12".' + SOLO_VALOR
        },
        ciudad: {
            type: Type.STRING,
            description: 'Solo el nombre de la población. Válido: "BARCELONA".' + SOLO_VALOR
        },
        codigo_postal: {
            type: Type.STRING,
            description: 'Solo los dígitos del código postal. Válido: "08001".' + SOLO_VALOR
        },
        lugar_inferido: {
            type: Type.STRING,
            nullable: true,
            description:
                'NOMBRE del lugar donde se hizo el gasto, DEDUCIDO del contenido, y ' +
                'solo cuando el documento NO trae dirección ni población. Es un ' +
                'topónimo o el nombre de un sitio reconocible, nunca coordenadas y ' +
                'nunca una calle inventada. SIEMPRE con su contexto geográfico ' +
                '(localidad o comarca, provincia y comunidad), porque un topónimo ' +
                'suelto se repite por todo el país: "MONTSERRAT" a secas puso un ' +
                'parking de la montaña de Barcelona en Montserrat (Valencia). ' +
                'Válidos: "MONTSERRAT, BARCELONA, CATALUNYA" en un tiquet del ' +
                '"PATRONAT DE LA MUNTANYA DE MONTSERRAT"; "AEROPUERTO DE BARCELONA ' +
                'EL PRAT, BARCELONA, CATALUNYA" en una consumición de la T1; ' +
                '"PARQUE NACIONAL DE ORDESA, HUESCA, ARAGON". Si el lugar no se ' +
                'deduce con CLARIDAD del propio documento, devuelve null: un lugar ' +
                'inventado pone un punto falso en el mapa, que es peor que no poner ' +
                'ninguno.' + SOLO_VALOR
        },
        fecha_compra: {
            type: Type.STRING,
            description:
                'ISO 8601 y nada más: "YYYY-MM-DD HH:MM:SS" si aparece la hora en ' +
                'el documento, "YYYY-MM-DD" si solo aparece la fecha. Válidos: ' +
                '"2026-01-14 18:05:09", "2026-01-14". NO rellenes con 00:00:00 ' +
                'cuando no haya hora real.' + SOLO_VALOR
        },
        fecha_evento: {
            type: Type.STRING,
            description:
                'Solo si el documento es una entrada/reserva a un evento futuro. ' +
                'Mismo formato exacto que fecha_compra. Omite si no aplica.' + SOLO_VALOR
        },
        total_centimos: {
            type: Type.INTEGER,
            nullable: true,
            description:
                'Total pagado, en CÉNTIMOS enteros. 12,34 EUR -> 1234. ' +
                'Distingue dos casos que NO son lo mismo: ' +
                '(a) null = el documento NO muestra ningún importe. Ejemplo: tiquet ' +
                'de ENTRADA de parking, donde se paga a la salida y el papel no lleva ' +
                'importe impreso; también albaranes y justificantes de acceso. ' +
                '(b) 0 = el documento SÍ imprime un importe y ese importe es cero. ' +
                'Ejemplo: entrada gratuita o invitación que pone "0,00 EUR", ' +
                '"GRATIS" o "TOTAL: 0,00". ' +
                'Nunca devuelvas 0 para decir "no lo he encontrado": eso convierte un ' +
                'documento sin importe en un gasto de 0 EUR. Si no hay importe ' +
                'impreso en el documento, devuelve null. ' +
                'Pagos en efectivo: el total es el de la compra (TOTAL), NUNCA el ' +
                'dinero entregado (ENTREGADO, EFECTIVO, LLIURAMENT, ENTREGAT) ni el ' +
                'cambio (CAMBIO, DEVOLUCIÓN, DEVOLUCIÓ, CANVI, A DEVOLVER).'
        },
        efectivo_entregado_centimos: {
            type: Type.INTEGER,
            nullable: true,
            description:
                'Solo en pagos en efectivo: el dinero que se entregó, en céntimos ' +
                '(líneas ENTREGADO, EFECTIVO, LLIURAMENT EFECTIU, ENTREGAT). ' +
                'null si no aparece.'
        },
        cambio_centimos: {
            type: Type.INTEGER,
            nullable: true,
            description:
                'Solo en pagos en efectivo: el cambio devuelto, en céntimos (líneas ' +
                'CAMBIO, DEVOLUCIÓN, DEVOLUCIÓ, CANVI, A DEVOLVER). null si no aparece.'
        },
        moneda: {
            type: Type.STRING,
            description:
                'Código ISO 4217 de EXACTAMENTE 3 letras mayúsculas. ' +
                'Válidos: "EUR", "USD", "GBP". NO válidos: "EUROS", "Euro".' + SOLO_VALOR
        },
        metodo_pago: {
            type: Type.STRING,
            description:
                'Método de pago, en MAYÚSCULAS y con formato EXACTO. Los únicos ' +
                'valores admitidos son: "EFECTIVO", "TARJETA", "TARJETA ****1234" ' +
                '(con los 4 últimos dígitos si aparecen impresos), "BIZUM", ' +
                '"TRANSFERENCIA", "MIXTO" o "DESCONOCIDO". Máximo 40 caracteres. ' +
                'El valor debe ser SOLO uno de esos, sin nada pegado detrás: ni el ' +
                'nombre del titular, ni el número de operación, ni la red de pago, ' +
                'ni comentarios. ' +
                'NO válidos (valores reales que se han colado antes): ' +
                '"TARJETA ****6158 Quentin/6158 -> TARJETA ****6158", ' +
                '"TARJETA ****6158 Quentin/anon format: TARJETA ****6158", ' +
                '"TARJETA (wait, let me fix the formatting...)".' + SOLO_VALOR
        },
        items: {
            type: Type.ARRAY,
            description: 'Líneas de producto o conceptos individuales, si el documento las tiene.',
            items: {
                type: Type.OBJECT,
                properties: {
                    producto: {
                        type: Type.STRING,
                        description:
                            'Nombre del producto o concepto tal como aparece en la ' +
                            'línea, máximo 120 caracteres.' + SOLO_VALOR
                    },
                    cantidad: {
                        type: Type.NUMBER,
                        description: 'Número de unidades. Solo el número.'
                    },
                    precio_centimos: {
                        type: Type.INTEGER,
                        description:
                            'Importe de la línea en céntimos (unitario si el ticket lo ' +
                            'separa, si no total de la línea). Solo el número entero.'
                    }
                },
                required: ["producto", "cantidad", "precio_centimos"]
            }
        },
        detalles: {
            type: Type.ARRAY,
            description:
                'Todo lo relevante que NO encaje en los campos anteriores. Cada ' +
                'entrada es {clave, valor} con ambos como texto. Máximo 30 entradas.',
            items: {
                type: Type.OBJECT,
                properties: {
                    clave: {
                        type: Type.STRING,
                        description:
                            'Nombre de campo YA NORMALIZADO: snake_case ASCII, solo ' +
                            'caracteres [a-z0-9_], en minúsculas, sin acentos ni ' +
                            'diacríticos, sin espacios (usa "_"), sin signos (º, ª, %, ' +
                            'dos puntos), máximo 40 caracteres. ' +
                            'Válidos: "matricula", "hora_entrada", "hora_salida", ' +
                            '"duracion_minutos", "artista", "recinto", "asiento", ' +
                            '"origen", "destino", "numero_factura", "nif_emisor". ' +
                            'Conversiones: "Matrícula del vehículo" -> ' +
                            '"matricula_del_vehiculo"; "Nº Factura" -> ' +
                            '"numero_factura"; "Hora-Entrada" -> "hora_entrada".' +
                            SOLO_VALOR
                    },
                    valor: {
                        type: Type.STRING,
                        description:
                            'El valor tal como aparece en el documento, SIN normalizar: ' +
                            'mantén mayúsculas y formato original ("9180KGJ", "17:27", ' +
                            '"38.72"). Máximo 200 caracteres.' + SOLO_VALOR
                    }
                },
                required: ["clave", "valor"]
            }
        }
    },
    required: [
        "indice_en_foto",
        "box_2d",
        "tipo_documento",
        "nombre_establecimiento",
        "fecha_compra",
        "total_centimos",
        "moneda"
    ]
};

// Lo que se le pide al modelo: la lista de documentos que hay en la foto.
const responseSchema = {
    type: Type.ARRAY,
    description:
        'Un elemento por cada documento económico DISTINTO que aparezca en la ' +
        'imagen, en orden de lectura. Si la imagen contiene un solo documento, un ' +
        'array de un elemento. Nunca un array vacío si se ve algún documento, y ' +
        'nunca elementos inventados para rellenar.',
    items: tiquetSchema
};

// --- PROMPT ------------------------------------------------------------------
// El prompt ya no describe el JSON: eso lo hace el responseSchema. Aquí solo
// van las instrucciones de contenido.
const PROMPT = `
Eres un motor de extracción de datos de documentos económicos: tiquets de
compra, entradas, facturas, billetes, parkings, peajes, combustible, etc.

La entrada puede ser una FOTO o un PDF, y puede contener UNO O VARIOS documentos
(varios tiquets sobre la mesa, fotografiados juntos). Devuelves siempre una
LISTA, con un elemento por documento.

Si es un PDF de VARIAS PÁGINAS, lo normal es que todas sean UN SOLO documento:
una factura con su desglose, sus condiciones y su pie. Son varios documentos solo
si el PDF junta facturas o tiquets INDEPENDIENTES, cada uno con su número y su
importe total propios. Un desglose que continúa en la página siguiente NO es otro
documento.

0. REGLA QUE MANDA SOBRE TODAS LAS DEMÁS
   - Cada campo contiene SOLO su valor final, como iría impreso en una etiqueta.
   - Nunca escribas dentro de un campo tu proceso de decisión: ni alternativas,
     ni flechas "->", ni "wait", ni "let me", ni referencias a estas
     instrucciones, ni comillas de cita, ni paréntesis aclaratorios, ni
     correcciones sobre la marcha.
   - Si dudas entre dos lecturas, elige UNA y devuelve solo esa. Si no sabes un
     campo, omítelo: un hueco es recuperable, un valor contaminado no.
   - Un valor que se sale de su formato se descarta entero al guardarlo, así que
     mezclar explicación con dato pierde también el dato.

1. CUÁNTOS DOCUMENTOS HAY
   - Primero decide cuántos documentos DISTINTOS se ven en la imagen. Un elemento
     de la lista por documento, ni más ni menos.
   - NO inventes documentos. Si solo hay uno, devuelve exactamente uno. Es mucho
     peor partir un tiquet en dos que dejarlo entero.
   - Son UN SOLO documento, no varios:
     · Un tiquet largo doblado, o fotografiado en dos trozos que se continúan.
     · El tiquet y su justificante de pago con tarjeta grapados o pegados, cuando
       repiten el mismo importe y la misma hora.
     · La cara y el reverso del mismo papel.
     · Un tiquet con varias páginas numeradas ("1/2", "2/2").
   - Son documentos DISTINTOS: papeles separados, de establecimientos distintos,
     o del mismo establecimiento con número de tiquet, fecha, hora o importe
     distintos.
   - Varios tiquets del MISMO establecimiento puestos uno al lado del otro se
     parecen mucho (mismo logo, misma cabecera), pero son documentos DISTINTOS:
     cuenta los papeles físicamente separados y los TOTALES distintos que ves.
     Tres tiras de papel con tres totales son tres documentos.
   - indice_en_foto numera en orden de lectura desde 0: de arriba abajo, y de
     izquierda a derecha cuando dos están a la misma altura.
   - box_2d: la caja de cada documento, [ymin, xmin, ymax, xmax] de 0 a 1000,
     encerrando el papel entero de borde a borde. Fíjate en que cada caja
     corresponda al MISMO documento cuyos datos estás devolviendo en ese
     elemento, no al de al lado.
   - Cada elemento se rellena como si fuera el único documento de la foto, con
     todas las reglas de abajo aplicadas por separado.

2. CLASIFICACIÓN
   - tipo_documento es texto libre en MAYÚSCULAS, sin lista cerrada. Elige lo
     más descriptivo posible: "COMPRA", "RESTAURANTE", "ENTRADA CONCIERTO",
     "ENTRADA MUSEO", "PARKING", "BILLETE TREN", "BILLETE AVION", "PEAJE",
     "COMBUSTIBLE", "FACTURA", "SUSCRIPCION"...
   - categoria es la naturaleza del gasto (ALIMENTACION, RESTAURACION,
     TRANSPORTE, OCIO, ROPA, HOGAR, ELECTRONICA, SALUD, OTROS).

3. IMPORTES
   - TODOS los importes van en CÉNTIMOS enteros. Nunca decimales.
     12,34 EUR → 1234. 0,80 EUR → 80.
   - total_centimos es el importe final pagado.
   - "SIN IMPORTE" y "IMPORTE CERO" son cosas distintas y no se confunden:
     · null → el documento NO imprime ningún importe. Ejemplo típico: tiquet de
       ENTRADA de parking, que se paga a la salida y no lleva importe; también
       albaranes y justificantes de acceso. No es un gasto de 0 EUR: es un
       documento sin importe.
     · 0    → el documento SÍ imprime un importe y vale cero. Ejemplo: entrada
       gratuita o invitación con "0,00 EUR", "GRATIS" o "TOTAL: 0,00".
   - Nunca uses 0 como forma de decir "no lo encuentro". Si no hay importe
     impreso, total_centimos es null.
   - PAGO EN EFECTIVO: el tiquet suele traer tres cifras seguidas: el TOTAL de
     la compra, el dinero ENTREGADO (EFECTIVO, LLIURAMENT EFECTIU, ENTREGAT) y
     el CAMBIO devuelto (DEVOLUCIÓN, DEVOLUCIÓ, CANVI). total_centimos es SIEMPRE
     el TOTAL de la compra, nunca el entregado ni el cambio. Pon el entregado en
     efectivo_entregado_centimos y el cambio en cambio_centimos.
     Comprobación: TOTAL + CAMBIO = ENTREGADO.
     Ejemplo: TOTAL 11,10 · LLIURAMENT EFECTIU 50,00 · DEVOLUCIÓ 38,90 →
     total_centimos 1110, efectivo_entregado_centimos 5000, cambio_centimos 3890.

4. ESTABLECIMIENTO
   - nombre_establecimiento en MAYÚSCULAS, nombre comercial, sin razón social
     (ej: "MERCADONA", no "MERCADONA S.A."). Para operadores de transporte usa
     "RENFE", "IBERIA", "EMT", etc.
   - direccion, ciudad y codigo_postal por separado, mirando cabecera Y pie de
     página.
   - lugar_inferido SOLO si el documento no trae dirección ni población y el
     lugar se deduce con claridad de lo que está impreso: el nombre del emisor,
     el del recinto, el de la estación. Es un NOMBRE de lugar, nunca coordenadas,
     y SIEMPRE con su contexto geográfico: localidad o comarca, provincia y
     comunidad, separadas por comas. Un topónimo suelto se repite por todo el
     país y acaba poniendo el punto a 300 km.
     Ejemplo: un tiquet de parking del "PATRONAT DE LA MUNTANYA DE MONTSERRAT" no
     lleva calle, pero el lugar es evidente → lugar_inferido:
     "MONTSERRAT, BARCELONA, CATALUNYA" (y NO "MONTSERRAT" a secas, que es
     también un pueblo de Valencia: ahí acabó el punto).
     Si hay dirección o población impresas, lugar_inferido va a null: lo impreso
     manda siempre sobre lo deducido. Si el lugar no está claro, null también.

5. FECHAS
   - fecha_compra en ISO. Usa "YYYY-MM-DD HH:MM:SS" SOLO si la hora aparece
     realmente en el documento; en caso contrario "YYYY-MM-DD". No inventes
     "00:00:00" cuando no haya hora real: eso es información falsa.
   - EN UNA FACTURA, fecha_compra es la fecha de EMISIÓN de la factura. Ni la de
     vencimiento, ni la de pago, ni el periodo facturado: la de emisión. La de
     vencimiento va en detalles (fecha_vencimiento).
   - fecha_evento solo para documentos que representan una asistencia futura
     (entrada de concierto, reserva de museo, billete de tren con hora de
     salida). Si no aplica, no lo devuelvas.

6. MÉTODO DE PAGO
   - Formato CERRADO. Los únicos valores admitidos son exactamente:
     "EFECTIVO", "TARJETA", "TARJETA ****1234", "BIZUM", "TRANSFERENCIA",
     "MIXTO", "DESCONOCIDO".
   - Si es tarjeta, busca los últimos 4 dígitos (patrón ****1234) y devuelve
     "TARJETA ****1234". Si es tarjeta pero no aparecen los dígitos, devuelve
     solo "TARJETA".
   - Nada más pegado detrás: ni titular, ni número de operación, ni red de pago,
     ni comentarios. Máximo 40 caracteres.
     NO: "TARJETA ****6158 Quentin/6158 -> TARJETA ****6158"
     NO: "TARJETA ****6158 Quentin/anon format: TARJETA ****6158"
     SÍ: "TARJETA ****6158"

7. ITEMS
   - Solo si el documento lista productos o conceptos separados. Un parking sin
     desglose no tiene items.

8. DETALLES
   - Aquí va TODO lo relevante del documento que no encaje en los campos
     comunes. Piensa en lo que necesitarías para reconstruir el documento
     mentalmente.
   - Ejemplos por tipo:
     · PARKING: matricula, hora_entrada, hora_salida, duracion_minutos, plaza
     · ENTRADA CONCIERTO: artista, recinto, sector, fila, asiento, puerta
     · ENTRADA MUSEO: exposicion, franja_horaria
     · BILLETE TREN: origen, destino, coche, plaza, tren, hora_salida,
       hora_llegada, clase, tarifa
     · BILLETE AVION: origen, destino, vuelo, asiento, terminal, hora_embarque
     · COMBUSTIBLE: litros, producto, precio_litro_centimos, surtidor
     · FACTURA: numero_factura, nif_emisor, nif_receptor, base_imponible,
       cuota_iva, fecha_vencimiento. Los cinco primeros son lo que hace
       identificable una factura, así que en una factura NO son opcionales si
       están impresos. base_imponible y cuota_iva, en céntimos y como texto
       ("12345"); fecha_vencimiento en "YYYY-MM-DD".
     · PEAJE: origen, destino, autopista
   - clave YA NORMALIZADA: snake_case ASCII, solo [a-z0-9_], minúsculas, sin
     acentos ni diacríticos, espacios y guiones convertidos en "_", sin signos.
       "Matrícula del vehículo" → "matricula_del_vehiculo"
       "Hora-Entrada"          → "hora_entrada"
       "Nº Factura"            → "numero_factura"
     Máximo 40 caracteres.
   - valor SIN normalizar: tal como está impreso, respetando mayúsculas y
     formato ("9180KGJ", "17:27", "38.72"). Siempre string; formatea los números
     como texto. Máximo 200 caracteres.
   - Máximo 30 pares por documento. Si tienes que elegir, quédate con lo que
     identifica el documento, no con lo decorativo.
   - NO dupliques información que ya esté en un campo común.
`;

// --- LISTA DE MODELOS Y MODOS DE SELECCIÓN ----------------------------------
// GEMINI_MODELOS es una lista ORDENADA, del preferido al de respaldo. Hay dos
// razones para que sea una lista y no un nombre:
//
//   · Las cuotas y la saturación son POR MODELO. Un 503 o un 429 de uno no dice
//     nada del siguiente: cambiar de modelo es la única reacción que realmente
//     puede salvar la petición, y esperar no lo hace cuando la cuota está agotada.
//   · Calidad contra precio es una decisión por foto, no del despliegue. Un
//     tiquet de súper arrugado merece el modelo bueno; una entrada de parking con
//     cuatro números, no.
//
// GEMINI_MODEL (singular) se sigue leyendo como respaldo para no romper un .env
// existente: un solo modelo es exactamente el caso de una lista de uno.

/** Lee la lista ordenada, sin huecos ni repetidos. */
function leerModelos(entorno = process.env) {
    const crudo = String(entorno.GEMINI_MODELOS || entorno.GEMINI_MODEL || '');
    const vistos = new Set();
    const modelos = [];

    for (const trozo of crudo.split(',')) {
        const nombre = trozo.trim();
        // Un nombre repetido en la lista no añade un respaldo: añade una espera
        // más contra el mismo modelo saturado.
        if (!nombre || vistos.has(nombre)) continue;
        vistos.add(nombre);
        modelos.push(nombre);
    }
    return modelos;
}

const MODELOS = leerModelos();

// Los tres modos que ofrece la interfaz. Las etiquetas salen de aquí y NO del
// HTML: la lista de modelos cambia con el .env, y una etiqueta clavada en la
// plantilla mentiría en cuanto alguien añadiera o quitara un modelo.
const MODO_AUTOMATICO = 'automatico';
const MODO_RAPIDO     = 'rapido';
const MODO_MEJOR      = 'mejor';
const MODOS = [MODO_AUTOMATICO, MODO_MEJOR, MODO_RAPIDO];

/**
 * Qué modelos se van a probar, en orden, según el modo.
 *
 *   automatico  la lista entera: cascada completa.
 *   mejor       solo el primero. Si falla, falla: pedir calidad y recibir en
 *               silencio la lectura del modelo barato sería justo lo contrario
 *               de lo que se ha pedido.
 *   rapido      solo el último, el más barato de la lista.
 *
 * Con un solo modelo configurado los tres modos son el mismo, que es lo que debe
 * pasar: el modo elige entre lo que hay, no inventa modelos.
 */
function resolverModelos(modo = MODO_AUTOMATICO, modelos = MODELOS) {
    if (modelos.length === 0) return [];
    if (modo === MODO_MEJOR)  return [modelos[0]];
    if (modo === MODO_RAPIDO) return [modelos[modelos.length - 1]];
    return [...modelos];
}

/** Lo que el frontend necesita para pintar el selector. Sin secretos. */
function configuracionPublica(modelos = MODELOS) {
    const etiquetaCon = (nombre) => (modelos.length > 1 ? ` (${nombre})` : '');

    return {
        modelos: [...modelos],
        por_defecto: MODO_AUTOMATICO,
        modos: [
            {
                valor: MODO_AUTOMATICO,
                etiqueta: 'Automático',
                descripcion: modelos.length > 1
                    ? `Empieza por ${modelos[0]} y baja por la lista si falla o se agota la cuota.`
                    : 'Un solo modelo configurado.',
                modelos: resolverModelos(MODO_AUTOMATICO, modelos)
            },
            {
                valor: MODO_MEJOR,
                etiqueta: `Mejor${etiquetaCon(modelos[0] || '')}`,
                descripcion: 'Solo el modelo preferido, sin pasar a los de respaldo. Si falla, falla.',
                modelos: resolverModelos(MODO_MEJOR, modelos)
            },
            {
                valor: MODO_RAPIDO,
                etiqueta: `Rápido${etiquetaCon(modelos[modelos.length - 1] || '')}`,
                descripcion: 'Solo el último de la lista, el más barato.',
                modelos: resolverModelos(MODO_RAPIDO, modelos)
            }
        ]
    };
}

// --- CLASIFICACIÓN DE ERRORES ------------------------------------------------
// Un 503 temporal, un 429 de cuota, una clave inválida y un modelo inexistente
// son cuatro problemas distintos con cuatro respuestas distintas: el controller
// necesita distinguirlos para decidir si conserva la imagen y con qué estado, y
// la cascada para decidir si cambiar de modelo tiene sentido.

/**
 * Error de la capa de IA, ya clasificado.
 *   tipo   : transitorio | cuota | autenticacion | modelo | truncado |
 *            configuracion | permanente
 *   status : código HTTP original de la API, o null si no se pudo determinar
 *   mensaje: texto en español pensado para enseñárselo al usuario
 *   causa  : el error original, intacto
 */
class ErrorIA extends Error {
    constructor({ tipo, status, mensaje, causa }) {
        super(mensaje);
        this.name    = 'ErrorIA';
        this.tipo    = tipo;
        this.status  = status ?? null;
        this.mensaje = mensaje;
        this.causa   = causa ?? null;
    }
}

/**
 * Saca el código HTTP del error. @google/genai lanza un ApiError con `.status`,
 * pero según la capa que falle el número puede venir en `.code`, en
 * `.response.status`, en `.error.code`, o solo dentro del texto del mensaje.
 */
function extraerStatus(error) {
    if (!error) return null;

    const candidatos = [
        error.status,
        error.code,
        error.response && error.response.status,
        error.error && error.error.code
    ];
    for (const c of candidatos) {
        const n = Number(c);
        if (Number.isInteger(n) && n >= 400 && n <= 599) return n;
    }

    const m = /\b(4\d{2}|5\d{2})\b/.exec(String(error.message || ''));
    return m ? Number(m[1]) : null;
}

// Un status -> un tipo y un mensaje que explique qué ha pasado de verdad.
const POR_STATUS = {
    400: {
        tipo: 'configuracion',
        mensaje: 'Google ha rechazado la petición (400). La causa más probable es ' +
                 'GEMINI_MAX_OUTPUT_TOKENS: está pedido más de lo que admite el modelo ' +
                 'usado. Bájalo en el .env (8192 es el valor seguro para cualquier ' +
                 'modelo). La imagen se ha guardado.'
    },
    500: {
        tipo: 'transitorio',
        mensaje: 'Google ha tenido un error interno al procesar la imagen. Es temporal: el tiquet se ha guardado y puedes reintentarlo en un rato.'
    },
    503: {
        tipo: 'transitorio',
        mensaje: 'El modelo de Gemini está saturado ahora mismo. El tiquet se ha guardado sin procesar y se puede reintentar en unos minutos.'
    },
    429: {
        tipo: 'cuota',
        mensaje: 'Se ha agotado la cuota diaria de la API de Gemini. El tiquet se ha guardado sin procesar; podrás reintentarlo cuando la cuota se renueve.'
    },
    401: {
        tipo: 'autenticacion',
        mensaje: 'La clave de la API de Gemini no es válida. Revisa GEMINI_API_KEY en el .env. La imagen se ha guardado.'
    },
    403: {
        tipo: 'autenticacion',
        mensaje: 'La clave de la API de Gemini no tiene permiso para este modelo. Revisa GEMINI_API_KEY y los permisos del proyecto en Google. La imagen se ha guardado.'
    },
    // El 404 es el único mensaje que depende de QUÉ modelo se estaba usando, así
    // que lo construye clasificarError con el nombre real del intento. Antes
    // nombraba GEMINI_MODEL, que con una lista de modelos habría señalado al
    // inocente.
    404: { tipo: 'modelo', mensaje: null }
};

function mensajeModeloInexistente(modelo) {
    return `El modelo "${modelo || '(sin definir)'}" no existe o no está disponible para tu ` +
           `clave. Revisa GEMINI_MODELOS en el .env (src/check_models.js lista los ` +
           `disponibles). La imagen se ha guardado.`;
}

/** El código de un fallo de red de fetch/undici, buscando en la cadena de causas. */
function codigoDeRed(error) {
    for (let e = error, n = 0; e && n < 5; e = e.cause, n++) {
        const codigo = e.code || '';
        if (/^UND_ERR_|^ECONNRESET$|^ECONNREFUSED$|^ETIMEDOUT$|^ENOTFOUND$|^EAI_AGAIN$|^EPIPE$/.test(codigo)) return codigo;
    }
    if (error && error.name === 'TypeError' && /fetch failed/i.test(error.message || '')) return 'FETCH_FAILED';
    return null;
}

/**
 * Envuelve cualquier error de la API en un ErrorIA ya clasificado.
 * `modelo` es el que se estaba usando, para poder nombrarlo en el mensaje.
 */
function clasificarError(error, modelo = null) {
    if (error instanceof ErrorIA) return error;

    const status = extraerStatus(error);
    const conocido = POR_STATUS[status];

    if (conocido) {
        return new ErrorIA({
            ...conocido,
            mensaje: conocido.mensaje || mensajeModeloInexistente(modelo),
            status,
            causa: error
        });
    }

    // Fallo de RED (sin HTTP): no es culpa del tiquet. Un timeout esperando a
    // Gemini (UND_ERR_HEADERS_TIMEOUT: más de 5 min pensando con una foto
    // grande) no se reintenta con el mismo modelo, que volvería a tardar lo
    // mismo: se pasa al siguiente. Un corte de red sí se reintenta.
    const red = codigoDeRed(error);
    if (red) {
        const lento = /TIMEOUT|ETIMEDOUT/.test(red);
        const e = new ErrorIA({
            tipo: 'transitorio',
            status: null,
            mensaje: lento
                ? `El modelo ${modelo || ''} no ha respondido a tiempo. El tiquet se ha guardado y se puede reintentar.`
                : 'No se ha podido conectar con Gemini (fallo de red). El tiquet se ha guardado y se puede reintentar.',
            causa: error
        });
        e.sinRespuesta = lento;
        return e;
    }

    // Cualquier otra cosa (incluido un JSON que no se puede parsear) es
    // permanente: reintentar daría exactamente el mismo resultado.
    return new ErrorIA({
        tipo: 'permanente',
        status,
        mensaje: status
            ? `La IA devolvió un error ${status} que no se puede reintentar. Revisa el log del servidor.`
            : 'La IA no pudo leer el tiquet y el fallo no es recuperable. Revisa el log del servidor.',
        causa: error
    });
}

// --- REINTENTOS Y CASCADA ----------------------------------------------------
// Dos mecanismos distintos, en dos niveles, y conviene no confundirlos:
//
//   REINTENTO  mismo modelo, otra vez, tras una espera. Solo para transitorios
//              (503/500), que es lo único que el tiempo arregla.
//   SALTO      modelo siguiente de la lista. Para lo que no arregla esperar.
//
// Nunca se reintenta un 429: insistir con la cuota agotada no la recupera y
// además gasta peticiones. Lo que sí puede funcionar es otro modelo, que tiene su
// propia cuota.
const MAX_INTENTOS = 3;
const ESPERAS_MS   = [1000, 2000, 4000]; // espera ANTES del intento 2, 3, 4...

/**
 * Tipos de error ante los que tiene sentido PROBAR OTRO MODELO.
 *
 *   transitorio  ese modelo está saturado; otro puede no estarlo (se salta solo
 *                después de agotar los reintentos: la espera es más barata que
 *                renunciar al modelo preferido).
 *   cuota        la cuota es por modelo y no se renueva en segundos: se salta
 *                INMEDIATAMENTE, sin reintentar.
 *   modelo       ese nombre no existe o no está disponible para la clave.
 *
 * Lo que NO está en esta lista no se salta, y es deliberado:
 *   autenticacion  la clave es la misma para todos: saltar sería repetir el
 *                  mismo fallo N veces y tardar N veces más en decir la verdad.
 *   permanente     volvería a dar lo mismo.
 *   truncado       el problema es la foto (demasiados tiquets), no el modelo.
 *   configuracion  un 400 por GEMINI_MAX_OUTPUT_TOKENS lo has puesto tú y el
 *                  mensaje dice qué bajar; taparlo con el modelo siguiente
 *                  esconde un error de configuración que seguiría ahí.
 */
const TIPOS_QUE_SALTAN = new Set(['transitorio', 'cuota', 'modelo']);

/** ¿Se reintenta el MISMO modelo ante este tipo de error? */
const seReintenta = (tipo) => tipo === 'transitorio';

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function fileToGenerativePart(buffer, mimeType) {
    return {
        inlineData: {
            data: buffer.toString("base64"),
            mimeType
        }
    };
}

// --- ARCHIVOS GRANDES: EN LÍNEA O POR LA FILES API ---------------------------
//
// El original se guarda SIEMPRE tal cual: ni se recomprime ni se redimensiona.
// Eso significa que a la IA puede llegarle un archivo de 40 MB, y una petición
// con los datos incrustados no lo admite:
//
//   · El tope de una petición a Gemini son 20 MB CONTANDO todo lo que va dentro.
//   · Incrustar un archivo lo pasa a base64, que lo infla un 33 % (4 bytes por
//     cada 3). Un archivo de 16 MB ya ocupa 21,3 MB dentro de la petición.
//
// Así que por debajo del umbral se sigue incrustando —una petición y nada que
// limpiar— y por encima se sube por la Files API, se referencia por su URI y se
// BORRA en cuanto termina el análisis, salga bien o mal. Google los guarda 48
// horas por su cuenta y no hay ninguna razón para dejar ahí mis tiquets.

const TOPE_PETICION_BYTES = 20 * 1024 * 1024;

// Lo que ocupan el prompt, el schema y los sobres JSON de la petición. Medio
// mega es holgado a propósito: quedarse corto aquí significa un 400 de Google
// justo con los archivos más grandes, que son los que más cuesta volver a subir.
const MARGEN_PETICION_BYTES = 512 * 1024;

// Bytes de archivo que caben incrustados, ya descontado el inflado del base64.
const TOPE_INCRUSTADO_BYTES = Math.floor((TOPE_PETICION_BYTES - MARGEN_PETICION_BYTES) * 3 / 4);

// Tope por archivo de la Files API de Gemini. No se alcanza con un tiquet ni con
// una factura escaneada, pero si alguna vez se alcanza hay que decirlo con
// palabras en vez de dejar que la API conteste un 400 sin explicación.
const TOPE_FILES_API_BYTES = 2 * 1024 * 1024 * 1024;

const cabeIncrustado = (bytes) => bytes <= TOPE_INCRUSTADO_BYTES;

const enMB = (bytes) => (bytes / (1024 * 1024)).toFixed(1).replace('.', ',');

// Cuánto esperar entre comprobaciones de que el archivo subido ya está listo, y
// cuántas veces. La Files API devuelve PROCESSING hasta que lo ha procesado.
const ESPERA_ARCHIVO_MS = 700;
const MAX_ESPERAS_ARCHIVO = 20;

/** La parte de la petición que referencia un archivo ya subido a Google. */
const partePorUri = (archivo) => ({
    fileData: { fileUri: archivo.uri, mimeType: archivo.mimeType }
});

/**
 * Subir y borrar archivos en Google. Se separa del analizador para poder
 * inyectar un SDK de pega en las pruebas: el camino que importa —subir,
 * referenciar y BORRAR también cuando el análisis falla— no se puede comprobar
 * contra la API de verdad sin dejar archivos en una cuenta real.
 */
function crearGestorDeArchivos({ sdk = ai, dormir = esperar } = {}) {
    return {
        /** Sube el archivo y espera a que Google lo tenga listo. */
        async subir(buffer, mimeType, nombre = 'documento') {
            let archivo = await sdk.files.upload({
                file: new Blob([buffer], { type: mimeType }),
                config: { mimeType, displayName: nombre }
            });

            for (let n = 0; archivo && archivo.state === 'PROCESSING' && n < MAX_ESPERAS_ARCHIVO; n += 1) {
                await dormir(ESPERA_ARCHIVO_MS);
                archivo = await sdk.files.get({ name: archivo.name });
            }

            if (!archivo || !archivo.uri) {
                throw new ErrorIA({
                    tipo: 'transitorio',
                    status: null,
                    mensaje: 'Google ha aceptado el archivo pero no ha devuelto su referencia. ' +
                             'El archivo se ha guardado aquí; reintenta la extracción.'
                });
            }
            if (archivo.state && archivo.state !== 'ACTIVE') {
                throw new ErrorIA({
                    tipo: 'transitorio',
                    status: null,
                    mensaje: `Google no ha terminado de procesar el archivo (estado ${archivo.state}). ` +
                             'El archivo se ha guardado aquí; reintenta la extracción.'
                });
            }
            return archivo;
        },

        /** Lo borra de Google. Quien llama decide qué hacer si falla. */
        async borrar(nombre) {
            await sdk.files.delete({ name: nombre });
        }
    };
}

// --- PRESUPUESTO DE TOKENS DE SALIDA ----------------------------------------
// Estaba en 8192, que era suficiente para un tiquet pero no para varios: el
// presupuesto se COMPARTE con los tokens de razonamiento del modelo, así que
// cinco tiquets de súper con sus líneas de producto lo desbordan y la respuesta
// llega cortada a media palabra.
//
// 65536 es el techo de salida de las familias Gemini 2.5 y posteriores. Este
// valor se manda en TODAS las llamadas, así que el que vale es el techo del más
// justo de los modelos de GEMINI_MODELOS. Si alguno admite menos, la API da 400 y
// clasificarError lo explica: entonces se baja con GEMINI_MAX_OUTPUT_TOKENS, que
// existe precisamente para no tener que tocar código.
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 65536;

// finishReason distinto de STOP significa que el modelo no terminó de hablar.
// MAX_TOKENS es el caso que nos importa (demasiados tiquets en la foto); el
// resto se recogen con un mensaje genérico pero igual de explícito.
const MOTIVOS_DE_CORTE = {
    MAX_TOKENS: 'La respuesta se ha cortado por falta de espacio: había demasiados ' +
                'tiquets (o demasiadas líneas de producto) en una sola foto. ' +
                'Sepárala en varias fotos con menos tiquets cada una y vuelve a subirlas.',
    SAFETY:     'Google ha bloqueado la respuesta por sus filtros de contenido. ' +
                'Revisa que la foto sea de tiquets.',
    RECITATION: 'Google ha bloqueado la respuesta por posible recitación de material ' +
                'protegido. Prueba con otra foto.',
    PROHIBITED_CONTENT: 'Google ha bloqueado la respuesta por contenido prohibido.',
    BLOCKLIST:  'Google ha bloqueado la respuesta por su lista de bloqueo.'
};

/**
 * Comprueba que la respuesta esté COMPLETA antes de intentar parsearla.
 *
 * Con responseSchema el texto es JSON válido solo si el modelo llegó al final.
 * Si se corta a mitad, `response.text` es un JSON truncado: JSON.parse lanzaría y
 * acabaría clasificado como 'permanente' con un mensaje inútil ("no se pudo
 * leer"). Peor aún sería un parseo "a medias" que guardase tres de los cinco
 * tiquets sin avisar. Así que se detecta aquí y se lanza un error que dice
 * exactamente qué ha pasado y qué hacer.
 */
function comprobarRespuestaCompleta(response) {
    const bloqueo = response?.promptFeedback?.blockReason;
    if (bloqueo) {
        throw new ErrorIA({
            tipo: 'truncado',
            status: null,
            mensaje: MOTIVOS_DE_CORTE[bloqueo] ||
                     `Google ha bloqueado la petición (${bloqueo}). La imagen se ha guardado.`
        });
    }

    const candidato = response?.candidates?.[0];
    const motivo = candidato?.finishReason;

    // Sin finishReason no podemos afirmar que esté cortada: algunos caminos del
    // SDK no lo rellenan. Se deja pasar y, si el JSON está roto, el parseo lo
    // recogerá como permanente.
    if (!motivo || motivo === 'STOP') return;

    throw new ErrorIA({
        tipo: 'truncado',
        status: null,
        mensaje: MOTIVOS_DE_CORTE[motivo] ||
                 `La IA no terminó de responder (finishReason=${motivo}), así que la ` +
                 `respuesta está incompleta y no se parsea a medias. La imagen se ha guardado.`
    });
}

// Lo que se añade al prompt en la segunda lectura.
const PISTA_VARIOS = `

REVISIÓN: en una primera lectura de esta misma imagen devolviste UN solo
documento, pero su caja ocupa solo una parte de la foto. Vuelve a mirar la
imagen ENTERA. Si hay varios papeles separados, aunque sean del mismo
establecimiento y se parezcan mucho, cada papel es un documento distinto con su
propio total y su propia caja. Si de verdad solo hay uno, devuelve uno.`;

/**
 * ¿Un único documento cuya caja deja fuera buena parte de la foto? Es la forma
 * de una lectura que se ha quedado con uno de varios tiquets iguales. Un papel
 * solo, fotografiado de cerca, ocupa casi toda la imagen.
 */
function pareceQueFaltanDocumentos(tiquets) {
    if (!Array.isArray(tiquets) || tiquets.length !== 1) return false;
    const caja = tiquets[0] && (tiquets[0].box_2d || tiquets[0].recuadro);
    if (!Array.isArray(caja) || caja.length !== 4 || !caja.every(Number.isFinite)) return false;
    const [ymin, xmin, ymax, xmax] = caja;
    const area = Math.max(0, ymax - ymin) * Math.max(0, xmax - xmin) / 1e6;
    return area > 0 && area < 0.4;
}

/** Una sola petición a Gemini con un modelo concreto. */
async function generarConGemini(modelo, imagePart, extra = '') {
    return ai.models.generateContent({
        model: modelo,
        contents: [imagePart, { text: PROMPT + extra }],
        config: {
            temperature: 0.0,
            topP: 1.0,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            responseMimeType: "application/json",
            responseSchema: responseSchema
        }
    });
}

/** Resumen de un intento fallido, para el mensaje final y el log. */
const resumirIntento = (i) =>
    `${i.modelo} (${i.tipo}${i.status ? ` ${i.status}` : ''})`;

/**
 * Construye el analizador. La fábrica existe para poder inyectar el generador y
 * las esperas desde las pruebas: la cascada es lógica de decisión —cuándo
 * reintentar, cuándo saltar, qué error propagar— y comprobarla llamando a la API
 * de verdad exigiría provocar un 429 real de Google.
 *
 * @param {Function} generar  (modelo, imagePart) => respuesta del SDK
 * @param {Array}    modelos  lista ordenada por defecto
 * @param {Function} dormir   espera entre reintentos (ms)
 */
function crearAnalizador({
    generar = generarConGemini,
    modelos = MODELOS,
    dormir = esperar,
    archivos = null
} = {}) {
    // El gestor se crea aquí para que comparta la espera inyectada: las pruebas
    // no esperan de verdad a que Google procese nada.
    const gestorDeArchivos = archivos || crearGestorDeArchivos({ dormir });

    /**
     * Analiza una imagen con el primer modelo que consiga responder.
     *
     * Devuelve `{ tiquets, modelo, intentos }`:
     *   tiquets  SIEMPRE un ARRAY, uno por documento distinto que haya en la foto.
     *            Una foto de un solo tiquet devuelve un array de longitud 1: no
     *            hay dos formatos de salida. Formato de cada elemento: ver
     *            tiquetSchema arriba; items y detalles vienen como ARRAYS y el
     *            controller aplana detalles a {clave: valor}.
     *   modelo   el que de verdad leyó la foto. Se guarda en la fila
     *            (modelo_usado) para poder comparar calidad entre modelos.
     *   intentos los fallos por el camino, para el log.
     *
     * Ante un fallo lanza SIEMPRE un ErrorIA ya clasificado (.tipo/.status/
     * .mensaje), nunca un Error genérico: el controller decide con eso si
     * conserva la imagen y con qué estado. Si se agotan todos los modelos se
     * propaga el error del ÚLTIMO intento —es el más reciente y el que describe
     * el estado actual del servicio— con el recorrido completo añadido al
     * mensaje, para que no haya que leer el log del servidor para saber qué se
     * ha probado.
     */
    return async function analizarTicket(imageBuffer, mimeType, { modo = MODO_AUTOMATICO, nombre } = {}) {
        const candidatos = resolverModelos(modo, modelos);

        if (candidatos.length === 0) {
            throw new ErrorIA({
                tipo: 'configuracion',
                status: null,
                mensaje: 'No hay ningún modelo de IA configurado. Define GEMINI_MODELOS en el ' +
                         '.env con una lista de modelos separados por comas, del preferido al ' +
                         'de respaldo (src/check_models.js lista los disponibles). La imagen ' +
                         'se ha guardado.'
            });
        }

        const bytes = imageBuffer.length;
        if (bytes > TOPE_FILES_API_BYTES) {
            throw new ErrorIA({
                tipo: 'demasiado_grande',
                status: null,
                mensaje: `El archivo mide ${enMB(bytes)} MB y Gemini no admite más de ` +
                         `${enMB(TOPE_FILES_API_BYTES)} MB por archivo. Se ha guardado aquí tal ` +
                         `cual, sin tocarlo; para extraer los datos hará falta una versión más ` +
                         `pequeña o separarlo en varios archivos.`
            });
        }

        // Por debajo del umbral, incrustado: una petición y nada que limpiar.
        // Por encima, a la Files API —y entonces hay un archivo en Google que hay
        // que borrar al acabar, pase lo que pase.
        let subido = null;
        let imagePart;

        if (cabeIncrustado(bytes)) {
            imagePart = fileToGenerativePart(imageBuffer, mimeType);
        } else {
            console.log(
                `📤 ${enMB(bytes)} MB no caben incrustados (tope ${enMB(TOPE_INCRUSTADO_BYTES)} MB ` +
                `por el inflado del base64): va por la Files API de Gemini.`
            );
            subido = await gestorDeArchivos.subir(imageBuffer, mimeType, nombre || 'documento');
            imagePart = partePorUri(subido);
        }

        try {
            const resultado = await analizarConCascada(candidatos, imagePart);
            // Red de seguridad para fotos con varios tiquets parecidos (tres del
            // mismo súper juntos): a veces la primera lectura devuelve UNO solo.
            // Si ese uno ocupa solo una parte de la foto, se pregunta otra vez
            // avisando, y se queda la lectura que encuentre más documentos.
            if (pareceQueFaltanDocumentos(resultado.tiquets)) {
                console.warn('🔁 Un solo tiquet que ocupa poco de la foto: se vuelve a leer por si hay más.');
                try {
                    const segunda = await analizarConCascada(candidatos, imagePart, PISTA_VARIOS);
                    if (Array.isArray(segunda.tiquets) && segunda.tiquets.length > 1) {
                        console.log(`✨ La segunda lectura encuentra ${segunda.tiquets.length} tiquets.`);
                        return { ...segunda, intentos: [...resultado.intentos, ...segunda.intentos] };
                    }
                } catch (error) {
                    console.warn(`La segunda lectura ha fallado (${error.message}); se queda la primera.`);
                }
            }
            return resultado;
        } finally {
            // El borrado va en el finally y NUNCA rompe la subida: si Google no
            // deja borrar, lo que no puede pasar es que además se pierda el
            // tiquet que ya está guardado aquí.
            if (subido) {
                try {
                    await gestorDeArchivos.borrar(subido.name);
                    console.log(`🧹 Borrado de Google el archivo temporal ${subido.name}.`);
                } catch (error) {
                    console.error(
                        `⚠️  No se ha podido borrar de Google el archivo temporal ${subido.name}: ` +
                        `${error && error.message}. Google lo borrará solo en 48 h.`
                    );
                }
            }
        }
    };

    /** La cascada de modelos sobre una parte ya preparada (incrustada o por URI). */
    async function analizarConCascada(candidatos, imagePart, extra = '') {
        const intentos = [];        // {modelo, tipo, status, mensaje}
        let ultimo = null;          // último ErrorIA, el que se propagará

        for (let m = 0; m < candidatos.length; m++) {
            const modelo = candidatos[m];
            const siguiente = candidatos[m + 1] || null;

            for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
                try {
                    const response = extra
                        ? await generar(modelo, imagePart, extra)
                        : await generar(modelo, imagePart);

                    // Antes de parsear: ¿ha terminado de hablar? Un JSON cortado a
                    // mitad no se parsea "lo que se pueda".
                    comprobarRespuestaCompleta(response);

                    // Con responseSchema el SDK garantiza JSON válido en
                    // response.text. Si aun así no parsea, clasificarError lo
                    // marcará como permanente.
                    const tiquets = JSON.parse(response.text);

                    if (intentos.length > 0) {
                        console.log(
                            `✅ Resuelto con '${modelo}' tras ${intentos.length} intento(s) ` +
                            `fallido(s): ${intentos.map(resumirIntento).join(', ')}.`
                        );
                    }
                    return { tiquets, modelo, intentos };

                } catch (error) {
                    const clasificado = clasificarError(error, modelo);
                    ultimo = clasificado;
                    intentos.push({
                        modelo,
                        tipo: clasificado.tipo,
                        status: clasificado.status,
                        mensaje: clasificado.mensaje,
                        // La causa original, para que el error que se propague al
                        // final pueda llevarla aunque no sea el último intento.
                        causa: clasificado.causa || null
                    });

                    // Log completo del error ORIGINAL, no solo del mensaje bonito.
                    console.error(
                        `❌ Error en el servicio de IA [modelo=${modelo} tipo=${clasificado.tipo} ` +
                        `status=${clasificado.status} intento=${intento}/${MAX_INTENTOS}]:`,
                        clasificado.causa || clasificado
                    );

                    // 1) ¿Lo arregla esperar? Mismo modelo, otra vez.
                    if (seReintenta(clasificado.tipo) && intento < MAX_INTENTOS && !clasificado.sinRespuesta) {
                        const espera = ESPERAS_MS[intento - 1];
                        console.warn(`⏳ Reintentando con '${modelo}' en ${espera / 1000}s...`);
                        await dormir(espera);
                        continue;
                    }

                    // 2) ¿Lo puede arreglar otro modelo? Se abandona este.
                    // Se rompe el bucle de reintentos incluso si no queda ningún
                    // modelo más: entonces el bucle exterior termina y el error se
                    // propaga ahí abajo, con el recorrido completo y un solo log
                    // de cierre.
                    if (TIPOS_QUE_SALTAN.has(clasificado.tipo)) {
                        if (siguiente) {
                            const porQue = clasificado.sinRespuesta
                                ? 'no ha respondido a tiempo; esperar volvería a tardar lo mismo'
                                : clasificado.tipo === 'transitorio'
                                ? `agotados los ${MAX_INTENTOS} reintentos`
                                : (clasificado.tipo === 'cuota'
                                    ? 'cuota agotada, no se reintenta (no se renueva en segundos)'
                                    : 'ese modelo no existe o no está disponible para la clave');
                            console.warn(
                                `🔀 Cambio de modelo: '${modelo}' → '${siguiente}' ` +
                                `(${clasificado.tipo}${clasificado.status ? ` ${clasificado.status}` : ''}: ${porQue}).`
                            );
                        }
                        break;
                    }

                    // 3) Ni esperar ni cambiar de modelo sirven de nada.
                    if (siguiente) {
                        console.warn(
                            `⛔ No se prueban los ${candidatos.length - m - 1} modelo(s) que quedan: ` +
                            `un error de tipo '${clasificado.tipo}' no es culpa del modelo y daría ` +
                            `el mismo resultado con el resto.`
                        );
                    }
                    throw conRecorrido(clasificado, intentos);
                }
            }
        }

        // Se han agotado todos los candidatos saltando de uno a otro.
        console.error(
            `⛔ Agotados los ${candidatos.length} modelos configurados: ` +
            `${intentos.map(resumirIntento).join(', ')}.`
        );
        throw errorPredominante(intentos, ultimo);
    }
}

// Con qué tipo se queda la fila cuando hay empate EN NÚMERO DE MODELOS. Lo que decide el orden es
// qué hace el controller con cada uno: 'transitorio' y 'cuota' CONSERVAN la foto
// en 'pendiente' y se pueden reintentar; 'modelo' y 'autenticacion' la dejan en
// 'error' esperando que alguien toque la configuración. Ante la duda, lo
// reintentable: una foto marcada como error que en realidad solo pilló la API
// saturada no se reintenta nunca sola.
const PRIORIDAD_DE_TIPO = ['transitorio', 'cuota', 'truncado', 'autenticacion', 'configuracion', 'modelo', 'permanente'];

/**
 * El error que se propaga cuando se agotan todos los modelos: el de la causa
 * PREDOMINANTE, no el del último intento.
 *
 * El caso que lo motivó: tres modelos devolviendo 503 (nueve intentos) y un
 * cuarto con 404. El último intento era el 404, así que la fila se guardaba como
 * 'error' de configuración —no reintentable— cuando lo que pasaba era que Google
 * estaba saturado y bastaba con volver a intentarlo. Ahora manda el tipo con más
 * intentos detrás, y el 404 se cuenta aparte como lo que es: un aviso de que un
 * modelo de la lista no sirve.
 */
function errorPredominante(intentos, ultimo) {
    if (!intentos.length) return ultimo;

    const porTipo = new Map();
    for (const i of intentos) {
        if (!porTipo.has(i.tipo)) porTipo.set(i.tipo, []);
        porTipo.get(i.tipo).push(i);
    }

    // Se cuentan MODELOS distintos, no intentos: un 503 se reintenta tres veces
    // y un 404 ninguna, así que contar intentos haría ganar siempre al 503 por
    // el simple hecho de ser reintentable.
    const modelosDe = (lista) => new Set(lista.map(i => i.modelo)).size;

    const mandan = [...porTipo.entries()].sort((a, b) =>
        (modelosDe(b[1]) - modelosDe(a[1])) ||
        (PRIORIDAD_DE_TIPO.indexOf(a[0]) - PRIORIDAD_DE_TIPO.indexOf(b[0]))
    );
    const [tipo, suyos] = mandan[0];
    const base = suyos[suyos.length - 1];

    // Los modelos que no existen para esta clave: se dicen aparte, porque hay
    // que arreglarlos aunque la causa principal sea otra.
    const inexistentes = [...new Set((porTipo.get('modelo') || []).map(i => i.modelo))];
    const avisoModelo = (tipo !== 'modelo' && inexistentes.length)
        ? ` Además, ${inexistentes.length === 1 ? 'el modelo' : 'los modelos'} ` +
          `${inexistentes.map(m => `"${m}"`).join(', ')} no ` +
          `${inexistentes.length === 1 ? 'está' : 'están'} disponible${inexistentes.length === 1 ? '' : 's'} ` +
          `para tu clave: quítalo${inexistentes.length === 1 ? '' : 's'} de GEMINI_MODELOS o la cascada ` +
          `perderá un intento en cada foto.`
        : '';

    const error = new ErrorIA({
        tipo,
        status: base.status,
        causa: base.causa || null,
        mensaje: base.mensaje + avisoModelo
    });
    return conRecorrido(error, intentos);
}

/**
 * Añade al mensaje qué modelos se probaron y por qué falló cada uno.
 *
 * Se devuelve un ErrorIA NUEVO con el mismo tipo, status y causa que el último:
 * el controller sigue decidiendo con `.tipo` exactamente igual que antes. Solo se
 * enriquece el texto, y solo si hubo más de un modelo en juego: con un único
 * modelo configurado el mensaje de siempre ya lo dice todo y añadirle un
 * "se ha probado: X" sería ruido.
 */
function conRecorrido(error, intentos) {
    const modelos = [...new Set(intentos.map(i => i.modelo))];
    if (!error || modelos.length < 2) return error;

    // Un resumen por MODELO, no por intento: tres reintentos del mismo 503 son
    // una sola cosa que contar.
    const porModelo = modelos.map((modelo) => {
        const suyos = intentos.filter(i => i.modelo === modelo);
        const ultimo = suyos[suyos.length - 1];
        const veces = suyos.length > 1 ? ` ×${suyos.length}` : '';
        return `${modelo}: ${ultimo.tipo}${ultimo.status ? ` ${ultimo.status}` : ''}${veces}`;
    });

    return new ErrorIA({
        tipo: error.tipo,
        status: error.status,
        causa: error.causa,
        mensaje: `${error.mensaje} Se han probado ${modelos.length} modelos sin conseguirlo ` +
                 `(${porModelo.join('; ')}).`
    });
}

const analizarTicket = crearAnalizador();

// --- CLASIFICAR COMERCIOS DEL BANCO ---------------------------------------------
// Solo texto (el nombre que sale en el extracto), sin imágenes: barato y rápido.
// Se manda en lotes y se prueba la lista de modelos en orden hasta que uno
// responda.

const CATEGORIAS_BANCO = ['ALIMENTACION', 'RESTAURACION', 'TRANSPORTE', 'OCIO', 'ROPA', 'HOGAR',
                          'ELECTRONICA', 'SALUD', 'SUSCRIPCIONES', 'OTROS'];

async function clasificarComercios(lista) {
    if (!lista.length) return [];
    const texto = `Clasifica cada comercio de un extracto bancario español. Los nombres vienen
recortados y en mayúsculas como los escribe el banco ("CARREF MANRESA", "INDIGO S. JOAN").
Categorías posibles: ${CATEGORIAS_BANCO.join(', ')}.
- SUSCRIPCIONES: servicios digitales y cuotas que se pagan cada mes o cada año (streaming,
  música, nube, software, IA, gimnasio, telefonía, prensa).
- TRANSPORTE: parkings, gasolineras, peajes, tren, bus, taxi, VTC, vuelos, alquiler de coches.
- RESTAURACION: bares, cafeterías, restaurantes, heladerías, comida a domicilio.
- ALIMENTACION: supermercados y tiendas de comida.
- OCIO: cine, conciertos, juegos, libros, viajes y hoteles, museos, deporte puntual.
- Si no lo sabes con razonable seguridad, OTROS.
Devuelve una entrada por comercio con su índice.

${lista.map((c, i) => `${i}. ${c.comercio}${c.poblacion ? ` (${c.poblacion})` : ''}`).join('\n')}`;

    const esquema = {
        type: 'array',
        items: {
            type: 'object',
            properties: {
                i: { type: 'integer' },
                categoria: { type: 'string', enum: CATEGORIAS_BANCO }
            },
            required: ['i', 'categoria']
        }
    };
    let ultimo = null;
    for (const modelo of MODELOS) {
        try {
            const r = await ai.models.generateContent({
                model: modelo,
                contents: [{ text: texto }],
                config: { temperature: 0, responseMimeType: 'application/json', responseSchema: esquema }
            });
            return JSON.parse(r.text).filter(x => Number.isInteger(x.i) && CATEGORIAS_BANCO.includes(x.categoria));
        } catch (err) {
            ultimo = err;
        }
    }
    throw ultimo || new Error('No hay modelos configurados.');
}

/**
 * El nombre de verdad de cada comercio del banco ("MCDONALDS 1234" → MCDONALD'S,
 * "ETSYIRELAND" → ETSY) y si es tienda online, cadena o negocio local. Si
 * coincide con uno de mis establecimientos, con ese nombre exacto.
 */
async function identificarComercios(lista, conocidos = []) {
    if (!lista.length) return [];
    const texto = `Para cada comercio de un extracto bancario español, dime su nombre real.
Los nombres vienen recortados y en mayúsculas como los escribe el banco, a veces con
números de tienda, sufijos de país o de empresa, o el prefijo de una pasarela de pago
("MCDONALDS 0456", "ETSYIRELAND", "AMZN MKTP ES", "PAYPAL *STEAM", "SUMUP *BAR PEPE").
- nombre: el nombre comercial, en MAYÚSCULAS, sin números de tienda, sin país, sin
  "SL"/"SA", sin la pasarela (PAYPAL *STEAM → STEAM). Si es una marca o cadena
  conocida, su nombre habitual (MCDONALD'S, ETSY, AMAZON, MERCADONA).
- Si es el mismo comercio que uno de MIS ESTABLECIMIENTOS, usa EXACTAMENTE ese nombre.
- tipo: "online" si se compra por internet y no hay tienda física a la que fui
  (Etsy, Amazon, Steam, Netflix, Aliexpress…); "cadena" si es una marca con muchas
  tiendas físicas; "local" si es un negocio de un sitio concreto.
- reconocido: true si sabes qué comercio es; false si solo has limpiado el nombre.
  No inventes: si no lo reconoces, devuelve el nombre limpio tal cual.
Devuelve una entrada por comercio con su índice.

MIS ESTABLECIMIENTOS:
${conocidos.join(' | ') || '(ninguno)'}

COMERCIOS:
${lista.map((c, i) => `${i}. ${c.comercio}${c.poblacion ? ` (${c.poblacion})` : ''}`).join('\n')}`;

    const esquema = {
        type: 'array',
        items: {
            type: 'object',
            properties: {
                i: { type: 'integer' },
                nombre: { type: 'string' },
                tipo: { type: 'string', enum: ['online', 'cadena', 'local'] },
                reconocido: { type: 'boolean' }
            },
            required: ['i', 'nombre', 'tipo', 'reconocido']
        }
    };
    let ultimo = null;
    for (const modelo of MODELOS) {
        try {
            const r = await ai.models.generateContent({
                model: modelo,
                contents: [{ text: texto }],
                config: { temperature: 0, responseMimeType: 'application/json', responseSchema: esquema }
            });
            return JSON.parse(r.text).filter(x => Number.isInteger(x.i) && typeof x.nombre === 'string' &&
                x.nombre.trim() && ['online', 'cadena', 'local'].includes(x.tipo));
        } catch (err) {
            ultimo = err;
        }
    }
    throw ultimo || new Error('No hay modelos configurados.');
}

module.exports = {
    analizarTicket,
    clasificarComercios,
    identificarComercios,
    CATEGORIAS_BANCO,
    ErrorIA,
    // Lista de modelos y modos: los usa el controller para validar el parámetro
    // y app.js para publicar el selector del frontend.
    MODELOS,
    MODOS,
    MODO_AUTOMATICO,
    MODO_MEJOR,
    MODO_RAPIDO,
    resolverModelos,
    configuracionPublica,
    // Expuestos para las pruebas: la detección de truncación y la cascada son
    // justo las partes que no se pueden verificar llamando a la API de verdad.
    comprobarRespuestaCompleta,
    crearAnalizador,
    crearGestorDeArchivos,
    errorPredominante,
    clasificarError,
    leerModelos,
    MAX_INTENTOS,
    MAX_OUTPUT_TOKENS,
    // Los topes de tamaño: el controller no los usa, pero las pruebas sí y
    // documentan por qué el umbral no son los 20 MB a secas.
    TOPE_INCRUSTADO_BYTES,
    TOPE_FILES_API_BYTES
};
