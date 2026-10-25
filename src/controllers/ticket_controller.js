const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/db');
const {
    analizarTicket,
    ErrorIA,
    MODOS,
    MODO_AUTOMATICO
} = require('../services/ai_service.js');
const {
    validarDatosExtraidos,
    validarLoteExtraido,
    registrarDescartes,
    normalizarDatos,
    canonizarFecha,
    construirClaveTiquet,
    calcularEstado,
    ajustarAusenciasConfirmadas,
    sinImporteAutomatico,
    upperCase,
    titleCase
} = require('../services/normalizacion.js');

const {
    UPLOADS_DIR,
    REEMPLAZADAS_DIR,
    rutaEnDisco,
    mimeDeArchivo
} = require('../config/rutas.js');

// La geocodificación va SIEMPRE en segundo plano: encolar() apunta el
// establecimiento y vuelve en el acto. Ninguna de las rutas de abajo espera por
// Nominatim, ni siquiera un poco.
const geo = require('../services/geocodificacion.js');
const divisas = require('../services/divisas.js');
const lugares = require('../services/lugares.js');
const establecimientosSrv = require('../services/establecimientos.js');
const { parsearCoordenadas } = geo;

// --- HELPERS ----------------------------------------------------------------
// La validación de contenido, la normalización y la construcción de la clave de
// dedupe viven en services/normalizacion.js: son puras y se prueban sin SQLite.
// Aquí solo queda lo que necesita disco o base de datos.

const sha256 = (buffer) =>
    crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Los intentos fallidos de la IA, en corto y sin el mensaje largo: modelo, tipo
 * y status. Es lo que la interfaz necesita para decir "se probó gemini-pro
 * (transitorio 503) y se cambió a gemini-flash" sin tener que leer el log.
 */
const resumirIntentosIA = (intentos) =>
    (Array.isArray(intentos) ? intentos : []).map(i => ({
        modelo: i.modelo, tipo: i.tipo, status: i.status ?? null
    }));

/** Mueve la imagen antigua a uploads/reemplazadas/. Devuelve la nueva URL. */
function moverAReemplazadas(rutaImagenUrl) {
    if (!fs.existsSync(REEMPLAZADAS_DIR)) {
        fs.mkdirSync(REEMPLAZADAS_DIR, { recursive: true });
    }
    const filename = path.basename(rutaImagenUrl);
    const origen   = path.join(UPLOADS_DIR, filename);
    const destino  = path.join(REEMPLAZADAS_DIR, filename);
    if (fs.existsSync(origen)) {
        fs.renameSync(origen, destino);
    }
    return `/uploads/reemplazadas/${filename}`;
}

/**
 * Localiza (o crea) el establecimiento por nombre normalizado.
 * NO sobrescribe la dirección/ciudad/CP de un establecimiento existente,
 * aunque el modelo diga algo distinto en este ticket (los tiquets a veces
 * traen direcciones parciales o incorrectas).
 *
 * La geocodificación NO se encola aquí: los ids que habría que preguntar se
 * apuntan en `aGeocodificar` y quien llama los encola DESPUÉS de confirmar su
 * transacción. Encolar aquí dentro significaba que un INSERT deshecho por un
 * fallo posterior dejaba igualmente a Nominatim preguntando por un
 * establecimiento que ya no existe —pasó: un reintento que falló por el índice
 * único y aun así geocodificó—.
 */
function upsertEstablecimiento(datos, aGeocodificar = [], idElegido = null) {
    const nombre = upperCase(datos.nombre_establecimiento) || 'DESCONOCIDO';
    // Elegido en el editor de entre los guardados: ese y no otro, aunque haya
    // varios con el mismo nombre.
    if (idElegido) {
        const elegido = db.prepare('SELECT id, nombre FROM establecimientos WHERE id = ?').get(idElegido);
        if (elegido && elegido.nombre === nombre) return elegido.id;
    }
    // Mismo nombre (o alias) Y mismo sitio. Un Mercadona de otra ciudad es otro
    // establecimiento.
    const encontrado = establecimientosSrv.buscarExistente(nombre, datos);
    const existente = encontrado && db.prepare(
        'SELECT id, direccion, ciudad, codigo_postal, lugar_inferido, place_id FROM establecimientos WHERE id = ?'
    ).get(encontrado.id);
    if (existente) {
        // Uno que aún no sabía dónde estaba: se completa con lo de este tiquet.
        if (!existente.place_id && !existente.direccion && !existente.ciudad && !existente.codigo_postal &&
            (datos.direccion || datos.ciudad || datos.codigo_postal)) {
            db.prepare('UPDATE establecimientos SET direccion = ?, ciudad = ?, codigo_postal = ? WHERE id = ?')
              .run(titleCase(datos.direccion), titleCase(datos.ciudad), datos.codigo_postal || null, existente.id);
            aGeocodificar.push({ id: existente.id, rehacer: true });
            return existente.id;
        }
        // Si ya existía SIN lugar deducido y esta lectura trae uno, se guarda y
        // se vuelve a geocodificar: es lo que arregla los establecimientos que
        // quedaron sin ubicar antes de que existiera este campo. No se
        // sobrescribe uno que ya hubiera: lo de antes puede estar corregido a
        // mano.
        const lugar = titleCase(datos.lugar_inferido);
        if (lugar && !existente.lugar_inferido && !existente.direccion && !existente.ciudad) {
            db.prepare('UPDATE establecimientos SET lugar_inferido = ? WHERE id = ?')
              .run(lugar, existente.id);
            aGeocodificar.push({ id: existente.id, rehacer: true });
        }
        return existente.id;
    }

    const info = db.prepare(`
        INSERT INTO establecimientos (nombre, direccion, ciudad, codigo_postal, lugar_inferido)
        VALUES (?, ?, ?, ?, ?)
    `).run(
        nombre,
        titleCase(datos.direccion),
        titleCase(datos.ciudad),
        datos.codigo_postal || null,
        // El lugar DEDUCIDO va en su propia columna, nunca mezclado con la
        // dirección: así se sabe después qué estaba impreso y qué se dedujo.
        titleCase(datos.lugar_inferido)
    );

    const id = Number(info.lastInsertRowid);
    // Establecimiento nuevo: a la cola de geocodificación. Nace 'pendiente' por
    // el DEFAULT de la columna, así que aunque el proceso muera antes de
    // preguntar, el script o el próximo arranque lo recogen.
    aGeocodificar.push({ id, rehacer: false });
    return id;
}

/** Encola lo apuntado durante una transacción que YA se ha confirmado. */
function encolarGeocodificacion(pendientes) {
    for (const p of pendientes) {
        if (p.rehacer) { geo.marcarParaRegeocodificar(p.id); lugares.marcarPendiente(p.id); }
        else { geo.encolar(p.id); lugares.encolar(p.id); }
    }
    pendientes.length = 0;
    // Después de cualquier guardado: si hay compras en otra moneda, a euros.
    divisas.avisar();
}

/**
 * Qué modelo de IA se ha pedido para esta petición.
 *
 * Llega como parámetro OPCIONAL `modo_modelo`, en el cuerpo (campo de texto del
 * multipart en la subida, JSON en el reintento) o en la query. Sin él se usa la
 * cascada completa: el comportamiento de siempre, para que un cliente antiguo
 * —o un curl— siga funcionando sin saber que esto existe.
 *
 * Se valida aquí y NO en ai_service para poder responder un 400 honesto antes de
 * gastar una llamada a la API. Un valor desconocido no se interpreta como
 * 'automatico' a propósito: si alguien escribe "mejorr" querrá saberlo, y tragar
 * el error le daría silenciosamente el modelo barato.
 */
function modoPedido(req) {
    const enCuerpo = req.body && req.body.modo_modelo;
    const enQuery  = req.query && req.query.modo_modelo;
    const crudo = String(enCuerpo || enQuery || '').trim().toLowerCase();

    if (!crudo) return { modo: MODO_AUTOMATICO };
    if (!MODOS.includes(crudo)) {
        return {
            error: `modo_modelo="${crudo}" no es válido. Valores admitidos: ` +
                   `${MODOS.join(', ')} (o nada, que equivale a "${MODO_AUTOMATICO}").`
        };
    }
    return { modo: crudo };
}

// --- STATEMENTS PREPARADOS --------------------------------------------------

const STMT_INSERT_TICKET = db.prepare(`
    INSERT INTO tickets (
        tipo_documento, categoria, establecimiento_id,
        fecha_compra, fecha_evento,
        total_centimos, moneda, metodo_pago,
        items, detalles,
        ruta_imagen, hash_imagen, indice_en_foto, total_en_foto, recuadro,
        clave_tiquet, hora_conocida, sin_importe, sin_fecha,
        estado, modelo_usado
    ) VALUES (
        @tipo_documento, @categoria, @establecimiento_id,
        @fecha_compra, @fecha_evento,
        @total_centimos, @moneda, @metodo_pago,
        @items, @detalles,
        @ruta_imagen, @hash_imagen, @indice_en_foto, @total_en_foto, @recuadro,
        @clave_tiquet, @hora_conocida, @sin_importe, @sin_fecha,
        @estado, @modelo_usado
    )
`);

// Reemplazo in-place: sustituye TODO, incluida la imagen. Solo se usa cuando una
// foto nueva de un único tiquet resulta ser un tiquet que ya teníamos.
const STMT_UPDATE_TICKET = db.prepare(`
    UPDATE tickets SET
        tipo_documento      = @tipo_documento,
        categoria           = @categoria,
        establecimiento_id  = @establecimiento_id,
        fecha_compra        = @fecha_compra,
        fecha_evento        = @fecha_evento,
        total_centimos      = @total_centimos,
        moneda              = @moneda,
        metodo_pago         = @metodo_pago,
        items               = @items,
        detalles            = @detalles,
        ruta_imagen         = @ruta_imagen,
        hash_imagen         = @hash_imagen,
        indice_en_foto      = @indice_en_foto,
        total_en_foto       = @total_en_foto,
        recuadro            = @recuadro,
        clave_tiquet        = @clave_tiquet,
        hora_conocida       = @hora_conocida,
        sin_importe         = @sin_importe,
        sin_fecha           = @sin_fecha,
        estado              = @estado,
        modelo_usado        = @modelo_usado,
        updated_at          = CURRENT_TIMESTAMP
    WHERE id = @id
`);

// Fila sin extracción: solo sabemos qué archivo es y por qué no se procesó.
// El resto de columnas quedan a NULL a propósito; moneda se pone explícitamente
// a NULL para que el DEFAULT 'EUR' no simule un dato que nadie ha leído.
// modelo_usado también queda a NULL: ningún modelo llegó a leer esta foto, y
// anotar el que se intentó convertiría "lo leyó X" en "lo intentó X".
const STMT_INSERT_SIN_EXTRAER = db.prepare(`
    INSERT INTO tickets (ruta_imagen, hash_imagen, estado, moneda)
    VALUES (@ruta_imagen, @hash_imagen, @estado, NULL)
`);

// Dedupe Nivel 1. El hash ya no identifica UNA fila: identifica una FOTO, que
// puede haber generado varias. Por eso devuelve todas las filas de esa foto, en
// orden de lectura: con ellas se puede decir "esa foto ya está procesada y generó
// 3 tiquets" sin llamar a la API.
const STMT_BUSCAR_POR_HASH = db.prepare(`
    SELECT id, estado, indice_en_foto, total_en_foto
    FROM tickets
    WHERE hash_imagen = ?
    ORDER BY indice_en_foto ASC, id ASC
`);

// Preferimos hora_conocida=1 en caso de empate: si hay una fila de alta
// confianza con la misma clave, la elegimos como candidata a reemplazo.
// El segundo parámetro excluye una fila concreta (la que estamos reprocesando),
// para que no se detecte como duplicada de sí misma.
const STMT_BUSCAR_POR_CLAVE = db.prepare(`
    SELECT id, ruta_imagen, hora_conocida
    FROM tickets
    WHERE clave_tiquet = ? AND id <> ?
    ORDER BY hora_conocida DESC, id ASC
    LIMIT 1
`);

// =============================================================================
// GUARDADO DE UN LOTE: N TIQUETS DE UNA MISMA FOTO
// =============================================================================
// Una foto puede contener varios tiquets. La IA devuelve SIEMPRE un array —una
// foto de un tiquet es un array de longitud 1—, y esta función es el único camino
// por el que se guarda lo extraído, tanto en la subida como en el reintento. No
// hay una rama "un tiquet" y otra "varios": la misma, con N = 1 como caso normal.
//
// Las N filas comparten el archivo de imagen. La foto NO se recorta nunca: se
// guarda entera y cada fila apunta a ella con su indice_en_foto y su recuadro
// opcional para saber qué trozo le corresponde al mirarla.

// Como STMT_UPDATE_DATOS pero incluyendo la posición dentro de la foto. Lo usa el
// reintento para la fila que ya existía: sus datos cambian y, si la foto resulta
// tener varios tiquets, también su índice y su total.
// Una fila de la foto que la relectura ya no describe. No se borra: la lectura
// nueva puede ser la equivocada, y borrar datos por una relectura sería perder
// lo único que quedaba de ese papel. Se queda marcada para revisar y sin clave
// de duplicados, que describía un tiquet que la foto ya no dice tener.
const STMT_MARCAR_SOBRANTE = db.prepare(`
    UPDATE tickets SET
        estado        = 'incompleto',
        clave_tiquet  = NULL,
        total_en_foto = @total,
        updated_at    = CURRENT_TIMESTAMP
     WHERE id = @id
`);

const STMT_UPDATE_LOTE = db.prepare(`
    UPDATE tickets SET
        tipo_documento      = @tipo_documento,
        categoria           = @categoria,
        establecimiento_id  = @establecimiento_id,
        fecha_compra        = @fecha_compra,
        fecha_evento        = @fecha_evento,
        total_centimos      = @total_centimos,
        moneda              = @moneda,
        metodo_pago         = @metodo_pago,
        items               = @items,
        detalles            = @detalles,
        indice_en_foto      = @indice_en_foto,
        total_en_foto       = @total_en_foto,
        recuadro            = @recuadro,
        clave_tiquet        = @clave_tiquet,
        hora_conocida       = @hora_conocida,
        sin_importe         = @sin_importe,
        sin_fecha           = @sin_fecha,
        estado              = @estado,
        modelo_usado        = @modelo_usado,
        updated_at          = CURRENT_TIMESTAMP
    WHERE id = @id
`);

/**
 * Columnas de datos + posición en la foto. better-sqlite3 es estricto con los
 * parámetros nombrados (no admite ni sobrantes ni ausentes), así que cada
 * statement tiene su propio constructor de fila.
 */
function columnasComunes({ norm, establecimientoId, derivadas, estado, posicion, modeloUsado, sinImporte }) {
    return {
        tipo_documento:     norm.tipo_documento,
        categoria:          norm.categoria,
        establecimiento_id: establecimientoId,
        fecha_compra:       norm.fecha_compra,
        fecha_evento:       norm.fecha_evento,
        total_centimos:     norm.total_centimos,
        moneda:             norm.moneda,
        metodo_pago:        norm.metodo_pago,
        items:              norm.items_json,
        detalles:           norm.detalles_json,
        indice_en_foto:     posicion.indice,
        total_en_foto:      posicion.total,
        recuadro:           posicion.recuadro ? JSON.stringify(posicion.recuadro) : null,
        clave_tiquet:       derivadas.claveTiquet,
        hora_conocida:      derivadas.horaConocida,
        // sin_importe es AUTOMÁTICO desde el cambio de criterio: no hay total ⇒
        // no hay importe. Ya no es un juicio humano, porque ya no decide el
        // estado de la fila; es un hecho que se lee en total_centimos.
        sin_importe:        sinImporte ? 1 : 0,
        // sin_fecha SÍ sigue siendo una confirmación manual (ahí la bandera sí
        // cambia el estado), así que una extracción nunca la pone: el modelo no
        // encuentra el dato, que no es lo mismo que comprobar que el papel no lo
        // lleva. Se escribe a 0 explícitamente para que un reintento no arrastre
        // una confirmación vieja.
        sin_fecha:          0,
        estado,
        // El modelo que de verdad leyó esta foto. Lo mismo para las N filas que
        // salgan de ella: una sola llamada, una sola lectura.
        modelo_usado:       modeloUsado ?? null
    };
}

/**
 * Prepara cada entrada del lote: normaliza, resuelve el establecimiento y calcula
 * las columnas derivadas. Es el paso previo a decidir qué se inserta y qué no.
 */
function prepararEntrada(entrada, referencia, aGeocodificar = []) {
    registrarDescartes(entrada.descartados, referencia);

    const norm = normalizarDatos(entrada.datos, entrada.camposNulos);
    // Reglas fijas (gasolina de bonÀrea…). Solo al leer el tiquet: lo que yo
    // cambie a mano en el editor no lo toca.
    const porRegla = require('../services/reglas_categoria').categoriaPorRegla(
        entrada.datos && entrada.datos.nombre_establecimiento, norm.total_centimos);
    if (porRegla) norm.categoria = porRegla;
    const establecimientoId = upsertEstablecimiento(entrada.datos, aGeocodificar);
    const derivadas = derivarColumnas(norm, establecimientoId);

    // Si el modelo no ha devuelto total, la fila queda marcada "sin importe" sin
    // que nadie tenga que confirmarlo: con el criterio actual eso no la deja
    // incompleta, solo registra que no hay importe que sumar. La excepción es un
    // total DESCARTADO por corrupto, que no es una ausencia sino una lectura
    // fallida (lo decide sinImporteAutomatico).
    const sinImporte = sinImporteAutomatico(norm.total_centimos, entrada.camposNulos);

    return { ...entrada, norm, establecimientoId, derivadas, sinImporte };
}

/**
 * Quita del lote las entradas que comparten clave_tiquet con otra del MISMO lote.
 *
 * Si dos elementos del array salen con la misma clave (mismo establecimiento,
 * misma fecha con hora y mismo importe) no son dos tiquets: es el modelo leyendo
 * dos veces el mismo papel, probablemente porque estaba doblado o porque el
 * tiquet y su justificante de tarjeta parecían dos documentos. Se queda la
 * primera en orden de lectura y las demás se registran.
 *
 * Solo se comparan claves NO nulas: sin fecha o sin importe no hay clave, y dos
 * entradas sin clave pueden ser perfectamente dos tiquets distintos.
 */
function quitarDuplicadosDelLote(preparadas) {
    const vistas = new Map();   // clave -> índice de lectura que se queda
    const conservadas = [];
    const repetidas = [];

    preparadas.forEach((p) => {
        const clave = p.derivadas.claveTiquet;
        if (clave && vistas.has(clave)) {
            repetidas.push({ entrada: p, claveRepetida: clave, indiceOriginal: p.indiceModelo });
            return;
        }
        if (clave) vistas.set(clave, p.indiceModelo);
        conservadas.push(p);
    });

    for (const r of repetidas) {
        console.warn(
            `⚠️  Lote: la entrada ${r.indiceOriginal} repite la clave ${r.claveRepetida} ` +
            `de otra entrada de la misma foto. Es el mismo papel leído dos veces: se descarta.`
        );
    }

    return { conservadas, repetidas };
}

/**
 * Guarda las N filas de una foto.
 *
 * @param {Array}  entradas  salida de validarLoteExtraido().tiquets, ya validada
 * @param {Object} ctx
 *   hash              SHA-256 del archivo (identifica la FOTO, no la fila)
 *   rutaImagenUrl     "/uploads/xxxx.jpg", compartida por las N filas
 *   referencia        texto para el log
 *   modeloUsado       nombre del modelo que leyó la foto, para modelo_usado
 *   idFilaBase        si se pasa, el tiquet de índice 0 ACTUALIZA esa fila en vez
 *                     de insertar una nueva (camino del reintento: ya existe)
 *   permitirReemplazo habilita el reemplazo in-place de un tiquet que ya
 *                     teníamos. Solo tiene sentido en la subida y solo cuando la
 *                     foto trae un único tiquet (ver más abajo).
 *
 * @returns {{ filas: Array, repetidas: Array, movimientos: Array }}
 */
function guardarLote(entradas, ctx) {
    // Lo que habrá que preguntarle a Nominatim SI la transacción se confirma.
    const aGeocodificar = [];

    const filas = [];
    const movimientos = [];   // renombrados de archivos, fuera de la transacción
    const sobrantes = [];     // filas de la foto que la relectura ya no describe
    let conservadas = [], repetidas = [], total = 0, esFotoUnica = true;

    // TODO dentro de la transacción, también la preparación: ahí es donde se dan
    // de alta los establecimientos, y si algo falla después (el índice único de
    // (hash, indice_en_foto), por ejemplo) no puede quedar un establecimiento
    // suelto ni una geocodificación pedida para una fila que no existe.
    db.transaction(() => {
        const preparadas = entradas.map((e, i) =>
            prepararEntrada(e, `${ctx.referencia} · tiquet ${i + 1}/${entradas.length}`, aGeocodificar)
        );

        ({ conservadas, repetidas } = quitarDuplicadosDelLote(preparadas));

        // El total y los índices se calculan DESPUÉS de quitar los repetidos, para
        // que "Ficha 2 de 2" sea verdad y para que (hash, indice_en_foto) no tenga
        // huecos. Si la foto ya tenía más filas que lecturas trae ahora, el total
        // es el de las filas que quedarán: las sobrantes no se borran.
        total = Math.max(conservadas.length, ctx.filasPorIndice ? ctx.filasPorIndice.size : 0);
        esFotoUnica = total === 1;
        conservadas.forEach((p, indice) => {
            const posicion = { indice, total, recuadro: p.recuadro };

            // Punto (c) del diseño: una foto con varios tiquets SIEMPRE se revisa,
            // aunque cada lectura parezca completa. Repartir importes entre varios
            // papeles en una sola imagen es justo donde más fácil se equivoca.
            const estado = esFotoUnica
                ? calcularEstado({
                      totalCentimos:       p.norm.total_centimos,
                      fechaCanonica:       p.derivadas.fechaCanonica,
                      hayDescarteDeEstado: p.afectaEstado
                  })
                : 'incompleto';

            // Qué fila ACTUALIZA esta lectura. Reanalizar una foto con varias
            // fichas tiene que actualizar las que ya existen, emparejándolas por
            // indice_en_foto: insertarlas chocaba con el índice único
            // (hash_imagen, indice_en_foto) y dejaba el reintento a medias.
            const idExistente = ctx.filasPorIndice ? ctx.filasPorIndice.get(indice) : undefined;
            const idBase = idExistente ?? ((indice === 0 && ctx.idFilaBase) ? ctx.idFilaBase : null);

            // Dedupe Nivel 2, por tiquet: ¿ya tenemos este mismo tiquet?
            const similar = p.derivadas.claveTiquet
                ? STMT_BUSCAR_POR_CLAVE.get(p.derivadas.claveTiquet, idBase ?? -1)
                : null;

            const ambosConHora = similar &&
                similar.hora_conocida === 1 && p.derivadas.horaConocida === 1;

            // Caso B (reemplazo in-place): la foto nueva ES la foto de ese tiquet,
            // así que sustituye datos e imagen y la anterior se archiva.
            // Exige que la foto traiga UN solo tiquet: si trae varios, el archivo
            // es compartido y no se puede entregar a una fila ajena sin dejar a las
            // hermanas apuntando a una imagen que ya no les pertenece.
            if (ctx.permitirReemplazo && esFotoUnica && ambosConHora && !idBase) {
                const rutaAntigua = similar.ruta_imagen;
                STMT_UPDATE_TICKET.run({
                    id: similar.id,
                    ...columnasComunes({ ...p, estado, posicion, modeloUsado: ctx.modeloUsado }),
                    ruta_imagen: ctx.rutaImagenUrl,
                    hash_imagen: ctx.hash
                });
                movimientos.push({ id: similar.id, rutaAntigua });
                filas.push({
                    resultado: 'reemplazado',
                    id: similar.id,
                    indice_en_foto: indice,
                    estado,
                    datos: p.datos,
                    descartados: p.descartados,
                    recuadro: p.recuadro
                });
                return;
            }

            // Duplicado de alta confianza que NO se puede reemplazar (la foto trae
            // varios tiquets, o venimos de un reintento sobre una fila existente).
            // Se guardan los datos —la lectura es buena y la llamada a la API está
            // pagada— pero sin clave, porque el índice único no admite dos, y
            // marcado para revisar con el aviso de con quién choca.
            const derivadas = ambosConHora
                ? { ...p.derivadas, claveTiquet: null }
                : p.derivadas;
            const estadoFinal = ambosConHora ? 'incompleto' : estado;

            const columnas = columnasComunes({
                ...p, derivadas, estado: estadoFinal, posicion, modeloUsado: ctx.modeloUsado
            });

            let id;
            if (idBase) {
                STMT_UPDATE_LOTE.run({ id: idBase, ...columnas });
                id = idBase;
            } else {
                id = Number(STMT_INSERT_TICKET.run({
                    ...columnas,
                    ruta_imagen: ctx.rutaImagenUrl,
                    hash_imagen: ctx.hash
                }).lastInsertRowid);
            }

            filas.push({
                resultado: ambosConHora
                    ? 'duplicado_marcado'
                    : (similar ? 'posible_duplicado' : 'creado'),
                id,
                indice_en_foto: indice,
                estado: estadoFinal,
                id_similar: similar ? similar.id : null,
                datos: p.datos,
                descartados: p.descartados,
                recuadro: p.recuadro
            });
        });

        // La foto traía MENOS tiquets que filas tiene: las sobrantes NO se
        // borran —la lectura nueva puede ser la equivocada— pero se marcan para
        // revisar y se les quita la clave de duplicados, que describía un tiquet
        // que ya no es el que dice la foto.
        if (ctx.filasPorIndice) {
            for (const [indice, id] of ctx.filasPorIndice) {
                if (indice < conservadas.length) continue;
                STMT_MARCAR_SOBRANTE.run({ id, total });
                sobrantes.push(id);
            }
        }
    })();

    // La geocodificación y los avisos, solo con la transacción confirmada.
    encolarGeocodificacion(aGeocodificar);
    if (sobrantes.length) {
        console.warn(
            `⚠️  La relectura devolvió ${conservadas.length} tiquet(s) y la foto tenía ` +
            `${total}: las fila(s) ${sobrantes.join(', ')} se conservan marcadas para revisar.`
        );
    }

    // Los renombrados van fuera de la transacción: si fallan, las filas ya son
    // correctas y el archivo viejo simplemente se queda donde estaba.
    const imagenesAntiguas = movimientos.map(m => {
        // La foto que se sustituye puede ser a su vez una foto con varios tiquets:
        // la fila reemplazada ya apunta a la nueva imagen, pero sus hermanas
        // siguen necesitando la antigua. En ese caso no se archiva nada.
        if (!liberarFoto(m.rutaAntigua)) {
            console.log(`🖼  La imagen anterior ${m.rutaAntigua} se conserva: la usan otros tiquets.`);
            return { id: m.id, url: m.rutaAntigua, compartida: true };
        }
        try {
            return { id: m.id, url: moverAReemplazadas(m.rutaAntigua) };
        } catch (err) {
            console.warn(
                `⚠️  Ticket ${m.id} actualizado, pero no se pudo mover la imagen antigua ` +
                `${m.rutaAntigua} a reemplazadas/:`, err.message
            );
            return { id: m.id, url: m.rutaAntigua };
        }
    });

    return { filas, repetidas, imagenesAntiguas, total, sobrantes };
}

/**
 * Fila de recambio cuando la IA no reconoce ningún documento en la foto (array
 * vacío). Sin esto la foto se quedaría huérfana en uploads/ sin nadie que la
 * mirase. Queda 'incompleto' para rellenarla a mano o borrarla.
 *
 * Aquí modelo_usado SÍ se rellena: el modelo respondió, miró la foto y dijo que
 * no había nada. Eso es una lectura —mala o buena— y es justo lo que interesa
 * poder comparar entre modelos.
 */
function guardarFotoSinTiquets(ctx) {
    const id = Number(STMT_INSERT_TICKET.run({
        tipo_documento: null, categoria: null, establecimiento_id: null,
        fecha_compra: null, fecha_evento: null,
        total_centimos: null, moneda: null, metodo_pago: null,
        items: '[]', detalles: '{}',
        ruta_imagen: ctx.rutaImagenUrl, hash_imagen: ctx.hash,
        indice_en_foto: 0, total_en_foto: 1, recuadro: null,
        clave_tiquet: null, hora_conocida: 0,
        // La fila está vacía: no hay importe, y tampoco fecha, así que se queda
        // 'incompleto' por la fecha —que es lo que sigue mandando— y no por el
        // importe.
        sin_importe: 1, sin_fecha: 0,
        estado: 'incompleto',
        modelo_usado: ctx.modeloUsado ?? null
    }).lastInsertRowid);

    console.warn(`⚠️  ${ctx.referencia}: la IA no ha reconocido ningún documento. Fila ${id} vacía para revisar.`);
    return id;
}

// --- POST /api/tickets/upload -----------------------------------------------

exports.subirTicket = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No has subido ningún archivo (imagen o PDF)' });
    }

    const rutaDisco = req.file.path;

    // El modo se valida antes de cualquier trabajo: si viene mal, la foto recién
    // subida sobra y no hay que dejarla tirada en uploads/.
    const pedido = modoPedido(req);
    if (pedido.error) {
        try { fs.unlinkSync(rutaDisco); } catch (_) {}
        return res.status(400).json({ error: pedido.error });
    }

    try {
        // Leemos una vez y usamos el buffer para hash + IA.
        const imageBuffer = fs.readFileSync(rutaDisco);
        const hash = sha256(imageBuffer);

        // --- Nivel 1: la FOTO ya se procesó -----------------------------
        // El hash identifica el archivo, y un archivo puede haber generado varias
        // filas. Si ya está, no se vuelve a llamar a la API: se dice cuántos
        // tiquets salieron de esa foto y en qué estado están.
        const filasDeEsaFoto = STMT_BUSCAR_POR_HASH.all(hash);
        if (filasDeEsaFoto.length > 0) {
            fs.unlinkSync(rutaDisco);   // la copia recién subida sobra
            const n = filasDeEsaFoto.length;
            console.log(`↩️  Duplicado exacto por hash: esa foto ya generó ${n} fila(s) [${filasDeEsaFoto.map(f => f.id).join(', ')}].`);

            // Matiz importante: si las filas quedaron sin procesar, decir "ya está
            // en la base" sería engañoso. La imagen está a salvo, pero los datos
            // no se han extraído todavía.
            const sinProcesar = filasDeEsaFoto.filter(f => f.estado === 'pendiente' || f.estado === 'error');
            const mensaje = sinProcesar.length > 0
                ? `Ese archivo ya estaba guardado, pero ${sinProcesar.length === n ? 'sigue' : 'parte sigue'} ` +
                  `sin procesar (estado: ${sinProcesar.map(f => f.estado).join(', ')}). ` +
                  `Volver a subirlo no lo reintenta: usa el botón Reintentar de la fila.`
                : n === 1
                    ? 'Ese mismo archivo ya está en la base. No se ha vuelto a procesar.'
                    : `Ese mismo archivo ya está en la base y generó ${n} tiquets. No se ha vuelto a procesar.`;

            return res.status(200).json({
                resultado: 'duplicado_exacto',
                mensaje,
                total_en_foto: n,
                ids: filasDeEsaFoto.map(f => f.id),
                filas: filasDeEsaFoto,
                // Compatibilidad con el caso de siempre (una foto, una fila).
                estado: filasDeEsaFoto[0].estado,
                id_existente: filasDeEsaFoto[0].id
            });
        }

        // --- Extracción con IA ------------------------------------------
        // La cascada de modelos vive en ai_service: aquí solo se dice en qué modo
        // y se recoge QUÉ modelo acabó respondiendo, para guardarlo en la fila.
        console.log(`📸 Procesando archivo: ${req.file.filename} (modo '${pedido.modo}')`);
        const { tiquets: respuesta, modelo: modeloUsado, intentos: intentosIA } =
            await analizarTicket(imageBuffer, req.file.mimetype, {
                modo: pedido.modo,
                // Solo se usa como displayName si el archivo tiene que pasar por
                // la Files API de Gemini: ayuda a identificarlo si algún borrado
                // falla y hay que mirarlo en la consola de Google.
                nombre: req.file.filename
            });

        // --- Validación, por tiquet -------------------------------------
        const { tiquets, descartados: descartadosDelLote } = validarLoteExtraido(respuesta);
        registrarDescartes(descartadosDelLote, req.file.filename);
        console.log(`✨ ${tiquets.length} tiquet(s) extraído(s) de ${req.file.filename} con '${modeloUsado}'.`);

        // Qué ha costado leerla: los intentos fallidos por el camino. La interfaz
        // lo enseña ("se probó X y se cambió a Y") en vez de dejar que parezca que
        // todo fue a la primera.
        const intentos = resumirIntentosIA(intentosIA);

        const rutaImagenUrl = `/uploads/${req.file.filename}`;
        const ctx = {
            hash,
            rutaImagenUrl,
            referencia: req.file.filename,
            modeloUsado,
            permitirReemplazo: true
        };

        // La IA no ha visto ningún documento: se conserva la foto con una fila
        // vacía en vez de tirarla.
        if (tiquets.length === 0) {
            const id = guardarFotoSinTiquets(ctx);
            return res.json({
                resultado: 'sin_tiquets',
                mensaje: 'La IA no ha reconocido ningún tiquet en la foto. Se ha guardado la ' +
                         'imagen con una ficha vacía: puedes rellenarla a mano o borrarla.',
                id,
                ids: [id],
                total_en_foto: 1,
                estado: 'incompleto',
                modelo_usado: modeloUsado,
                intentos_ia: intentos,
                descartados: descartadosDelLote
            });
        }

        const { filas, repetidas, imagenesAntiguas, total } = guardarLote(tiquets, ctx);

        const avisoRepetidas = repetidas.length > 0
            ? ` La IA devolvió ${repetidas.length} lectura(s) repetida(s) del mismo papel y se han descartado.`
            : '';

        // --- Foto con VARIOS tiquets ------------------------------------
        if (total > 1) {
            console.log(`🧾 ${total} tiquets guardados de una sola foto: ${filas.map(f => f.id).join(', ')}.`);
            return res.json({
                resultado: 'creado_multiple',
                mensaje: `Se han encontrado ${total} tiquets en la foto y se han guardado como ` +
                         `${total} fichas independientes, todas marcadas para revisar.${avisoRepetidas}`,
                total_en_foto: total,
                ids: filas.map(f => f.id),
                filas,
                modelo_usado: modeloUsado,
                intentos_ia: intentos,
                descartados: descartadosDelLote
            });
        }

        // --- Foto con UN tiquet: respuesta de siempre --------------------
        const fila = filas[0];
        const comun = {
            id: fila.id,
            ids: [fila.id],
            total_en_foto: 1,
            estado: fila.estado,
            datos: fila.datos,
            modelo_usado: modeloUsado,
            intentos_ia: intentos,
            descartados: [...descartadosDelLote, ...fila.descartados]
        };

        if (fila.resultado === 'reemplazado') {
            const antigua = imagenesAntiguas.find(x => x.id === fila.id);
            console.log(`♻️  Ticket ${fila.id} reemplazado con nueva foto.`);
            return res.json({
                ...comun,
                resultado: 'reemplazado',
                mensaje: 'Ya tenías este mismo tiquet. Se han actualizado los datos y la imagen; ' +
                         'la anterior se ha movido a reemplazadas/.' + avisoRepetidas,
                imagen_antigua: antigua ? antigua.url : null
            });
        }

        if (fila.resultado === 'posible_duplicado') {
            console.log(`⚠️  Posible duplicado del ticket ${fila.id_similar}. Insertado como ${fila.id}.`);
            return res.json({
                ...comun,
                resultado: 'posible_duplicado',
                mensaje: 'Guardado como tiquet nuevo, pero se parece a otro ya existente. ' +
                         'Revísalo a mano.' + avisoRepetidas,
                id_similar: fila.id_similar
            });
        }

        if (fila.resultado === 'duplicado_marcado') {
            return res.json({
                ...comun,
                resultado: 'posible_duplicado',
                mensaje: `Se ha leído bien, pero coincide con el tiquet ${fila.id_similar}. ` +
                         `Se ha guardado marcado para revisar y sin clave de duplicados.` + avisoRepetidas,
                id_similar: fila.id_similar
            });
        }

        return res.json({
            ...comun,
            resultado: 'creado',
            mensaje: avisoRepetidas.trim() || undefined
        });

    } catch (error) {
        console.error("ERROR:", error);
        return manejarFalloDeSubida(error, req, res, rutaDisco);
    }
};

// --- MANEJO DE FALLOS DE SUBIDA ---------------------------------------------

// Qué hacer con la imagen y con qué estado se guarda la fila, según el tipo de
// error que venga de ai_service. La clave: un fallo temporal NO puede costarnos
// la foto, porque reintentar la habría resuelto.
const PLAN_POR_TIPO = {
    // Saturación o error interno de Google. Ya se reintentó dentro de
    // ai_service; si aun así falla, la guardamos para más tarde.
    transitorio:   { conservar: true,  estado: 'pendiente', http: 503 },
    // Cuota agotada: no se reintenta (empeoraría), pero tampoco se pierde.
    cuota:         { conservar: true,  estado: 'pendiente', http: 429 },
    // Problema de configuración del servidor, no del tiquet.
    autenticacion: { conservar: true,  estado: 'error',     http: 500 },
    modelo:        { conservar: true,  estado: 'error',     http: 500 },
    configuracion: { conservar: true,  estado: 'error',     http: 500 },
    // La respuesta llegó cortada: demasiados tiquets (o demasiadas líneas) en una
    // sola foto. Reintentar tal cual la volvería a cortar, así que NO es
    // 'pendiente': queda en 'error' con la foto guardada, y se resuelve fuera,
    // separando la foto en varias y volviéndolas a subir. 422 porque el problema
    // está en lo que se ha enviado, no en el servidor.
    truncado:      { conservar: true,  estado: 'error',     http: 422 },
    // El archivo pasa de lo que Gemini admite. El original SE CONSERVA —es el
    // único sitio donde está, y aquí nunca se recomprime nada—; lo que no hay es
    // extracción, así que queda en 'error' con su mensaje. 413 porque el
    // problema es el tamaño de lo enviado.
    demasiado_grande: { conservar: true, estado: 'error',    http: 413 },
    // Irrecuperable: reintentar daría lo mismo. Comportamiento de siempre.
    permanente:    { conservar: false, estado: null,        http: 500 }
};

function manejarFalloDeSubida(error, req, res, rutaDisco) {
    // Cualquier cosa que no venga clasificada de ai_service (un fallo de disco,
    // un error de SQLite) se trata como permanente, que es el comportamiento
    // conservador de siempre.
    // El duck-typing va primero a propósito: si el módulo se cargase por dos
    // rutas distintas habría dos clases ErrorIA y el instanceof fallaría.
    const esDeIA = Boolean(error) &&
        (typeof error.tipo === 'string' || error instanceof ErrorIA);
    const tipo   = esDeIA ? error.tipo : 'permanente';
    const plan   = PLAN_POR_TIPO[tipo] || PLAN_POR_TIPO.permanente;

    const mensaje = esDeIA && error.mensaje
        ? error.mensaje
        : 'Error al procesar el tiquet.';

    // Caso permanente: como antes, el archivo no aporta nada y se borra.
    if (!plan.conservar) {
        try { if (fs.existsSync(rutaDisco)) fs.unlinkSync(rutaDisco); } catch (_) {}
        return res.status(plan.http).json({
            resultado: 'fallo',
            tipo,
            status_api: esDeIA ? error.status : null,
            error: mensaje
        });
    }

    // Caso recuperable: conservamos la imagen y dejamos constancia en la base,
    // con los campos de extracción a NULL. Sin fila, la foto sería un huérfano
    // en uploads/ que nadie volvería a mirar.
    try {
        const info = STMT_INSERT_SIN_EXTRAER.run({
            ruta_imagen:  `/uploads/${req.file.filename}`,
            hash_imagen:  sha256(fs.readFileSync(rutaDisco)),
            estado:       plan.estado
        });
        console.log(`💾 Imagen conservada como ticket ${info.lastInsertRowid} en estado '${plan.estado}'.`);
        return res.status(plan.http).json({
            resultado: 'fallo',
            tipo,
            status_api: esDeIA ? error.status : null,
            estado: plan.estado,
            id: info.lastInsertRowid,
            error: mensaje
        });
    } catch (errGuardar) {
        // Si ni siquiera podemos registrar la fila, al menos no mentimos: se
        // avisa de que la imagen queda suelta en uploads/ y no se borra.
        console.error('❌ No se pudo guardar la fila de recuperación:', errGuardar);
        return res.status(plan.http).json({
            resultado: 'fallo',
            tipo,
            status_api: esDeIA ? error.status : null,
            error: `${mensaje} (Además no se pudo registrar en la base: la imagen queda en uploads/${req.file.filename}.)`
        });
    }
}

// --- GET /api/tickets -------------------------------------------------------
// Búsqueda, filtros, orden y paginación. Todo se resuelve en SQL: traerse el
// histórico entero para filtrarlo en el cliente funcionaba con cien filas y deja
// de funcionar justo cuando la aplicación empieza a servir para algo.

// Las consultas se construyen según los filtros que lleguen, así que no pueden
// prepararse a nivel de módulo. Se cachean por texto de SQL: las combinaciones
// reales son un puñado y así cada una se compila una sola vez.
const sentenciasCacheadas = new Map();
function prepararEnCache(sql) {
    if (!sentenciasCacheadas.has(sql)) sentenciasCacheadas.set(sql, db.prepare(sql));
    return sentenciasCacheadas.get(sql);
}

const COLUMNAS_LISTADO = `
        t.*,
        e.nombre         AS establecimiento_nombre,
        e.direccion      AS establecimiento_direccion,
        e.ciudad         AS establecimiento_ciudad,
        e.codigo_postal  AS establecimiento_codigo_postal,
        e.pais           AS establecimiento_pais,
        e.lugar_inferido AS establecimiento_lugar_inferido,
        e.latitud        AS establecimiento_latitud,
        e.longitud       AS establecimiento_longitud,
        e.geo_precision  AS establecimiento_precision,
        e.geo_estado     AS establecimiento_geo_estado,
        e.google_estado  AS establecimiento_google,
        e.google_nombre  AS establecimiento_google_nombre`;

// Cada orden, con lo que haya que poner delante para que los huecos no manden.
// SQLite coloca los NULL primero al ordenar ascendente, así que sin el primer
// criterio una lista "de más antiguo a más reciente" empezaría por las filas sin
// fecha, que no son las más antiguas: son las que no se sabe cuándo son.
const ORDENES = {
    // Por defecto, la fecha del TIQUET: es la que importa para entender el gasto.
    fecha:   { expresion: 't.fecha_compra', huecosAlFinal: '(t.fecha_compra IS NULL) ASC' },
    // El importe ausente vale 0 al ordenar, igual que al sumar: ahí no hay NULL
    // que colocar.
    importe: { expresion: 'COALESCE(t.total_centimos, 0)' },
    subida:  { expresion: 't.created_at' }
};

const LIMITE_POR_DEFECTO = 100;
const LIMITE_MAXIMO      = 500;

/** Un entero de la query, o null. Devuelve `error` si viene y no es un entero. */
function enteroDeQuery(valor, nombre, { min = null, max = null } = {}) {
    if (valor === undefined || valor === '') return { valor: null };
    const texto = String(valor).trim();
    if (!/^-?\d+$/.test(texto)) {
        return { error: `${nombre} tiene que ser un número entero ("${texto}" no lo es).` };
    }
    let n = Number(texto);
    if (min !== null && n < min) return { error: `${nombre} no puede ser menor que ${min}.` };
    if (max !== null && n > max) n = max;   // se recorta en silencio, no es un error
    return { valor: n };
}

/** YYYY-MM-DD, que es como se comparan las fechas guardadas. */
function fechaDeQuery(valor, nombre) {
    if (valor === undefined || valor === '') return { valor: null };
    const texto = String(valor).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
        return { error: `${nombre} tiene que ser una fecha YYYY-MM-DD ("${valor}" no lo es).` };
    }
    return { valor: texto };
}

/**
 * Prepara un texto para un LIKE. Los comodines de SQL se escapan: quien escribe
 * "100%" en el buscador está buscando eso, no "cualquier cosa".
 */
function patronLike(texto) {
    const escapado = String(texto).replace(/[\\%_]/g, c => `\\${c}`);
    return `%${escapado}%`;
}

const esVerdadero = (v) => ['1', 'true', 'si', 'sí', 'on'].includes(String(v).trim().toLowerCase());
const esFalso     = (v) => ['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase());

/**
 * Traduce la query a WHERE + parámetros. Devuelve `{ error }` si algo no se
 * entiende: un filtro mal escrito que se ignora en silencio enseña una lista que
 * parece correcta y no lo es, y eso es peor que un 400.
 */
function construirFiltros(query = {}) {
    const condiciones = [];
    const params = {};
    const aplicados = {};

    // --- texto ---
    if (query.q !== undefined && String(query.q).trim() !== '') {
        const texto = String(query.q).trim().slice(0, 100);
        params.patron = patronLike(texto);
        // items es JSON guardado como texto: buscar dentro con LIKE encuentra el
        // nombre del producto sin tener que desplegar el array. Es tosco y es
        // exactamente lo que hace falta aquí.
        condiciones.push(`(
            e.nombre          LIKE @patron ESCAPE '\\'
         OR t.categoria       LIKE @patron ESCAPE '\\'
         OR t.tipo_documento  LIKE @patron ESCAPE '\\'
         OR t.items           LIKE @patron ESCAPE '\\'
        )`);
        aplicados.q = texto;
    }

    // --- rango de fechas (del tiquet) ---
    const desde = fechaDeQuery(query.desde, 'desde');
    if (desde.error) return { error: desde.error };
    if (desde.valor) {
        // substr y no date(): fecha_compra es texto 'YYYY-MM-DD[ HH:MM:SS]' y
        // comparar los diez primeros caracteres funciona con y sin hora.
        condiciones.push(`substr(t.fecha_compra, 1, 10) >= @desde`);
        params.desde = desde.valor;
        aplicados.desde = desde.valor;
    }

    const hasta = fechaDeQuery(query.hasta, 'hasta');
    if (hasta.error) return { error: hasta.error };
    if (hasta.valor) {
        condiciones.push(`substr(t.fecha_compra, 1, 10) <= @hasta`);
        params.hasta = hasta.valor;
        aplicados.hasta = hasta.valor;
    }

    // --- rango de importe, en CÉNTIMOS (como todo en esta base) ---
    const min = enteroDeQuery(query.min, 'min', { min: 0 });
    if (min.error) return { error: min.error };
    if (min.valor !== null) {
        condiciones.push(`COALESCE(t.total_centimos, 0) >= @min`);
        params.min = min.valor;
        aplicados.min = min.valor;
    }

    const max = enteroDeQuery(query.max, 'max', { min: 0 });
    if (max.error) return { error: max.error };
    if (max.valor !== null) {
        condiciones.push(`COALESCE(t.total_centimos, 0) <= @max`);
        params.max = max.valor;
        aplicados.max = max.valor;
    }

    // --- iguales exactos ---
    for (const [parametro, columna] of [
        ['categoria', 't.categoria'],
        ['tipo',      't.tipo_documento'],
        ['estado',    't.estado']
    ]) {
        const valor = query[parametro];
        if (valor === undefined || String(valor).trim() === '') continue;
        const limpio = String(valor).trim().slice(0, 60);
        // categoria y tipo_documento se guardan en MAYÚSCULAS; estado no.
        const comparado = parametro === 'estado' ? limpio.toLowerCase() : limpio.toUpperCase();
        condiciones.push(`${columna} = @${parametro}`);
        params[parametro] = comparado;
        aplicados[parametro] = comparado;
    }

    // --- sin ubicar en el mapa ---
    // Lo que el panel enseña como "N sin ubicar" y que al pulsarlo filtra el
    // historial. Una fila sin establecimiento tampoco se puede situar, y el
    // LEFT JOIN la trae con las coordenadas a NULL, así que entra sola.
    if (query.sin_ubicar !== undefined && String(query.sin_ubicar).trim() !== '') {
        const valor = String(query.sin_ubicar);
        if (esVerdadero(valor)) {
            condiciones.push(`(e.latitud IS NULL OR e.longitud IS NULL) AND COALESCE(e.geo_precision, '') <> 'online'`);
            aplicados.sin_ubicar = true;
        } else if (esFalso(valor)) {
            condiciones.push(`(e.latitud IS NOT NULL AND e.longitud IS NOT NULL)`);
            aplicados.sin_ubicar = false;
        } else {
            return { error: `sin_ubicar tiene que ser 1 o 0 ("${valor}" no lo es).` };
        }
    }

    // --- situados en un punto que no cuadra ---
    // Lo que el panel enseña como "N dudosos": el código postal que devolvió
    // Nominatim no es el del papel, así que el punto está en el mapa pero no se
    // puede dar por bueno.
    if (query.dudoso !== undefined && String(query.dudoso).trim() !== '') {
        const valor = String(query.dudoso);
        if (esVerdadero(valor)) {
            condiciones.push(`e.geo_precision = 'discrepante'`);
            aplicados.dudoso = true;
        } else if (esFalso(valor)) {
            condiciones.push(`COALESCE(e.geo_precision, '') <> 'discrepante'`);
            aplicados.dudoso = false;
        } else {
            return { error: `dudoso tiene que ser 1 o 0 ("${valor}" no lo es).` };
        }
    }

    // --- sin importe ---
    if (query.sin_importe !== undefined && String(query.sin_importe).trim() !== '') {
        const valor = String(query.sin_importe);
        if (esVerdadero(valor)) {
            condiciones.push(`t.sin_importe = 1`);
            aplicados.sin_importe = true;
        } else if (esFalso(valor)) {
            condiciones.push(`t.sin_importe = 0`);
            aplicados.sin_importe = false;
        } else {
            return { error: `sin_importe tiene que ser 1 o 0 ("${valor}" no lo es).` };
        }
    }

    // --- las fichas de UNA misma foto ---
    // El editor lo usa para ofrecer saltar a las hermanas: una foto con tres
    // tiquets puede tener las tres repartidas en páginas distintas del historial
    // (o fuera de las cargadas), así que no basta con buscarlas en memoria.
    if (query.hash !== undefined && String(query.hash).trim() !== '') {
        const limpio = String(query.hash).trim().slice(0, 128);
        condiciones.push(`t.hash_imagen = @hash`);
        params.hash = limpio;
        aplicados.hash = limpio;
    }

    // --- orden ---
    const nombreOrden = String(query.orden || 'fecha').trim().toLowerCase();
    if (!ORDENES[nombreOrden]) {
        return {
            error: `orden="${nombreOrden}" no es válido. Valores admitidos: ` +
                   `${Object.keys(ORDENES).join(', ')}.`
        };
    }
    const direccion = String(query.dir || 'desc').trim().toLowerCase();
    if (direccion !== 'asc' && direccion !== 'desc') {
        return { error: `dir="${direccion}" no es válido. Solo asc o desc.` };
    }

    // --- paginación ---
    const limite = enteroDeQuery(query.limit, 'limit', { min: 1, max: LIMITE_MAXIMO });
    if (limite.error) return { error: limite.error };
    const desplazamiento = enteroDeQuery(query.offset, 'offset', { min: 0 });
    if (desplazamiento.error) return { error: desplazamiento.error };

    return {
        where: condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '',
        params,
        aplicados,
        orden: nombreOrden,
        columnaOrden: ORDENES[nombreOrden].expresion,
        huecosAlFinal: ORDENES[nombreOrden].huecosAlFinal || null,
        direccion: direccion.toUpperCase(),
        limit: limite.valor ?? LIMITE_POR_DEFECTO,
        offset: desplazamiento.valor ?? 0
    };
}

exports.obtenerTickets = (req, res) => {
    const filtros = construirFiltros(req.query);
    if (filtros.error) return res.status(400).json({ error: filtros.error });

    // Cuántos hay y cuánto suman (en euros y, si es compartido, solo mi parte):
    // el historial enseña el total de una búsqueda ("cuánto en BM").
    const recuento = prepararEnCache(`
        SELECT COUNT(*) AS n,
               COALESCE(SUM(CAST(ROUND(COALESCE(t.total_eur_centimos, t.total_centimos, 0) * (CASE
                   WHEN t.mi_parte_centimos IS NOT NULL AND t.total_centimos > 0
                       THEN MIN(1.0, t.mi_parte_centimos * 1.0 / t.total_centimos)
                   WHEN t.compartido_entre > 1 THEN 1.0 / t.compartido_entre
                   ELSE 1.0 END)) AS INTEGER)), 0) AS suma
        FROM tickets t
        LEFT JOIN establecimientos e ON e.id = t.establecimiento_id
        ${filtros.where}
    `).get(filtros.params);
    const total = recuento.n;

    // Los dos criterios de desempate mantienen juntas y en orden de lectura las
    // filas que salieron de la misma foto, que es lo que el historial agrupa.
    // Ojo: con orden=fecha, dos hermanas con fechas distintas pueden caer en
    // páginas distintas. Es inevitable paginando por tiquet (que es lo que se
    // filtra) y se nota solo en fotos con varios tiquets.
    const sql = `
        SELECT ${COLUMNAS_LISTADO}
        FROM tickets t
        LEFT JOIN establecimientos e ON e.id = t.establecimiento_id
        ${filtros.where}
        ORDER BY ${filtros.huecosAlFinal ? `${filtros.huecosAlFinal}, ` : ''}
                 ${filtros.columnaOrden} ${filtros.direccion},
                 t.hash_imagen ASC, t.indice_en_foto ASC
        LIMIT @limit OFFSET @offset
    `;

    const filas = prepararEnCache(sql).all({
        ...filtros.params,
        limit: filtros.limit,
        offset: filtros.offset
    });

    const tiquets = filas.map(r => ({
        ...r,
        items:    safeParse(r.items,    []),
        detalles: safeParse(r.detalles, {}),
        // El recuadro se guarda como JSON; el frontend lo quiere ya como objeto
        // para dibujar el marco sobre la foto.
        recuadro: safeParse(r.recuadro, null)
    }));

    res.json({
        tiquets,
        total,
        suma_centimos: recuento.suma,
        limit: filtros.limit,
        offset: filtros.offset,
        // Con esto el frontend puede pintar "mostrando 1-100 de 437" y saber si
        // hay más sin pedir otra página a ciegas.
        hay_mas: filtros.offset + tiquets.length < total,
        orden: filtros.orden,
        dir: filtros.direccion.toLowerCase(),
        filtros: filtros.aplicados
    });
};

function safeParse(text, fallback) {
    try { return JSON.parse(text); } catch (_) { return fallback; }
}

// =============================================================================
// REVISIÓN MANUAL: GET /:id, PUT /:id, DELETE /:id, POST /:id/reintentar
// =============================================================================
// Hasta aquí el ciclo era de un solo sentido: la IA escribía y nadie podía
// corregirla. Estos cuatro endpoints cierran el ciclo. El principio que los
// gobierna: una corrección mía pasa por LA MISMA capa de validación que la
// extracción automática (services/normalizacion.js). Si escribo una fecha en
// formato raro se canoniza igual, y las claves de detalles se normalizan igual.
// Lo único que cambia es qué se hace con lo que la validación rechaza: en la
// extracción se descarta en silencio y se anota en el log, porque no hay nadie
// a quien preguntar; en una edición manual se devuelve un 422 explicando qué
// campo no se puede guardar, porque quien lo escribió está delante.

// --- STATEMENTS -------------------------------------------------------------

const STMT_OBTENER_FILA = db.prepare('SELECT * FROM tickets WHERE id = ?');

// Igual que el listado, pero de una sola fila: sirve para repintar la tarjeta
// después de editar o reintentar sin recargar el historial entero.
const STMT_DETALLE_TICKET = db.prepare(`
    SELECT
        t.*,
        e.nombre         AS establecimiento_nombre,
        e.direccion      AS establecimiento_direccion,
        e.ciudad         AS establecimiento_ciudad,
        e.codigo_postal  AS establecimiento_codigo_postal,
        e.pais           AS establecimiento_pais,
        e.lugar_inferido AS establecimiento_lugar_inferido,
        e.latitud        AS establecimiento_latitud,
        e.longitud       AS establecimiento_longitud,
        e.geo_precision  AS establecimiento_precision,
        e.geo_estado     AS establecimiento_geo_estado,
        e.google_estado  AS establecimiento_google,
        e.google_nombre  AS establecimiento_google_nombre
    FROM tickets t
    LEFT JOIN establecimientos e ON e.id = t.establecimiento_id
    WHERE t.id = ?
`);

// Solo columnas de DATOS. A diferencia de STMT_UPDATE_TICKET, no toca
// ruta_imagen ni hash_imagen: la foto pertenece al archivo subido y no se
// cambia editando el formulario.
const STMT_UPDATE_DATOS = db.prepare(`
    UPDATE tickets SET
        tipo_documento      = @tipo_documento,
        categoria           = @categoria,
        establecimiento_id  = @establecimiento_id,
        fecha_compra        = @fecha_compra,
        fecha_evento        = @fecha_evento,
        total_centimos      = @total_centimos,
        moneda              = @moneda,
        metodo_pago         = @metodo_pago,
        items               = @items,
        detalles            = @detalles,
        clave_tiquet        = @clave_tiquet,
        hora_conocida       = @hora_conocida,
        sin_importe         = @sin_importe,
        sin_fecha           = @sin_fecha,
        estado              = @estado,
        updated_at          = CURRENT_TIMESTAMP
    WHERE id = @id
`);

// ¿Hay OTRA fila con esta misma clave semántica?
const STMT_COLISION_CLAVE = db.prepare(`
    SELECT id, estado FROM tickets
    WHERE clave_tiquet = ? AND id <> ?
    ORDER BY id ASC LIMIT 1
`);

const STMT_BORRAR_TICKET       = db.prepare('DELETE FROM tickets WHERE id = ?');
const STMT_ACTUALIZAR_ESTADO   = db.prepare(
    'UPDATE tickets SET estado = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
);

// Solo el modelo. Lo usa el reintento cuando la lectura no da ningún tiquet: no
// hay datos que guardar, pero sí consta quién la leyó y dijo que no había nada.
const STMT_ACTUALIZAR_MODELO   = db.prepare(
    'UPDATE tickets SET modelo_usado = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
);
const STMT_CONTAR_TICKETS_EST  = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE establecimiento_id = ?');
const STMT_BORRAR_EST          = db.prepare('DELETE FROM establecimientos WHERE id = ?');

// La dirección que tiene AHORA, para saber si la edición la cambia.
const STMT_DIRECCION_EST = db.prepare(
    'SELECT direccion, ciudad, codigo_postal, pais, lugar_inferido FROM establecimientos WHERE id = ?'
);

// En una edición manual SÍ se sobrescribe la dirección del establecimiento.
// upsertEstablecimiento no lo hace a propósito, pero ese cuidado existe para
// protegerse del MODELO (los tiquets traen direcciones parciales), no de mí: si
// yo corrijo la dirección es porque la he leído en el papel.
const STMT_COMPARTIDO = db.prepare(`
    UPDATE tickets SET compartido_entre = @compartido_entre, mi_parte_centimos = @mi_parte_centimos
    WHERE id = @id
`);

const STMT_ACTUALIZAR_EST = db.prepare(`
    UPDATE establecimientos SET
        direccion      = @direccion,
        ciudad         = @ciudad,
        codigo_postal  = @codigo_postal,
        pais           = @pais,
        lugar_inferido = @lugar_inferido
    WHERE id = @id
`);

// --- HELPERS ----------------------------------------------------------------

/** Lee el :id de la URL. Devuelve null si no es un entero positivo. */
function idDeParam(param) {
    const n = Number(param);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Columnas derivadas de los datos normalizados. Es exactamente el mismo cálculo
 * que hace la subida: fecha canónica, si la hora es conocida, y clave de dedupe.
 */
function derivarColumnas(norm, establecimientoId) {
    const fechaCanonica = canonizarFecha(norm.fecha_compra);
    const horaConocida  = fechaCanonica && fechaCanonica.length > 10 ? 1 : 0;
    const claveTiquet   = construirClaveTiquet(
        establecimientoId, fechaCanonica, horaConocida, norm.total_centimos
    );
    return { fechaCanonica, horaConocida, claveTiquet };
}

/** Monta el objeto de parámetros de STMT_UPDATE_DATOS. */
function filaDeDatos({ id, norm, establecimientoId, derivadas, estado, ausencias }) {
    return {
        id,
        tipo_documento:     norm.tipo_documento,
        categoria:          norm.categoria,
        establecimiento_id: establecimientoId,
        fecha_compra:       norm.fecha_compra,
        fecha_evento:       norm.fecha_evento,
        total_centimos:     norm.total_centimos,
        moneda:             norm.moneda,
        metodo_pago:        norm.metodo_pago,
        items:              norm.items_json,
        detalles:           norm.detalles_json,
        clave_tiquet:       derivadas.claveTiquet,
        hora_conocida:      derivadas.horaConocida,
        // Las únicas banderas que se escriben desde el formulario: confirmar que el
        // documento no imprime importe o fecha es un juicio humano.
        sin_importe:        ausencias.sinImporte ? 1 : 0,
        sin_fecha:          ausencias.sinFecha   ? 1 : 0,
        estado
    };
}

/**
 * Borra el establecimiento si ya no le queda ningún tiquet. Devuelve su id si lo
 * ha borrado, o null. Se llama al borrar un tiquet y también al reasignar uno a
 * otro establecimiento durante una edición: los dos caminos dejan huérfanos.
 */
function borrarEstablecimientoSiHuerfano(establecimientoId) {
    if (!establecimientoId) return null;
    const { n } = STMT_CONTAR_TICKETS_EST.get(establecimientoId);
    if (n > 0) return null;
    // Sin tiquets pero con pagos del banco que apuntan a él: se queda.
    try { if (require('../services/banco').banco().usaEstablecimiento(establecimientoId)) return null; } catch (_) { /* sin banco */ }
    STMT_BORRAR_EST.run(establecimientoId);
    console.log(`🧹 Establecimiento ${establecimientoId} borrado: se quedó sin tiquets.`);
    return establecimientoId;
}

const STMT_FILAS_DE_LA_FOTO = db.prepare(`
    SELECT id, indice_en_foto
    FROM tickets
    WHERE ruta_imagen = ?
    ORDER BY indice_en_foto ASC, id ASC
`);

const STMT_REINDEXAR = db.prepare(
    'UPDATE tickets SET indice_en_foto = ?, total_en_foto = ? WHERE id = ?'
);

/**
 * ¿Queda alguien usando esta foto?
 *
 * Desde que una foto puede contener varios tiquets, el archivo es COMPARTIDO: no
 * se puede borrar ni mover por el hecho de que una de las filas desaparezca o
 * pase a apuntar a otra imagen. Las que quedan se renumeran, para que la marca
 * "2 de 3" del historial siga siendo verdad y para que (hash, indice_en_foto)
 * siga sin huecos ni repetidos.
 *
 * Devuelve true si el archivo ya no lo referencia nadie y se puede tocar.
 */
function liberarFoto(rutaImagenUrl) {
    if (!rutaImagenUrl) return false;

    const restantes = STMT_FILAS_DE_LA_FOTO.all(rutaImagenUrl);
    if (restantes.length === 0) return true;

    // Sigue habiendo dueños: se renumeran y el archivo se queda donde está.
    // Se reescriben todas sin comparar antes: son dos o tres filas y la
    // reasignación es idempotente.
    restantes.forEach((f, i) => STMT_REINDEXAR.run(i, restantes.length, f.id));
    console.log(
        `🖼  La foto ${rutaImagenUrl} la siguen usando ${restantes.length} tiquet(s) ` +
        `[${restantes.map(f => f.id).join(', ')}]: no se toca el archivo y se renumeran.`
    );
    return false;
}

/**
 * Borra del disco la imagen de un tiquet. Devuelve true si el archivo existía y
 * se ha borrado. No lanza: una imagen que ya no está no debe impedir borrar la
 * fila, solo se avisa por el log.
 */
function borrarImagenDeDisco(rutaImagenUrl) {
    const enDisco = rutaEnDisco(rutaImagenUrl);
    if (!enDisco) {
        console.warn(`⚠️  ruta_imagen no utilizable, no se borra nada del disco: ${rutaImagenUrl}`);
        return false;
    }
    try {
        if (!fs.existsSync(enDisco)) {
            console.warn(`⚠️  La imagen ${rutaImagenUrl} ya no estaba en el disco.`);
            return false;
        }
        fs.unlinkSync(enDisco);
        return true;
    } catch (err) {
        console.warn(`⚠️  No se pudo borrar la imagen ${rutaImagenUrl}:`, err.message);
        return false;
    }
}

/** Fila lista para el frontend: items y detalles ya parseados. */
function filaParaCliente(id) {
    const fila = STMT_DETALLE_TICKET.get(id);
    if (!fila) return null;
    return {
        ...fila,
        items:    safeParse(fila.items,    []),
        detalles: safeParse(fila.detalles, {}),
        recuadro: safeParse(fila.recuadro, null)
    };
}

/**
 * Normaliza `detalles` venga como venga: array de pares (lo que manda la IA y el
 * formulario) u objeto plano {clave: valor} (lo que está guardado en la base).
 * La validación siempre recibe el array de pares, para que pase por el mismo
 * camino que la extracción.
 */
function detallesComoPares(detalles) {
    if (Array.isArray(detalles)) return detalles;
    if (detalles && typeof detalles === 'object') {
        return Object.entries(detalles).map(([clave, valor]) => ({ clave, valor }));
    }
    return [];
}

// --- GET /api/tickets/:id ---------------------------------------------------

// Todos los establecimientos con lo que se sabe de ellos, los más usados
// primero. El editor los ofrece al escribir el nombre: elegir uno rellena la
// dirección y la ubicación sin volver a buscarla.
const STMT_LISTAR_EST = db.prepare(`
    SELECT e.id, e.nombre, e.direccion, e.ciudad, e.codigo_postal, e.pais, e.lugar_inferido,
           e.latitud, e.longitud, e.geo_precision, e.geo_estado,
           e.place_id, e.google_estado, e.google_nombre, e.google_direccion, e.google_candidatos,
           COUNT(t.id) AS tiquets
    FROM establecimientos e
    LEFT JOIN tickets t ON t.establecimiento_id = e.id
    GROUP BY e.id
    ORDER BY tiquets DESC, e.nombre ASC
`);
// GET /api/tickets/establecimientos/:id/actividad — sus últimos tiquets y cargos
// del banco, para reconocer qué sitio es (fecha, importe, nombre del banco).
const STMT_TIQUETS_DE_EST = db.prepare(`
    SELECT id, fecha_compra, total_centimos, moneda, categoria FROM tickets
    WHERE establecimiento_id = ? ORDER BY fecha_compra DESC, id DESC`);
exports.actividadEstablecimiento = (req, res) => {
    const id = Number(req.params.id);
    if (!STMT_EST_POR_ID.get(id)) return res.status(404).json({ error: 'Ese establecimiento no existe.' });
    const tiquets = STMT_TIQUETS_DE_EST.all(id);
    let banco = { total: 0, movimientos: [] };
    try {
        banco = require('../services/banco').banco().movimientosDeEstablecimiento(id, tiquets.map(t => t.id), 10);
    } catch (_) { /* sin banco */ }
    res.json({ total_tiquets: tiquets.length, tiquets: tiquets.slice(0, 10), total_movimientos: banco.total, movimientos: banco.movimientos });
};

const STMT_TIQUET_EST = db.prepare('SELECT id, establecimiento_id FROM tickets WHERE establecimiento_id IS NOT NULL');
exports.listarEstablecimientos = (req, res) => {
    // Los cargos del banco de cada sitio, junto a sus tiquets.
    let cargos = new Map();
    try {
        const tiquetEst = new Map(STMT_TIQUET_EST.all().map(t => [t.id, t.establecimiento_id]));
        cargos = require('../services/banco').banco().cargosPorEstablecimiento(tiquetEst);
    } catch (_) { /* sin banco */ }
    const lista = STMT_LISTAR_EST.all().map((e) => {
        let candidatos = [];
        try { candidatos = JSON.parse(e.google_candidatos || '[]'); } catch (_) { /* nada */ }
        return { ...e, google_candidatos: candidatos, movimientos: cargos.get(e.id) || 0 };
    });
    res.json({ establecimientos: lista, google: lugares.resumen() });
};

// --- EDITAR Y UNIR ESTABLECIMIENTOS ------------------------------------------

const STMT_EST_POR_ID     = db.prepare('SELECT * FROM establecimientos WHERE id = ?');
const STMT_EST_POR_NOMBRE = db.prepare('SELECT id FROM establecimientos WHERE nombre = ?');
const STMT_EDITAR_EST = db.prepare(`
    UPDATE establecimientos SET
        nombre = @nombre, direccion = @direccion, ciudad = @ciudad,
        codigo_postal = @codigo_postal, pais = @pais, lugar_inferido = @lugar_inferido
    WHERE id = @id
`);
const STMT_TICKETS_DE_EST = db.prepare('SELECT id, clave_tiquet FROM tickets WHERE establecimiento_id = ?');
const STMT_MOVER_TICKET = db.prepare(
    'UPDATE tickets SET establecimiento_id = @destino, clave_tiquet = @clave WHERE id = @id'
);
// Al unir, lo que le falte al que se queda se completa con lo del que se va.
const STMT_COMPLETAR_EST = db.prepare(`
    UPDATE establecimientos SET
        direccion      = COALESCE(direccion, @direccion),
        ciudad         = COALESCE(ciudad, @ciudad),
        codigo_postal  = COALESCE(codigo_postal, @codigo_postal),
        pais           = COALESCE(pais, @pais),
        lugar_inferido = COALESCE(lugar_inferido, @lugar_inferido)
    WHERE id = @id
`);
const STMT_COPIAR_UBICACION = db.prepare(`
    UPDATE establecimientos SET latitud = @latitud, longitud = @longitud,
           geo_estado = @geo_estado, geo_precision = @geo_precision
    WHERE id = @id AND latitud IS NULL
`);

const textoOpcional = (valor, maximo) => {
    const s = String(valor ?? '').trim();
    return s ? s.slice(0, maximo) : null;
};

exports.editarEstablecimiento = (req, res) => {
    const id = idDeParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Id de establecimiento no válido.' });
    const actual = STMT_EST_POR_ID.get(id);
    if (!actual) return res.status(404).json({ error: `No existe el establecimiento ${id}.` });

    const b = req.body || {};
    const campo = (clave, maximo, formato = (v) => v) =>
        clave in b ? formato(textoOpcional(b[clave], maximo)) : actual[clave];

    const nombre = upperCase(textoOpcional(b.nombre ?? actual.nombre, 100));
    if (!nombre) return res.status(422).json({ error: 'El nombre no puede quedar vacío.' });

    const nuevo = {
        id, nombre,
        direccion:      campo('direccion', 120, titleCase),
        ciudad:         campo('ciudad', 60, titleCase),
        codigo_postal:  campo('codigo_postal', 12),
        pais:           campo('pais', 60, titleCase),
        lugar_inferido: campo('lugar_inferido', 80, titleCase)
    };

    let accion = null;
    if (b.coordenadas !== undefined) {
        const texto = String(b.coordenadas).trim();
        if (texto === '') accion = 'limpiar';
        else if (!parsearCoordenadas(texto)) {
            return res.status(422).json({
                error: 'Las coordenadas no se entienden. Pégalas como "41.0123, 0.9876".'
            });
        } else accion = texto;
    }

    const direccionCambiada = ['direccion', 'ciudad', 'codigo_postal', 'pais', 'lugar_inferido']
        .some(k => (actual[k] ?? null) !== (nuevo[k] ?? null));

    STMT_EDITAR_EST.run(nuevo);

    if (accion === 'limpiar') geo.limpiarCoordenadasManuales(id);
    else if (accion) geo.fijarCoordenadasManuales(id, accion);
    // Las coordenadas puestas a mano no se tocan nunca por cambiar la dirección.
    else if (direccionCambiada && !['manual', 'google', 'online'].includes(actual.geo_precision)) geo.marcarParaRegeocodificar(id);
    if (direccionCambiada && !actual.place_id) lugares.marcarPendiente(id);
    if (nombre !== actual.nombre) establecimientosSrv.apuntarAlias(id, actual.nombre);

    console.log(`🏪 Establecimiento ${id} editado: ${nombre}.`);
    res.json({ resultado: 'editado', establecimiento: STMT_EST_POR_ID.get(id) });
};

// PUT /api/tickets/establecimientos/:id/online — tienda online / sin ubicación
// ({ online: true }) o volver a buscarle sitio ({ online: false }).
exports.marcarOnlineEstablecimiento = (req, res) => {
    const id = idDeParam(req.params.id);
    if (!id || !STMT_EST_POR_ID.get(id)) return res.status(404).json({ error: 'Ese establecimiento no existe.' });
    const online = Boolean((req.body || {}).online);
    establecimientosSrv.marcarOnline(id, online);
    if (!online) { lugares.encolar(id); }
    console.log(`🏪 Establecimiento ${id}: ${online ? 'online, sin ubicación' : 'vuelve a buscar ubicación'}.`);
    res.json({ resultado: 'editado', establecimiento: STMT_EST_POR_ID.get(id) });
};

exports.unirEstablecimientos = (req, res) => {
    const destino = idDeParam(req.params.id);
    const origen = idDeParam((req.body || {}).origen);
    if (!destino || !origen || destino === origen) {
        return res.status(400).json({ error: 'Hay que indicar dos establecimientos distintos.' });
    }
    const queda = STMT_EST_POR_ID.get(destino);
    const sale = STMT_EST_POR_ID.get(origen);
    if (!queda || !sale) return res.status(404).json({ error: 'Alguno de los dos establecimientos no existe.' });

    const { movidos, clavesQuitadas } = establecimientosSrv.unir(destino, origen);
    console.log(`🏪 ${sale.nombre} unido a ${queda.nombre}: ${movidos} tiquet(s) movido(s).`);
    res.json({
        resultado: 'unidos', movidos, claves_quitadas: clavesQuitadas,
        establecimiento: STMT_EST_POR_ID.get(destino)
    });
};

// --- GOOGLE PLACES: buscar, elegir, descartar -------------------------------

// Buscador del editor de tiquets: sitios de Google para lo que escriba.
exports.buscarLugarLibre = async (req, res) => {
    const b = req.body || {};
    const texto = String(b.texto || '').trim().slice(0, 200);
    if (!texto) return res.status(400).json({ error: 'Escribe qué buscar.' });
    const cerca = Number.isFinite(Number(b.latitud)) && Number.isFinite(Number(b.longitud)) && b.latitud !== null
        ? { latitud: Number(b.latitud), longitud: Number(b.longitud) } : null;
    try {
        res.json({ candidatos: await lugares.buscarLibre(texto, cerca) });
    } catch (err) {
        res.status(err.estado || 502).json({ error: err.temporal ? 'Google no responde ahora mismo.' : err.message });
    }
};

exports.buscarLugar = async (req, res) => {
    const id = idDeParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Id de establecimiento no válido.' });
    try {
        const candidatos = await lugares.buscarAhora(id, String((req.body || {}).texto || '').slice(0, 200));
        if (candidatos === null) return res.status(404).json({ error: `No existe el establecimiento ${id}.` });
        res.json({ candidatos });
    } catch (err) {
        res.status(err.estado || 502).json({ error: err.temporal ? 'Google no responde ahora mismo.' : err.message });
    }
};

exports.elegirLugar = (req, res) => {
    const id = idDeParam(req.params.id);
    const placeId = String((req.body || {}).place_id || '');
    if (!id || !placeId) return res.status(400).json({ error: 'Falta el establecimiento o el sitio.' });
    const final = lugares.elegir(id, placeId);
    if (!final) return res.status(404).json({ error: 'Ese sitio no está entre los candidatos.' });
    res.json({ resultado: final === id ? 'verificado' : 'unido', establecimiento: STMT_EST_POR_ID.get(final) });
};

exports.descartarLugar = (req, res) => {
    const id = idDeParam(req.params.id);
    if (!id || !lugares.descartar(id)) return res.status(404).json({ error: 'No existe ese establecimiento.' });
    res.json({ resultado: 'descartado', establecimiento: STMT_EST_POR_ID.get(id) });
};

exports.obtenerTicket = (req, res) => {
    const id = idDeParam(req.params.id);
    if (id === null) {
        return res.status(400).json({ error: 'El id tiene que ser un número entero.' });
    }
    const fila = filaParaCliente(id);
    if (!fila) {
        return res.status(404).json({ error: `No existe ningún tiquet con id ${id}.` });
    }
    res.json(fila);
};

// --- PUT /api/tickets/:id --------------------------------------------------

// PUT /api/tickets/:id/compartido — solo entre cuántos y mi parte. Es lo que
// usa la pregunta de los comensales: no toca nada más del tiquet.
exports.ponerCompartido = (req, res) => {
    const id = Number(req.params.id);
    const cuerpo = req.body || {};
    const n = Number(cuerpo.compartido_entre);
    const entre = Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
    const p = entre > 1 && cuerpo.mi_parte_centimos != null && cuerpo.mi_parte_centimos !== ''
        ? Number(cuerpo.mi_parte_centimos) : null;
    if (p !== null && (!Number.isInteger(p) || p < 0)) {
        return res.status(422).json({ error: 'Mi parte tiene que ser un importe positivo.' });
    }
    const r = STMT_COMPARTIDO.run({ id, compartido_entre: entre, mi_parte_centimos: p });
    if (!r.changes) return res.status(404).json({ error: 'Ese tiquet no existe.' });
    res.json({ ok: true });
};

exports.editarTicket = (req, res) => {
    const id = idDeParam(req.params.id);
    if (id === null) {
        return res.status(400).json({ error: 'El id tiene que ser un número entero.' });
    }

    const fila = STMT_OBTENER_FILA.get(id);
    if (!fila) {
        return res.status(404).json({ error: `No existe ningún tiquet con id ${id}.` });
    }

    const cuerpo = req.body || {};
    // El establecimiento llega anidado desde el formulario; se aceptan también
    // los campos planos por comodidad al probar con curl.
    const est = cuerpo.establecimiento || {};

    // Se construye un objeto con LA MISMA FORMA que devuelve la IA, para poder
    // pasarlo por validarDatosExtraidos sin una segunda capa de validación que
    // acabaría divergiendo de la primera.
    const entrada = {
        tipo_documento:         cuerpo.tipo_documento,
        categoria:              cuerpo.categoria,
        nombre_establecimiento: est.nombre        ?? cuerpo.nombre_establecimiento,
        direccion:              est.direccion     ?? cuerpo.direccion,
        ciudad:                 est.ciudad        ?? cuerpo.ciudad,
        codigo_postal:          est.codigo_postal ?? cuerpo.codigo_postal,
        lugar_inferido:         est.lugar_inferido ?? cuerpo.lugar_inferido,
        fecha_compra:           cuerpo.fecha_compra,
        fecha_evento:           cuerpo.fecha_evento,
        // null y 0 siguen siendo distintos aquí: el formulario manda null cuando
        // el campo de euros está vacío (documento sin importe) y 0 cuando pone
        // "0" (importe cero impreso).
        total_centimos:         cuerpo.total_centimos,
        moneda:                 cuerpo.moneda,
        metodo_pago:            cuerpo.metodo_pago,
        items:                  cuerpo.items,
        detalles:               detallesComoPares(cuerpo.detalles)
    };

    // Coordenadas pegadas a mano, antes de tocar nada: si no se entienden, se
    // rechaza la edición entera. En una edición manual nada se descarta en
    // silencio, y unas coordenadas mal pegadas colocarían el comercio en medio
    // del mar sin que nadie se enterase hasta mirar el mapa.
    const coordenadasPedidas = est.coordenadas ?? cuerpo.coordenadas;
    let accionCoordenadas = null;        // null | 'limpiar' | texto a fijar
    if (coordenadasPedidas !== undefined) {
        const texto = String(coordenadasPedidas).trim();
        if (texto === '') {
            // Vaciar el campo devuelve el establecimiento al circuito automático.
            accionCoordenadas = 'limpiar';
        } else if (!parsearCoordenadas(texto)) {
            return res.status(422).json({
                resultado: 'rechazado',
                error: 'Las coordenadas no se entienden. Pega las dos cifras tal y como ' +
                       'las copias del mapa, por ejemplo "41.0123, 0.9876". La latitud va ' +
                       'entre -90 y 90, y la longitud entre -180 y 180.',
                descartados: [{ campo: 'coordenadas', valor: texto, motivo: 'formato o rango' }]
            });
        } else {
            accionCoordenadas = texto;
        }
    }

    // Tiquet compartido: entre cuántos y, si no fue a partes iguales, mi parte.
    // Solo se toca si el formulario lo manda.
    let compartido = null;
    if (cuerpo.compartido_entre !== undefined || cuerpo.mi_parte_centimos !== undefined) {
        const n = Number(cuerpo.compartido_entre);
        // 1 = revisado y pagado solo por mí (no vuelve a preguntarse); null = sin mirar.
        const entre = Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
        const p = cuerpo.mi_parte_centimos === null || cuerpo.mi_parte_centimos === '' ||
                  cuerpo.mi_parte_centimos === undefined ? null : Number(cuerpo.mi_parte_centimos);
        if (p !== null && (!Number.isInteger(p) || p < 0)) {
            return res.status(422).json({ resultado: 'rechazado', error: 'Mi parte tiene que ser un importe positivo.' });
        }
        compartido = { compartido_entre: entre, mi_parte_centimos: entre > 1 ? p : null };
    }

    const { datos, descartados, camposNulos } = validarDatosExtraidos(entrada);

    // Aquí está la única diferencia con la extracción: no se descarta en
    // silencio. Si algo de lo que he escrito no pasa la validación, quiero
    // saberlo y arreglarlo, no descubrir un hueco más tarde.
    if (descartados.length > 0) {
        registrarDescartes(descartados, `edición manual del ticket ${id}`);
        return res.status(422).json({
            resultado: 'rechazado',
            error: 'Hay campos que no se pueden guardar tal como están escritos.',
            descartados
        });
    }

    const norm = normalizarDatos(datos, camposNulos);

    // Ausencias confirmadas a mano. Un documento puede legítimamente no imprimir
    // importe (la ENTRADA de un parking) o fecha (un billete ya validado); con la
    // casilla marcada la fila deja de ser 'incompleto' SIN que se invente un 0 ni
    // una fecha. ajustarAusenciasConfirmadas garantiza el invariante: si hay valor,
    // manda el valor y la bandera se limpia.
    const ausencias = ajustarAusenciasConfirmadas({
        totalCentimos: norm.total_centimos,
        fechaCanonica: canonizarFecha(norm.fecha_compra),
        sinImporte:    cuerpo.sin_importe,
        sinFecha:      cuerpo.sin_fecha
    });

    const establecimientoAnterior = fila.establecimiento_id;

    // Los establecimientos que hay que volver a geocodificar se apuntan dentro de
    // la transacción y se encolan DESPUÉS: si la transacción se deshace por una
    // colisión de clave, la dirección nueva nunca llegó a guardarse y pedirle
    // coordenadas a Nominatim sería gastar una petición por una dirección que no
    // existe en la base.
    const regeocodificar = [];
    // Lo mismo para los establecimientos que se dan de alta aquí dentro: se
    // apuntan y se encolan al confirmar, nunca durante la transacción.
    const aGeocodificar = [];
    // El id del establecimiento al que acaba apuntando el tiquet; se necesita
    // fuera de la transacción para aplicar las coordenadas manuales.
    let establecimientoFinal = null;

    // Todo dentro de una transacción, incluida la comprobación de colisión.
    // Hace falta porque para calcular la clave se necesita el id del
    // establecimiento, y para tenerlo hay que haberlo creado ya. Si después
    // descubrimos la colisión y respondemos "no se ha guardado nada", ese
    // establecimiento nuevo (o la dirección reescrita) sería una mentira. Lanzar
    // desde dentro hace que better-sqlite3 deshaga la transacción completa.
    let estado;
    try {
        estado = db.transaction(() => {
            // El establecimiento se resuelve por nombre: si lo he cambiado, el
            // tiquet pasa a apuntar a otro (creándolo si no existía). Lo que haya
            // que geocodificar se apunta y se encola al confirmar.
            const establecimientoId = upsertEstablecimiento(
                datos, aGeocodificar, idDeParam(est.id) || establecimientoAnterior);
            const verificado = db.prepare('SELECT place_id FROM establecimientos WHERE id = ?')
                .get(establecimientoId).place_id;

            // Si la dirección cambia, las coordenadas que hubiera apuntan a otro
            // sitio: hay que volver a preguntar. Se compara ANTES de escribir,
            // porque después ya no se sabría si ha cambiado algo, y se compara
            // sobre los valores ya normalizados (titleCase), que son los que se
            // guardan: si no, un cambio de mayúsculas contaría como dirección
            // nueva y gastaría una petición a Nominatim para nada.
            const antes = STMT_DIRECCION_EST.get(establecimientoId) || {};
            const nueva = {
                direccion:      titleCase(datos.direccion),
                ciudad:         titleCase(datos.ciudad),
                codigo_postal:  datos.codigo_postal || null,
                // El país no pasa por la validación de la IA: lo escribo yo.
                pais:           titleCase(String(est.pais ?? cuerpo.pais ?? '').trim().slice(0, 60)) || null,
                lugar_inferido: titleCase(datos.lugar_inferido)
            };
            // El lugar deducido cuenta como "la dirección ha cambiado": es de
            // donde salen las coordenadas cuando no hay dirección.
            const direccionCambiada =
                antes.direccion      !== nueva.direccion ||
                antes.ciudad         !== nueva.ciudad ||
                antes.codigo_postal  !== nueva.codigo_postal ||
                (antes.pais ?? null) !== nueva.pais ||
                (antes.lugar_inferido ?? null) !== nueva.lugar_inferido;

            establecimientoFinal = establecimientoId;
            // Verificado en Google: la dirección es la de Google y se cambia en la
            // ficha del establecimiento, no desde un tiquet.
            if (!verificado) {
                STMT_ACTUALIZAR_EST.run({ id: establecimientoId, ...nueva });
                // Si en esta misma edición se pegan coordenadas a mano, no tiene
                // sentido encolar una geocodificación que no va a poder tocarlas.
                if (direccionCambiada && !accionCoordenadas) regeocodificar.push(establecimientoId);
            }

            const derivadas = derivarColumnas(norm, establecimientoId);

            // Estado recalculado: una fila que estaba 'incompleto' (o 'pendiente',
            // si la he rellenado a mano) pasa a 'procesado' en cuanto tiene total
            // y fecha.
            const estadoNuevo = calcularEstado({
                totalCentimos: norm.total_centimos,
                fechaCanonica: derivadas.fechaCanonica,
                sinImporte:    ausencias.sinImporte,
                sinFecha:      ausencias.sinFecha
            });

            // La clave puede haber cambiado (fecha o total editados) y chocar con
            // otra fila. No se guarda: devolver el id con el que colisiona permite
            // decidir —borrar el otro, o corregir este— con la información delante.
            if (derivadas.claveTiquet) {
                const choque = STMT_COLISION_CLAVE.get(derivadas.claveTiquet, id);
                if (choque) {
                    const err = new Error('colision de clave_tiquet');
                    err.colision = choque;
                    err.clave = derivadas.claveTiquet;
                    throw err;
                }
            }

            STMT_UPDATE_DATOS.run(filaDeDatos({
                id, norm, establecimientoId, derivadas, estado: estadoNuevo, ausencias
            }));
            if (compartido) STMT_COMPARTIDO.run({ id, ...compartido });

            // Si el tiquet ha cambiado de establecimiento, el anterior puede
            // haberse quedado sin ninguno.
            if (establecimientoAnterior && establecimientoAnterior !== establecimientoId) {
                borrarEstablecimientoSiHuerfano(establecimientoAnterior);
            }

            return estadoNuevo;
        })();
    } catch (err) {
        if (!err || !err.colision) throw err;
        return res.status(409).json({
            resultado: 'colision',
            error: `Con esos datos este tiquet sería el mismo que el id ${err.colision.id} ` +
                   `(mismo establecimiento, fecha e importe). No se ha guardado nada.`,
            id_colision: err.colision.id,
            estado_colision: err.colision.estado,
            clave_tiquet: err.clave
        });
    }

    // Las coordenadas manuales se aplican FUERA de la transacción, igual que el
    // reencolado: si la edición se deshizo por una colisión de clave, no hay
    // establecimiento al que ponérselas.
    // El formulario manda siempre las coordenadas: si son las que ya tenía, no
    // es que las haya puesto a mano.
    if (accionCoordenadas && establecimientoFinal) {
        const ahora = db.prepare('SELECT latitud, longitud FROM establecimientos WHERE id = ?').get(establecimientoFinal);
        const punto = accionCoordenadas === 'limpiar' ? null : parsearCoordenadas(accionCoordenadas);
        const igual = punto
            ? ahora.latitud !== null && Math.abs(ahora.latitud - punto.latitud) < 1e-6 &&
              Math.abs(ahora.longitud - punto.longitud) < 1e-6
            : ahora.latitud === null;
        if (igual) accionCoordenadas = null;
    }
    if (accionCoordenadas && establecimientoFinal) {
        if (accionCoordenadas === 'limpiar') {
            geo.limpiarCoordenadasManuales(establecimientoFinal);
            console.log(`🗺️  Coordenadas manuales borradas del establecimiento ${establecimientoFinal}.`);
        } else {
            const punto = geo.fijarCoordenadasManuales(establecimientoFinal, accionCoordenadas);
            console.log(`🗺️  Coordenadas a mano para el establecimiento ${establecimientoFinal}: ` +
                        `${punto.latitud}, ${punto.longitud}.`);
        }
    }

    encolarGeocodificacion(aGeocodificar);
    for (const idEst of regeocodificar) { geo.marcarParaRegeocodificar(idEst); lugares.marcarPendiente(idEst); }

    // Sitio elegido en el buscador de Google del editor: el establecimiento
    // queda verificado con él (o se une al que ya lo tenía, tiquet incluido).
    if (est.place_id && establecimientoFinal) {
        const final = lugares.aplicarPlaceId(establecimientoFinal, String(est.place_id));
        if (final) console.log(`📍 Ticket ${id}: establecimiento ${final} verificado desde el editor.`);
    }

    console.log(`✏️  Ticket ${id} editado a mano. Estado: ${fila.estado} → ${estado}.`);

    return res.json({
        resultado: 'actualizado',
        id,
        estado,
        estado_anterior: fila.estado,
        ticket: filaParaCliente(id)
    });
};

// --- DELETE /api/tickets/:id -----------------------------------------------

exports.borrarTicket = (req, res) => {
    const id = idDeParam(req.params.id);
    if (id === null) {
        return res.status(400).json({ error: 'El id tiene que ser un número entero.' });
    }

    const fila = STMT_OBTENER_FILA.get(id);
    if (!fila) {
        return res.status(404).json({ error: `No existe ningún tiquet con id ${id}.` });
    }

    // Orden: primero la base, luego el archivo. Si el unlink falla nos queda una
    // imagen suelta en uploads/ (molesto pero inofensivo); al revés tendríamos
    // una fila apuntando a una foto que ya no existe.
    let establecimientoBorrado = null;
    let fotoLibre = false;
    db.transaction(() => {
        STMT_BORRAR_TICKET.run(id);
        establecimientoBorrado = borrarEstablecimientoSiHuerfano(fila.establecimiento_id);
        // Si la foto tenía varios tiquets, las filas que quedan siguen
        // necesitándola: se renumeran y el archivo NO se borra.
        fotoLibre = liberarFoto(fila.ruta_imagen);
    })();

    const imagenBorrada = fotoLibre ? borrarImagenDeDisco(fila.ruta_imagen) : false;
    const hermanas = fotoLibre ? 0 : STMT_FILAS_DE_LA_FOTO.all(fila.ruta_imagen).length;

    console.log(
        `🗑️  Ticket ${id} borrado (imagen ${imagenBorrada ? 'borrada' : (fotoLibre ? 'no encontrada' : 'conservada: compartida')}).`
    );

    let mensaje;
    if (!fotoLibre) {
        mensaje = `Tiquet borrado. La foto se conserva porque la comparten otros ${hermanas} ` +
                  `tiquet(s) de la misma imagen.`;
    } else if (imagenBorrada) {
        mensaje = 'Tiquet y foto borrados.';
    } else {
        mensaje = 'Tiquet borrado. La foto ya no estaba en el disco.';
    }

    return res.json({
        resultado: 'borrado',
        id,
        imagen_borrada: imagenBorrada,
        imagen_compartida: !fotoLibre,
        tiquets_restantes_en_la_foto: hermanas,
        establecimiento_borrado: establecimientoBorrado,
        mensaje
    });
};

// --- POST /api/tickets/:id/reintentar --------------------------------------

// Estados que tiene sentido reintentar: la imagen está guardada pero la IA no
// llegó a darnos datos.
const ESTADOS_REINTENTABLES = new Set(['pendiente', 'error']);

exports.reintentarTicket = async (req, res) => {
    const id = idDeParam(req.params.id);
    if (id === null) {
        return res.status(400).json({ error: 'El id tiene que ser un número entero.' });
    }

    const fila = STMT_OBTENER_FILA.get(id);
    if (!fila) {
        return res.status(404).json({ error: `No existe ningún tiquet con id ${id}.` });
    }

    // Una fila YA leída también se puede volver a analizar, pero hay que pedirlo
    // a propósito con `forzar`: se sustituyen los datos extraídos y con ellos
    // cualquier corrección hecha a mano. Sirve para releer tiquets antiguos con
    // un prompt nuevo (el lugar deducido, por ejemplo) o para comparar modelos.
    // Sin `forzar`, el 409 de siempre: protege de un clic accidental y de un
    // cliente viejo que no sepa de esto.
    const forzar = esVerdadero(req.body && req.body.forzar);
    if (!ESTADOS_REINTENTABLES.has(fila.estado) && !forzar) {
        return res.status(409).json({
            resultado: 'no_reintentable',
            error: `El tiquet ${id} está en estado '${fila.estado}': ya tiene datos extraídos. ` +
                   `Para volver a leerlo hay que pedirlo con forzar=true, y eso sustituye ` +
                   `los datos (incluidas las correcciones manuales).`,
            estado: fila.estado
        });
    }

    const enDisco = rutaEnDisco(fila.ruta_imagen);
    if (!enDisco || !fs.existsSync(enDisco)) {
        return res.status(409).json({
            resultado: 'sin_imagen',
            error: `La imagen del tiquet ${id} no está en el disco (${fila.ruta_imagen}), ` +
                   `así que no hay nada que reprocesar. Bórralo y vuelve a subir la foto.`,
            estado: fila.estado
        });
    }

    // Mismo parámetro opcional que la subida: reintentar con otro modelo es
    // justo para lo que sirve tener varios, así que el selector gobierna las dos
    // puertas por las que una foto pasa por la IA.
    const pedido = modoPedido(req);
    if (pedido.error) {
        return res.status(400).json({ error: pedido.error });
    }

    // Las filas que salieron de ESTA foto. La IA va a leer la imagen completa,
    // así que el reintento afecta a todas: se actualizan emparejadas por
    // indice_en_foto.
    const hermanasDeLaFoto = fila.hash_imagen ? STMT_BUSCAR_POR_HASH.all(fila.hash_imagen) : [];

    let respuesta;
    let modeloUsado = null;
    let intentosIA = [];
    try {
        const imageBuffer = fs.readFileSync(enDisco);
        console.log(`🔁 Reintentando el ticket ${id} (${path.basename(enDisco)}) en modo '${pedido.modo}'...`);
        const salida = await analizarTicket(imageBuffer, mimeDeArchivo(enDisco), {
            modo: pedido.modo,
            nombre: path.basename(enDisco)
        });
        respuesta   = salida.tiquets;
        modeloUsado = salida.modelo;
        intentosIA  = resumirIntentosIA(salida.intentos);
    } catch (error) {
        return manejarFalloDeReintento(error, id, fila, res);
    }

    // Desde aquí, exactamente el mismo camino que una subida normal: el mismo
    // validarLoteExtraido y el mismo guardarLote. Si la foto que quedó pendiente
    // resulta tener varios tiquets, se reaprovecha esta fila para el primero y se
    // insertan las demás, que comparten el archivo y el hash.
    const { tiquets, descartados: descartadosDelLote } = validarLoteExtraido(respuesta);
    registrarDescartes(descartadosDelLote, `reintento del ticket ${id}`);

    if (tiquets.length === 0) {
        // La foto no contiene nada reconocible. La fila se queda, vacía y marcada
        // para revisar, en vez de seguir diciendo 'pendiente' para siempre. El
        // modelo sí se anota: ha leído la foto y ha dicho que no hay nada.
        STMT_ACTUALIZAR_MODELO.run(modeloUsado, id);
        STMT_ACTUALIZAR_ESTADO.run('incompleto', id);
        return res.status(200).json({
            resultado: 'sin_tiquets',
            id,
            estado: 'incompleto',
            estado_anterior: fila.estado,
            mensaje: 'La IA no ha reconocido ningún tiquet en esa foto. La ficha queda para ' +
                     'rellenar a mano o borrar.',
            modelo_usado: modeloUsado,
            intentos_ia: intentosIA,
            descartados: descartadosDelLote,
            ticket: filaParaCliente(id)
        });
    }

    const establecimientoAnterior = fila.establecimiento_id;

    // Reanalizar un tiquet de una foto con varios reanaliza LA FOTO ENTERA: la
    // IA lee la imagen completa y devuelve sus N documentos, así que lo que hay
    // que hacer con esas N lecturas es actualizar las N filas que ya existen,
    // emparejadas por indice_en_foto. Insertarlas como nuevas era lo que
    // rompía con "UNIQUE constraint failed: tickets.hash_imagen,
    // tickets.indice_en_foto": los índices ya estaban ocupados por las hermanas.
    const filasPorIndice = new Map(
        hermanasDeLaFoto.map(f => [f.indice_en_foto, f.id])
    );

    const { filas, repetidas, total, sobrantes } = guardarLote(tiquets, {
        hash:              fila.hash_imagen,
        rutaImagenUrl:     fila.ruta_imagen,
        referencia:        `reintento del ticket ${id}`,
        modeloUsado,
        idFilaBase:        id,
        filasPorIndice,
        // Nunca: reemplazar in-place significa entregarle esta foto a OTRA fila, y
        // aquí la foto ya tiene dueño (esta fila). Un duplicado se marca, no se
        // fusiona.
        permitirReemplazo: false
    });

    // El establecimiento que tuviera antes puede haberse quedado sin tiquets si la
    // nueva lectura apunta a otro. borrarEstablecimientoSiHuerfano no hace nada si
    // alguna otra fila (una hermana de esta misma foto, por ejemplo) sigue usándolo.
    if (establecimientoAnterior) {
        const actual = STMT_OBTENER_FILA.get(id);
        if (!actual || actual.establecimiento_id !== establecimientoAnterior) {
            borrarEstablecimientoSiHuerfano(establecimientoAnterior);
        }
    }

    const propia   = filas.find(f => f.id === id) || filas[0];
    const hermanas = filas.filter(f => f.id !== id);
    const nuevas   = hermanas.filter(f => !filasPorIndice.has(f.indice_en_foto));
    const colision = propia.resultado === 'duplicado_marcado' ? propia.id_similar : null;

    console.log(
        `✅ Ticket ${id} reprocesado con '${modeloUsado}'. Estado: ${fila.estado} → ${propia.estado}.` +
        (hermanas.length ? ` Se han actualizado ${hermanas.length} hermana(s) de la misma foto.` : '') +
        (nuevas.length ? ` ${nuevas.length} fila(s) nueva(s).` : '')
    );

    const avisos = [];
    if (colision) {
        avisos.push(
            `Coincide con el tiquet ${colision} (mismo establecimiento, fecha e importe). ` +
            `Los datos se han guardado y la fila queda marcada para revisar: comprueba si es ` +
            `un duplicado y bórralo.`
        );
    }
    if (hermanas.length) {
        avisos.push(
            `La foto contiene ${total} tiquets: se han vuelto a analizar todos y las fichas ` +
            `quedan marcadas para revisar.` +
            (nuevas.length ? ` ${nuevas.length} de ellas son nuevas.` : '')
        );
    }
    if (sobrantes.length) {
        avisos.push(
            `La relectura ha encontrado menos tiquets que fichas tenía la foto: ` +
            `${sobrantes.join(', ')} se conservan, marcadas para revisar, en vez de borrarlas.`
        );
    }
    if (repetidas.length) {
        avisos.push(`Se han descartado ${repetidas.length} lectura(s) repetida(s) del mismo papel.`);
    }

    return res.json({
        resultado: avisos.length ? 'reintentado_con_aviso' : 'reintentado',
        id,
        estado: propia.estado,
        estado_anterior: fila.estado,
        mensaje: avisos.length ? avisos.join(' ') : 'Tiquet reprocesado correctamente.',
        id_colision: colision,
        total_en_foto: total,
        modelo_usado: modeloUsado,
        intentos_ia: intentosIA,
        ids: filas.map(f => f.id),
        filas,
        descartados: [...descartadosDelLote, ...propia.descartados],
        ticket: filaParaCliente(id)
    });
};

/**
 * Un reintento que vuelve a fallar. Mismo criterio de clasificación que la
 * subida (PLAN_POR_TIPO), con una diferencia obligada: aquí la imagen NUNCA se
 * borra, ni siquiera en un fallo permanente. En la subida se podía borrar porque
 * no había fila que la referenciase; aquí sí la hay, y dejarla apuntando a un
 * archivo inexistente haría el tiquet irrecuperable.
 */
function manejarFalloDeReintento(error, id, fila, res) {
    const esDeIA = Boolean(error) &&
        (typeof error.tipo === 'string' || error instanceof ErrorIA);
    const tipo = esDeIA ? error.tipo : 'permanente';
    const plan = PLAN_POR_TIPO[tipo] || PLAN_POR_TIPO.permanente;

    // 'permanente' no tiene estado propio en PLAN_POR_TIPO porque en la subida
    // implicaba no guardar fila. En un reintento la fila existe: se queda en
    // 'error', que es el estado de "hay que mirar esto".
    const estado = plan.estado || 'error';

    STMT_ACTUALIZAR_ESTADO.run(estado, id);

    const mensaje = esDeIA && error.mensaje
        ? error.mensaje
        : 'Error al reprocesar el tiquet.';

    console.error(`❌ Reintento del ticket ${id} fallido [tipo=${tipo}]:`, error && (error.causa || error));

    return res.status(plan.http).json({
        resultado: 'fallo',
        tipo,
        status_api: esDeIA ? error.status : null,
        id,
        estado,
        estado_anterior: fila.estado,
        error: `${mensaje} La foto sigue guardada: se puede volver a reintentar.`
    });
}
