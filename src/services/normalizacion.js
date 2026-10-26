/**
 * Validación y normalización de lo que devuelve la IA, ANTES de guardar.
 *
 * Por qué existe este módulo: el responseSchema de Gemini valida la ESTRUCTURA
 * (que metodo_pago sea un string) pero no el CONTENIDO (que ese string sea
 * "TARJETA ****6158" y no el razonamiento del modelo metido dentro del campo).
 * Se han guardado valores reales como:
 *
 *   "TARJETA ****6158 Quentin/anon format: TARJETA ****6158 -> TARJETA ****6158"
 *   "TARJETA ****6158 Quentin/6158 -> TARJETA ****6158 (wait, let me fix ... )"
 *
 * Esto es la garantía en código. El prompt y el schema son solo una sugerencia:
 * reducen la probabilidad, no la eliminan.
 *
 * Todo lo de aquí es PURO: no toca disco, ni base de datos, ni red. Así se puede
 * probar sin arrancar SQLite ni el cliente de Gemini (ver tests/).
 */

// --- LÍMITES DE LONGITUD -----------------------------------------------------
// Un valor razonable para cada campo. No son límites de la base (TEXT no tiene
// límite): son el detector de que el modelo se ha ido por las ramas. Un método
// de pago de 260 caracteres no es un método de pago.
const LIMITES_TEXTO = {
    tipo_documento:         40,
    categoria:              30,
    nombre_establecimiento: 100,
    direccion:              120,
    ciudad:                 60,
    codigo_postal:          12,
    lugar_inferido:         80,   // "PARQUE NACIONAL DE ORDESA Y MONTE PERDIDO" = 41
    fecha_compra:           30,   // "2026-01-14T18:05:09.123+01:00" = 29
    fecha_evento:           30,
    moneda:                 3,    // ISO 4217, exactamente 3 letras
    metodo_pago:            40    // "TARJETA ****1234" = 16; 40 va de sobra
};

// Dos numeros con decimales separados por coma, punto y coma o espacio: eso no
// es un nombre de lugar, son coordenadas.
const PARECE_COORDENADAS = /^-?\d{1,3}[.,]\d+\s*[,;\s]\s*-?\d{1,3}[.,]\d+$/;

// items[].producto
const LIMITE_PRODUCTO   = 120;
const MAX_ITEMS         = 200;

// detalles: clave corta (es un nombre de campo), valor razonable.
const LIMITE_CLAVE_DETALLE = 40;
const LIMITE_VALOR_DETALLE = 200;
const MAX_PARES_DETALLES   = 30;

// Tope de plausibilidad para el importe: 1.000.000 € en céntimos. Por encima de
// eso no es un tiquet, es un error de lectura (o un punto decimal mal puesto).
const MAX_CENTIMOS = 100_000_000;

// Campos que definen el estado de la fila. Si se descarta uno de estos, la fila
// queda 'incompleto' y hay que revisarla a mano. Los demás son secundarios: se
// dejan a NULL y la fila sigue siendo 'procesado'.
const CAMPOS_ESTADO = new Set(['fecha_compra', 'total_centimos']);

// --- MARCADORES DE RAZONAMIENTO DEL MODELO -----------------------------------
// Señales de que el contenido del campo no es un valor extraído, sino el modelo
// pensando en voz alta. Cada uno lleva nombre para que el log diga qué saltó.
//
// Deliberadamente NO se detecta el apóstrofo suelto: "L'ILLA DIAGONAL" y
// "O'DONNELL" son nombres de establecimiento legítimos. Sí se detecta la comilla
// doble, que no tiene ningún motivo para aparecer en estos campos.
const MARCADORES = [
    { nombre: 'flecha',                      re: /->|=>|<-|→/ },
    { nombre: 'salto de línea',              re: /[\r\n]/ },
    { nombre: 'comilla de cita',             re: /["“”`]/ },
    { nombre: 'puntos suspensivos',          re: /\.\.\.|…/ },
    { nombre: '"wait"',                      re: /\bwait\b/i },
    { nombre: '"let me" / "let\'s"',         re: /\blet\s+me\b|\blet'?s\b/i },
    { nombre: '"instructions"',              re: /\binstructions?\b/i },
    { nombre: 'autorreferencia del modelo',  re: /\b(as an ai|i should|i need to|i must|i will|my response)\b/i },
    { nombre: '"json"',                      re: /\bjson\b/i },
    { nombre: '"format:"',                   re: /\bformat\s*:/i },
    { nombre: 'valla de código',             re: /```/ }
];

/** Recorta el valor para el log: queremos verlo, no inundar la consola. */
function recortar(valor, max = 90) {
    const s = String(valor);
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Valida un campo de texto libre.
 * Devuelve { ok: true, valor } con el valor ya trimmed (null si venía vacío),
 * o { ok: false, motivo, valor } si hay que descartarlo.
 *
 * Un campo ausente NO es un descarte: el documento simplemente no lo traía.
 */
function validarTexto(valor, limite) {
    if (valor === null || valor === undefined) return { ok: true, valor: null };

    if (typeof valor !== 'string') {
        return { ok: false, motivo: `tipo ${typeof valor} en lugar de texto`, valor };
    }

    const limpio = valor.trim();
    if (limpio === '') return { ok: true, valor: null };

    if (limpio.length > limite) {
        return { ok: false, motivo: `longitud ${limpio.length} > ${limite}`, valor: limpio };
    }

    const marcador = MARCADORES.find(m => m.re.test(limpio));
    if (marcador) {
        return {
            ok: false,
            motivo: `razonamiento del modelo (${marcador.nombre})`,
            valor: limpio
        };
    }

    return { ok: true, valor: limpio };
}

// --- IMPORTES ----------------------------------------------------------------

/**
 * Convierte el total devuelto por la IA a céntimos enteros.
 * Acepta number (1234, 1234.4) y string numérico ("1234", " 1234 "), porque el
 * modelo a veces devuelve el entero entre comillas aunque el schema pida INTEGER.
 *
 * Devuelve null cuando no hay nada interpretable. IMPORTANTE: null y 0 son cosas
 * distintas y lo siguen siendo en toda la cadena.
 *   null = el documento NO muestra ningún importe (entrada de parking que se
 *          paga a la salida, albarán, justificante).
 *   0    = el documento imprime explícitamente un importe de cero (entrada
 *          gratuita, invitación). Es un dato, no un hueco.
 * Por eso aquí NO se inventa un 0: sería indistinguible de un tiquet legítimo
 * de importe cero, y generaría clave de dedupe a partir de un dato inexistente.
 */
function parsearCentimos(valor) {
    if (typeof valor === 'number') {
        return Number.isFinite(valor) ? Math.round(valor) : null;
    }
    if (typeof valor === 'string') {
        const limpio = valor.trim();
        if (limpio === '') return null;
        const n = Number(limpio);
        return Number.isFinite(n) ? Math.round(n) : null;
    }
    return null;
}

/**
 * Valida el total. Un ausente (null) es legítimo y NO cuenta como descarte,
 * aunque sí dejará la fila incompleta. Un negativo o un importe absurdo sí es
 * un descarte: el modelo ha leído mal.
 */
function validarTotal(valor) {
    const n = parsearCentimos(valor);
    if (n === null) return { ok: true, valor: null };

    if (n < 0) {
        return { ok: false, motivo: `importe negativo (${n})`, valor };
    }
    if (n > MAX_CENTIMOS) {
        return { ok: false, motivo: `importe fuera de rango (${n} > ${MAX_CENTIMOS})`, valor };
    }
    return { ok: true, valor: n };
}

// --- FECHAS ------------------------------------------------------------------

// Fecha ISO: día obligatorio, hora opcional. No anclamos el final a propósito,
// así los milisegundos y el offset de zona se descartan solos.
const RE_FECHA_ISO = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/**
 * Canoniza una fecha a UN solo formato antes de que entre en la clave de dedupe:
 * "YYYY-MM-DD" cuando no hay hora, "YYYY-MM-DD HH:MM:SS" cuando la hay.
 *
 * Al prompt se le pide "ISO 8601", que admite varias formas para el mismo
 * instante. Sin canonizar, la misma compra fotografiada dos veces puede producir
 * dos claves distintas y no detectarse como duplicado.
 *
 * Casos cubiertos:
 *   "2026-01-14"                 -> "2026-01-14"            (solo fecha)
 *   "2026-01-14 18:05:09"        -> "2026-01-14 18:05:09"   (ya canónica)
 *   "2026-01-14T18:05:09"        -> "2026-01-14 18:05:09"   (separador T -> espacio)
 *   "2026-01-14T18:05"           -> "2026-01-14 18:05:00"   (segundos ausentes -> 00)
 *   "2026-01-14T18:05:09.123Z"   -> "2026-01-14 18:05:09"   (se descartan ms y zona)
 *   "2026-01-14T18:05:09+01:00"  -> "2026-01-14 18:05:09"   (se descarta el offset:
 *                                   el tiquet ya está en hora local del local)
 *   "  2026-01-14  "             -> "2026-01-14"            (espacios alrededor)
 *
 * Cualquier otra cosa (null, "", "14/01/2026", "enero 2026") -> null. Preferimos
 * quedarnos sin clave a construir una clave a partir de basura.
 */
function canonizarFecha(valor) {
    if (typeof valor !== 'string') return null;
    const m = RE_FECHA_ISO.exec(valor.trim());
    if (!m) return null;

    const [, dia, hh, mm, ss] = m;
    if (!hh) return dia;                       // solo la parte de fecha
    return `${dia} ${hh}:${mm}:${ss || '00'}`; // fecha + hora completa
}

// --- DEDUPE ------------------------------------------------------------------

/**
 * Construye la clave semántica de deduplicación.
 * Formato: `${establecimiento_id}|${fecha}|${total_centimos}`.
 * La parte de fecha lleva hora si hora_conocida=1, si no solo la parte YYYY-MM-DD.
 *
 * Devuelve null si falta fecha o falta total: con un hueco en la clave no se
 * puede decidir si dos tiquets son el mismo, y un marcador de relleno haría
 * colisionar entre sí a todos los tiquets incompletos del mismo establecimiento.
 * Una clave null queda fuera de la comparación de duplicados y, por el WHERE del
 * índice único parcial, tampoco puede violarlo.
 *
 * total_centimos = 0 SÍ genera clave (es un importe leído del documento);
 * total_centimos = null NO (no hay importe que comparar). Por eso la
 * comprobación es Number.isInteger y no un `!totalCentimos`, que trataría el 0
 * como ausente.
 */
function construirClaveTiquet(establecimientoId, fechaCanonica, horaConocida, totalCentimos) {
    if (!fechaCanonica || !Number.isInteger(totalCentimos)) return null;

    const fechaNorm = horaConocida
        ? fechaCanonica.slice(0, 19)
        : fechaCanonica.slice(0, 10);
    return `${establecimientoId}|${fechaNorm}|${totalCentimos}`;
}

/**
 * Estado de la fila a partir de los datos ya validados.
 *
 * CRITERIO ACTUAL: **un importe ausente NO deja la fila incompleta.** Hay
 * demasiados documentos que legítimamente no imprimen importe —la ENTRADA de un
 * parking, una tarjeta de embarque, una entrada con el precio en otro sitio— y
 * tratarlos como "falta algo" dejaba un tercio del historial en ámbar
 * permanente, con lo que el ámbar dejaba de avisar de nada. La fila queda
 * 'procesado' y la ausencia se registra en `sin_importe`, que es el dato que de
 * verdad hace falta: al sumar vale 0, y sigue distinguiéndose de un 0 impreso.
 *
 * Lo que SÍ deja incompleta una fila:
 *   · **Sin fecha** y sin confirmar que el papel no la lleva. Sin fecha el
 *     tiquet no se puede situar en ninguna gráfica ni deduplicar.
 *   · **Un descarte de un campo de estado** (`hayDescarteDeEstado`). Ojo, que no
 *     es lo mismo: que el modelo devolviera basura donde iba el total significa
 *     que el papel probablemente SÍ llevaba importe y no se ha sabido leer. Eso
 *     es una lectura fallida, no una ausencia, y hay que mirarla a mano.
 *
 * `sinImporte` se sigue aceptando por compatibilidad de firma, pero ya no
 * cambia el resultado: con el criterio nuevo, con o sin bandera, una fila sin
 * importe está procesada.
 */
function calcularEstado({
    totalCentimos,
    fechaCanonica,
    hayDescarteDeEstado = false,
    sinImporte = false,   // eslint-disable-line no-unused-vars -- ver comentario
    sinFecha = false
}) {
    if (hayDescarteDeEstado) return 'incompleto';
    if (!fechaCanonica && !sinFecha) return 'incompleto';
    return 'procesado';
}

/**
 * ¿Hay que marcar esta fila como "sin importe" automáticamente?
 *
 * Sí cuando el modelo simplemente no devolvió total. NO cuando el total venía y
 * se descartó por contenido corrupto: ahí no sabemos que el documento no lleve
 * importe, sabemos que no se ha podido leer, y la fila se queda 'incompleto'
 * para revisarla. Marcarla como "no tiene importe" sería convertir un fallo de
 * lectura en un hecho sobre el papel.
 *
 * @param {number|null} totalCentimos
 * @param {Set<string>} camposNulos  campos descartados por la validación
 */
function sinImporteAutomatico(totalCentimos, camposNulos) {
    if (Number.isInteger(totalCentimos)) return false;
    const descartados = camposNulos instanceof Set ? camposNulos : new Set(camposNulos || []);
    return !descartados.has('total_centimos');
}

/**
 * Coherencia de las banderas de ausencia.
 *
 * `sinImporte` es DERIVADA, no una casilla: si no hay importe, la fila está sin
 * importe, lo diga quien lo diga. Da igual que venga de la extracción o de una
 * edición a mano, y deja de ser un juicio humano porque ya no decide el estado
 * de la fila: solo registra un hecho comprobable mirando `total_centimos`.
 * Escribir un importe la limpia sola, que es el invariante de siempre
 * ("sin_importe = 1 implica total_centimos IS NULL"), ahora en las dos
 * direcciones.
 *
 * `sinFecha` SÍ sigue siendo una confirmación manual: ahí la bandera cambia el
 * estado de la fila (de 'incompleto' a 'procesado'), así que tiene que afirmarla
 * una persona que haya mirado el papel. El modelo no puede confirmar una
 * ausencia, solo no encontrar el dato, que es otra cosa.
 */
function ajustarAusenciasConfirmadas({ totalCentimos, fechaCanonica, sinImporte, sinFecha }) {
    return {
        sinImporte: !Number.isInteger(totalCentimos),
        sinFecha:   Boolean(sinFecha) && !fechaCanonica
    };
}

// --- DETALLES ----------------------------------------------------------------

/**
 * Normaliza una clave de detalle: minúsculas, sin acentos ni diacríticos,
 * espacios/guiones/puntos a guión bajo, fuera el resto de caracteres especiales.
 *
 *   "Matrícula del vehículo" -> "matricula_del_vehiculo"
 *   "Hora-Entrada"           -> "hora_entrada"
 *   "Nº Factura"             -> "n_factura"
 *   "año"                    -> "ano"
 *
 * Al schema se le pide que ya venga en snake_case ASCII, pero eso es una
 * sugerencia: esta función es la garantía. Devuelve '' si no queda nada usable,
 * y quien llama descarta el par.
 */
function normalizarClaveDetalle(clave) {
    return String(clave)
        .normalize('NFD')                   // separa letra y diacrítico
        .replace(/[̀-ͯ]/g, '')    // fuera los diacríticos (á->a, ñ->n, ç->c)
        .toLowerCase()
        .replace(/[\s\-./]+/g, '_')         // separadores -> guión bajo
        .replace(/[^a-z0-9_]/g, '')         // fuera el resto (º, %, €, :, ...)
        .replace(/_+/g, '_')                // sin guiones bajos repetidos
        .replace(/^_+|_+$/g, '');           // ni al principio ni al final
}

/**
 * Valida y aplana el array `detalles` a objeto {clave: valor}.
 *
 * Reglas:
 *  - La clave se valida en crudo (longitud + marcadores) y DESPUÉS se normaliza.
 *  - El valor NO se normaliza, solo se valida: "9180KGJ" se guarda tal cual.
 *  - Si la clave o el valor no pasan, se descarta el PAR entero. Guardar media
 *    entrada es peor que no guardarla.
 *  - Tope de pares por documento, para que una respuesta desbocada no infle la
 *    fila con cien atributos inventados.
 *  - Un par descartado NUNCA marca la fila como incompleta: detalles es
 *    información secundaria.
 */
function validarDetalles(arr) {
    const detalles    = {};
    const descartados = [];

    if (!Array.isArray(arr)) {
        if (arr !== null && arr !== undefined) {
            descartados.push({
                campo: 'detalles',
                motivo: `se esperaba un array y llegó ${typeof arr}`,
                valor: recortar(JSON.stringify(arr))
            });
        }
        return { detalles, descartados };
    }

    const considerados = arr.slice(0, MAX_PARES_DETALLES);
    if (arr.length > MAX_PARES_DETALLES) {
        descartados.push({
            campo: 'detalles',
            motivo: `${arr.length} pares, se conservan los primeros ${MAX_PARES_DETALLES}`,
            valor: `${arr.length - MAX_PARES_DETALLES} pares ignorados`
        });
    }

    considerados.forEach((par, i) => {
        const etiqueta = `detalles[${i}]`;

        if (!par || typeof par !== 'object') {
            descartados.push({ campo: etiqueta, motivo: 'no es un objeto {clave, valor}', valor: recortar(String(par)) });
            return;
        }

        const rClave = validarTexto(par.clave, LIMITE_CLAVE_DETALLE);
        if (!rClave.ok || rClave.valor === null) {
            descartados.push({
                campo: `${etiqueta}.clave`,
                motivo: rClave.ok ? 'clave vacía' : rClave.motivo,
                valor: recortar(rClave.valor ?? par.clave)
            });
            return;
        }

        // El valor puede llegar como número aunque el schema pida string.
        const valorCrudo = typeof par.valor === 'number' || typeof par.valor === 'boolean'
            ? String(par.valor)
            : par.valor;

        const rValor = validarTexto(valorCrudo, LIMITE_VALOR_DETALLE);
        if (!rValor.ok || rValor.valor === null) {
            descartados.push({
                campo: `${etiqueta}.valor`,
                motivo: rValor.ok ? 'valor vacío' : rValor.motivo,
                valor: recortar(rValor.valor ?? par.valor),
                clave: rClave.valor
            });
            return;
        }

        const claveNorm = normalizarClaveDetalle(rClave.valor);
        if (claveNorm === '') {
            descartados.push({
                campo: `${etiqueta}.clave`,
                motivo: 'la clave queda vacía al normalizarla',
                valor: recortar(rClave.valor)
            });
            return;
        }

        if (Object.prototype.hasOwnProperty.call(detalles, claveNorm)) {
            descartados.push({
                campo: `${etiqueta}.clave`,
                motivo: `colisión: "${rClave.valor}" normaliza a "${claveNorm}", que ya existe`,
                valor: recortar(rValor.valor)
            });
            return;
        }

        detalles[claveNorm] = rValor.valor;
    });

    return { detalles, descartados };
}

// --- ITEMS -------------------------------------------------------------------

/**
 * Valida las líneas de producto. Si `producto` no pasa la validación se
 * descarta la línea entera: un importe sin concepto no dice nada.
 * Igual que detalles, no afecta al estado de la fila.
 */
function validarItems(arr) {
    const items       = [];
    const descartados = [];

    if (!Array.isArray(arr)) {
        if (arr !== null && arr !== undefined) {
            descartados.push({
                campo: 'items',
                motivo: `se esperaba un array y llegó ${typeof arr}`,
                valor: recortar(JSON.stringify(arr))
            });
        }
        return { items, descartados };
    }

    const considerados = arr.slice(0, MAX_ITEMS);
    if (arr.length > MAX_ITEMS) {
        descartados.push({
            campo: 'items',
            motivo: `${arr.length} líneas, se conservan las primeras ${MAX_ITEMS}`,
            valor: `${arr.length - MAX_ITEMS} líneas ignoradas`
        });
    }

    considerados.forEach((item, i) => {
        const etiqueta = `items[${i}]`;

        if (!item || typeof item !== 'object') {
            descartados.push({ campo: etiqueta, motivo: 'no es un objeto', valor: recortar(String(item)) });
            return;
        }

        const rProducto = validarTexto(item.producto, LIMITE_PRODUCTO);
        if (!rProducto.ok || rProducto.valor === null) {
            descartados.push({
                campo: `${etiqueta}.producto`,
                motivo: rProducto.ok ? 'producto vacío' : rProducto.motivo,
                valor: recortar(rProducto.valor ?? item.producto)
            });
            return;
        }

        const precio   = parsearCentimos(item.precio_centimos);
        const cantidad = typeof item.cantidad === 'number' && Number.isFinite(item.cantidad)
            ? item.cantidad
            : parsearCentimos(item.cantidad);

        items.push({
            producto:        rProducto.valor,
            cantidad:        cantidad,
            // Igual que el total: null es "no venía", 0 es "vale cero".
            precio_centimos: precio !== null && precio >= 0 && precio <= MAX_CENTIMOS ? precio : null
        });
    });

    return { items, descartados };
}

// --- RECUADRO ----------------------------------------------------------------

/**
 * Valida las coordenadas aproximadas del tiquet dentro de la foto.
 *
 * Fracciones 0..1 respecto al ancho y alto de la imagen, NO píxeles: así siguen
 * valiendo aunque la foto se reescale. Solo se usan para pintar un marco encima
 * de la foto al revisarla; el archivo nunca se recorta, así que un recuadro algo
 * desviado es cosmético y un recuadro inválido simplemente no se pinta.
 *
 * Devuelve { ok: true, valor: {x, y, ancho, alto} | null } o un descarte.
 */
function validarRecuadro(valor) {
    if (valor === null || valor === undefined) return { ok: true, valor: null };

    // Formato nativo de Gemini: [ymin, xmin, ymax, xmax] en 0..1000. Se pasa a
    // las fracciones que guarda la base y pinta la interfaz.
    if (Array.isArray(valor)) {
        const v = valor.map(Number);
        if (v.length !== 4 || !v.every(Number.isFinite)) {
            return { ok: false, motivo: 'box_2d no son cuatro números', valor: JSON.stringify(valor) };
        }
        const [ymin, xmin, ymax, xmax] = v.map(n => Math.min(1000, Math.max(0, n)) / 1000);
        if (xmax <= xmin || ymax <= ymin) {
            return { ok: false, motivo: 'box_2d vacía o del revés', valor: JSON.stringify(valor) };
        }
        valor = { x: xmin, y: ymin, ancho: xmax - xmin, alto: ymax - ymin };
    }

    if (typeof valor !== 'object' || Array.isArray(valor)) {
        return { ok: false, motivo: `se esperaba un objeto y llegó ${typeof valor}`, valor };
    }

    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v));
    const x     = n(valor.x);
    const y     = n(valor.y);
    const ancho = n(valor.ancho);
    const alto  = n(valor.alto);

    if (![x, y, ancho, alto].every(v => typeof v === 'number' && Number.isFinite(v))) {
        return { ok: false, motivo: 'x/y/ancho/alto no son todos números', valor: JSON.stringify(valor) };
    }
    // Fuera del rango razonable: el modelo ha devuelto píxeles, o se ha inventado
    // el recuadro. Mejor ninguno que uno que pinte un marco en el sitio erróneo.
    if (x < 0 || y < 0 || x > 1 || y > 1 || ancho <= 0 || alto <= 0 || ancho > 1 || alto > 1) {
        return {
            ok: false,
            motivo: 'fuera del rango 0..1 (se esperan fracciones de la imagen, no píxeles)',
            valor: JSON.stringify(valor)
        };
    }

    // Se recorta al borde en lugar de descartar: un marco que se sale un poco por
    // la derecha sigue señalando la zona correcta.
    const redondear = (v) => Math.round(v * 10000) / 10000;
    return {
        ok: true,
        valor: {
            x:     redondear(x),
            y:     redondear(y),
            ancho: redondear(Math.min(ancho, 1 - x)),
            alto:  redondear(Math.min(alto,  1 - y))
        }
    };
}

// --- VALIDACIÓN COMPLETA -----------------------------------------------------

/**
 * Valida TODO lo que devuelve la IA antes de normalizar y guardar.
 *
 * Devuelve:
 *   datos        : copia saneada. Cada campo descartado queda a null; detalles
 *                  llega ya como objeto {clave_normalizada: valor}.
 *   descartados  : lista [{campo, motivo, valor}] para el log.
 *   camposNulos  : Set con los nombres de los campos de primer nivel que se han
 *                  descartado. normalizarDatos lo usa para NO rellenarlos con un
 *                  valor por defecto: un campo descartado debe quedar a NULL,
 *                  no convertirse en 'DESCONOCIDO'.
 *   afectaEstado : true si el descarte toca fecha_compra o total_centimos, los
 *                  campos que definen el estado de la fila.
 */
/**
 * Pago en efectivo: el tiquet trae TOTAL, ENTREGADO y CAMBIO, y la IA a veces
 * coge el cambio (o lo entregado) como total. Si el total coincide con uno de
 * los dos y entregado - cambio es un importe positivo, devuelve ese importe;
 * si no hay nada que corregir, null.
 */
function corregirTotalEfectivo(total, entregado, cambio) {
    const entero = (v) => Number.isInteger(v) && v >= 0 ? v : null;
    const t = entero(total), e = entero(entregado), c = entero(cambio);
    if (t === null || e === null || c === null) return null;
    const bueno = e - c;
    if (bueno <= 0 || t === bueno) return null;
    return t === c || t === e ? bueno : null;
}

function validarDatosExtraidos(entrada) {
    const datos       = {};
    const descartados = [];
    const camposNulos = new Set();

    const bruto = entrada && typeof entrada === 'object' ? entrada : {};

    for (const [campo, limite] of Object.entries(LIMITES_TEXTO)) {
        const r = validarTexto(bruto[campo], limite);
        if (r.ok) {
            datos[campo] = r.valor;
            continue;
        }
        datos[campo] = null;
        camposNulos.add(campo);
        descartados.push({ campo, motivo: r.motivo, valor: recortar(r.valor) });
    }

    // El lugar deducido es un NOMBRE: "MONTSERRAT", "AEROPUERTO DE BARCELONA".
    // Si el modelo devuelve coordenadas se descarta, y no por purismo: unas
    // coordenadas aquí entrarían como texto en la consulta de geocodificación y
    // acabarían poniendo el punto en cualquier parte. Las coordenadas de verdad
    // se pegan a mano en su propio campo, con precisión 'manual'.
    if (datos.lugar_inferido && PARECE_COORDENADAS.test(datos.lugar_inferido)) {
        descartados.push({
            campo: 'lugar_inferido',
            motivo: 'parecen coordenadas y tiene que ser un nombre de lugar',
            valor: recortar(datos.lugar_inferido)
        });
        datos.lugar_inferido = null;
        camposNulos.add('lugar_inferido');
    }

    const rTotal = validarTotal(bruto.total_centimos);
    datos.total_centimos = rTotal.ok ? rTotal.valor : null;
    if (!rTotal.ok) {
        camposNulos.add('total_centimos');
        descartados.push({ campo: 'total_centimos', motivo: rTotal.motivo, valor: recortar(rTotal.valor) });
    }

    // Pago en efectivo: si el total que ha dado la IA es el dinero entregado o el
    // cambio, el bueno es entregado - cambio (TOTAL + CAMBIO = ENTREGADO).
    const totalEfectivo = corregirTotalEfectivo(datos.total_centimos, bruto.efectivo_entregado_centimos, bruto.cambio_centimos);
    if (totalEfectivo !== null) {
        descartados.push({
            campo: 'total_centimos',
            motivo: 'era el dinero entregado o el cambio; se usa entregado - cambio',
            valor: recortar(datos.total_centimos)
        });
        datos.total_centimos = totalEfectivo;
    }

    const rItems = validarItems(bruto.items);
    datos.items = rItems.items;
    descartados.push(...rItems.descartados);

    const rDetalles = validarDetalles(bruto.detalles);
    datos.detalles = rDetalles.detalles;
    descartados.push(...rDetalles.descartados);

    const afectaEstado = [...camposNulos].some(c => CAMPOS_ESTADO.has(c));

    return { datos, descartados, camposNulos, afectaEstado };
}

// --- LOTE: VARIOS TIQUETS EN UNA FOTO ----------------------------------------

// Tope de tiquets por foto. No es una limitación técnica sino de sentido: por
// encima de esto la foto es ilegible y conviene separarla. También protege de una
// respuesta desbocada que llenaría la base de filas basura.
const MAX_TIQUETS_POR_FOTO = 20;

/**
 * Valida la respuesta de la IA, que SIEMPRE es un array de tiquets: una foto de
 * un solo tiquet es un array de longitud 1. No hay dos caminos.
 *
 * Tolera que llegue envuelta en {tiquets: [...]} o como objeto suelto, porque un
 * modelo puede ignorar el array del schema y devolver un tiquet a secas; eso no
 * debería tirar la subida.
 *
 * Devuelve:
 *   tiquets     : [{ indiceModelo, datos, camposNulos, afectaEstado, recuadro,
 *                    descartados }] en orden de lectura
 *   descartados : problemas del LOTE (no de un tiquet concreto), para el log
 */
function validarLoteExtraido(respuesta) {
    const descartados = [];

    let bruto;
    if (Array.isArray(respuesta)) {
        bruto = respuesta;
    } else if (respuesta && Array.isArray(respuesta.tiquets)) {
        bruto = respuesta.tiquets;
    } else if (respuesta && typeof respuesta === 'object') {
        // Un solo tiquet sin envolver: se trata como lote de uno.
        bruto = [respuesta];
        descartados.push({
            campo: 'lote',
            motivo: 'la IA devolvió un objeto suelto en lugar de un array; se trata como un único tiquet',
            valor: ''
        });
    } else {
        descartados.push({
            campo: 'lote',
            motivo: `se esperaba un array de tiquets y llegó ${typeof respuesta}`,
            valor: recortar(JSON.stringify(respuesta ?? null))
        });
        return { tiquets: [], descartados };
    }

    let considerados = bruto.filter(t => t && typeof t === 'object');
    if (considerados.length !== bruto.length) {
        descartados.push({
            campo: 'lote',
            motivo: `${bruto.length - considerados.length} entrada(s) del array no eran objetos`,
            valor: ''
        });
    }

    if (considerados.length > MAX_TIQUETS_POR_FOTO) {
        descartados.push({
            campo: 'lote',
            motivo: `${considerados.length} tiquets en una foto, se conservan los primeros ${MAX_TIQUETS_POR_FOTO}`,
            valor: `${considerados.length - MAX_TIQUETS_POR_FOTO} ignorados`
        });
        considerados = considerados.slice(0, MAX_TIQUETS_POR_FOTO);
    }

    // Orden de lectura. Se respeta el indice_en_foto del modelo cuando es un
    // número usable; si no, el orden en que vinieron. El índice definitivo NO es
    // este: lo reasigna quien guarda, para que sea 0..N-1 sin huecos aunque se
    // descarte alguna entrada por duplicada.
    const conPosicion = considerados.map((t, i) => {
        const declarado = Number(t.indice_en_foto);
        return { t, orden: Number.isFinite(declarado) ? declarado : i, i };
    });
    conPosicion.sort((a, b) => (a.orden - b.orden) || (a.i - b.i));

    const tiquets = conPosicion.map(({ t, orden }) => {
        const validado = validarDatosExtraidos(t);
        const propios  = [...validado.descartados];

        const r = validarRecuadro(t.box_2d ?? t.recuadro);
        if (!r.ok) propios.push({ campo: 'recuadro', motivo: r.motivo, valor: recortar(r.valor) });

        return {
            indiceModelo: orden,
            datos:        validado.datos,
            camposNulos:  validado.camposNulos,
            afectaEstado: validado.afectaEstado,
            recuadro:     r.ok ? r.valor : null,
            descartados:  propios
        };
    });

    return { tiquets, descartados };
}

/**
 * Deja constancia en el log de cada campo descartado, con el motivo y el valor
 * que llegó. Sin esto los descartes serían invisibles: la fila se guardaría con
 * un hueco y nadie sabría por qué.
 */
function registrarDescartes(descartados, referencia = '') {
    if (!descartados || descartados.length === 0) return;

    const donde = referencia ? ` [${referencia}]` : '';
    console.warn(`⚠️  Validación${donde}: ${descartados.length} campo(s) descartado(s) de la respuesta de la IA:`);
    for (const d of descartados) {
        console.warn(`   · ${d.campo}: ${d.motivo} — valor recibido: ${JSON.stringify(d.valor)}`);
    }
}

// --- NORMALIZACIÓN -----------------------------------------------------------

const upperCase = (str) => (str ? String(str).toUpperCase().trim() : null);

const titleCase = (str) => {
    if (!str) return null;
    return String(str).toLowerCase().split(' ')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
};

/**
 * Normaliza el objeto YA VALIDADO antes de guardar.
 *
 * `camposNulos` son los campos que la validación descartó. Para ellos NO se
 * aplica el valor por defecto: si metodo_pago traía basura, la columna queda a
 * NULL. Poner 'DESCONOCIDO' ahí mentiría — 'DESCONOCIDO' significa "el
 * documento no lo dice", no "el modelo devolvió algo ilegible".
 *
 * fecha_compra se guarda ya canonizada cuando se puede interpretar; si no, se
 * conserva el texto crudo del modelo para poder revisarlo (y la fila se marcará
 * como incompleta, porque sin fecha canónica no hay clave de dedupe).
 */
function normalizarDatos(datos, camposNulos = new Set()) {
    const conDefecto = (campo, valor, porDefecto) =>
        camposNulos.has(campo) ? null : (valor || porDefecto);

    const fechaCanonica = canonizarFecha(datos.fecha_compra);

    return {
        tipo_documento:  conDefecto('tipo_documento', upperCase(datos.tipo_documento), 'DESCONOCIDO'),
        categoria:       conDefecto('categoria',      upperCase(datos.categoria),      'OTROS'),
        fecha_compra:    camposNulos.has('fecha_compra')
                            ? null
                            : (fechaCanonica || datos.fecha_compra || null),
        fecha_evento:    camposNulos.has('fecha_evento')
                            ? null
                            : (canonizarFecha(datos.fecha_evento) || datos.fecha_evento || null),
        // Strict: null y 0 son distintos y aquí no se colapsan.
        total_centimos:  parsearCentimos(datos.total_centimos),
        moneda:          conDefecto('moneda',      upperCase(datos.moneda),      'EUR'),
        metodo_pago:     conDefecto('metodo_pago', upperCase(datos.metodo_pago), 'DESCONOCIDO'),
        items_json:      JSON.stringify(datos.items || []),
        // detalles llega ya validado y aplanado por validarDatosExtraidos.
        detalles_json:   JSON.stringify(datos.detalles || {})
    };
}

module.exports = {
    // validación
    validarDatosExtraidos,
    corregirTotalEfectivo,
    validarLoteExtraido,
    validarTexto,
    validarTotal,
    validarDetalles,
    validarItems,
    validarRecuadro,
    registrarDescartes,
    normalizarClaveDetalle,
    // normalización / dedupe
    normalizarDatos,
    parsearCentimos,
    canonizarFecha,
    construirClaveTiquet,
    calcularEstado,
    ajustarAusenciasConfirmadas,
    sinImporteAutomatico,
    upperCase,
    titleCase,
    // constantes, para los tests y para documentar
    LIMITES_TEXTO,
    LIMITE_CLAVE_DETALLE,
    LIMITE_VALOR_DETALLE,
    MAX_PARES_DETALLES,
    MAX_ITEMS,
    MAX_TIQUETS_POR_FOTO,
    MAX_CENTIMOS,
    CAMPOS_ESTADO,
    MARCADORES
};
