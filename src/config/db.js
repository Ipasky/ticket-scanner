const Database = require('better-sqlite3');
const path = require('path');

// Ruta absoluta al fichero SQLite. Si no existe, se crea.
// TICKETS_DB_PATH permite apuntar a otra base: las pruebas de los endpoints la
// usan para trabajar sobre una base temporal y no tocar nunca la real.
const dbPath = process.env.TICKETS_DB_PATH
    ? path.resolve(process.env.TICKETS_DB_PATH)
    : path.join(__dirname, '../../database/tickets.db');
const db = new Database(dbPath);

// Rendimiento razonable y foreign keys activas.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Versión del esquema que este código sabe manejar. Se guarda dentro del propio
// fichero SQLite (PRAGMA user_version), no en una tabla.
const SCHEMA_VERSION = 12;

// --- ESQUEMA -----------------------------------------------------------------
// Dos tablas: establecimientos (dimensión) y tickets (hechos).
// El grueso de la variabilidad entre tipos de documento vive en detalles TEXT
// (JSON), para no tener que añadir columnas cada vez que aparece un tipo nuevo.
const schema = `
    CREATE TABLE IF NOT EXISTS establecimientos (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        -- Normalizado en MAYÚSCULAS. NO es único: dos Mercadona de ciudades
        -- distintas son dos establecimientos. Lo que identifica un sitio de
        -- verdad es place_id.
        nombre          TEXT    NOT NULL,
        direccion       TEXT,
        ciudad          TEXT,
        codigo_postal   TEXT,
        -- País, cuando no es el de GEO_PAIS (una tienda de Londres no se
        -- encuentra buscando "..., España"). NULL = el país por defecto.
        pais            TEXT,

        -- NOMBRE de lugar deducido del documento cuando el papel NO trae
        -- dirección: "Montserrat" en un tiquet del Patronat de la Muntanya de
        -- Montserrat, "Aeropuerto de Barcelona" en una consumición de la T1.
        -- Nunca coordenadas, y SEPARADO de direccion: lo dice el modelo a partir
        -- del contenido, no está impreso, y mezclarlo con la dirección real
        -- haría imposible saber después qué se leyó y qué se dedujo.
        lugar_inferido  TEXT,
        -- COORDENADAS, para el mapa del panel de finanzas.
        -- Las rellena services/geocodificacion.js preguntando a Nominatim
        -- (OpenStreetMap) en segundo plano. NUNCA durante una subida.
        latitud         REAL,
        longitud        REAL,

        -- Estado de la geocodificación. Existe para no volver a preguntar:
        --   pendiente  nadie lo ha intentado todavía (o la dirección ha cambiado)
        --   ok         resuelto; sus coordenadas ya están. No se vuelve a pedir
        --   fallido    Nominatim no lo encontró. Tampoco se reintenta en bucle:
        --              una dirección que no existe no va a aparecer sola
        --   sin_datos  no hay dirección ni ciudad que preguntar
        -- La política de uso de Nominatim pide exactamente esto: cachear y no
        -- repetir peticiones que ya se sabe cómo acaban.
        geo_estado      TEXT NOT NULL DEFAULT 'pendiente',
        geo_intentado_at DATETIME,
        geo_mensaje     TEXT,                           -- por qué falló, para mirarlo

        -- CON CUÁNTA PRECISIÓN se ha situado. La búsqueda es escalonada: si la
        -- dirección completa no se encuentra, se prueba la calle, luego el
        -- código postal y por último la localidad. Un punto en el centro del
        -- pueblo es útil para el mapa, pero hay que poder decir que es
        -- aproximado en vez de fingir que es la puerta del comercio.
        --   exacta     la dirección completa
        --   calle      la calle sin número
        --   zona       código postal + localidad
        --   localidad  solo la localidad
        --   manual     coordenadas pegadas a mano. NUNCA se sobrescriben
        geo_precision   TEXT,

        -- GOOGLE PLACES (services/lugares.js). place_id es el identificador
        -- estable del sitio en Google: dos establecimientos con el mismo son el
        -- mismo y se unen solos.
        --   pendiente       por preguntar
        --   verificado      Google lo ha encontrado sin dudas (o lo elegí yo)
        --   por_confirmar   hay candidatos y hay que elegir (google_candidatos)
        --   sin_resultados  Google no lo conoce: se queda con lo de Nominatim
        --   descartado      dije que no era ninguno de los candidatos
        place_id              TEXT,
        google_estado         TEXT NOT NULL DEFAULT 'pendiente',
        google_nombre         TEXT,
        google_direccion      TEXT,
        google_candidatos     TEXT,      -- JSON, solo mientras está por confirmar
        google_actualizado_at DATETIME,

        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Otros nombres con los que llega el mismo establecimiento ("ABACUS SCCL"
    -- para ABACUS). Se apuntan al unir y al renombrar con el nombre de Google,
    -- para que el siguiente tiquet vaya directo al sitio bueno.
    CREATE TABLE IF NOT EXISTS establecimiento_alias (
        nombre             TEXT    NOT NULL,
        establecimiento_id INTEGER NOT NULL REFERENCES establecimientos(id) ON DELETE CASCADE,
        PRIMARY KEY (nombre, establecimiento_id)
    );

    CREATE TABLE IF NOT EXISTS tickets (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,

        -- CLASIFICACIÓN (texto libre normalizado en MAYÚSCULAS, no enum cerrado)
        -- NULLABLE: cuando la extracción ni siquiera llegó a ejecutarse (503 de
        -- Gemini, cuota agotada, clave mal configurada) guardamos la fila con
        -- estado pendiente/error y sin inventarnos un tipo de documento.
        tipo_documento      TEXT,
        categoria           TEXT,

        -- ESTABLECIMIENTO (FK)
        establecimiento_id  INTEGER REFERENCES establecimientos(id),

        -- FECHAS ISO
        fecha_compra        TEXT,                       -- YYYY-MM-DD [HH:MM:SS]
        fecha_evento        TEXT,                       -- opcional (entradas/reservas)

        -- IMPORTES
        -- Céntimos enteros, nunca decimales. NULLABLE a propósito: si el modelo no
        -- consigue leer el total preferimos NULL + estado='incompleto' antes que un
        -- 0 inventado, que se confundiría con un tiquet legítimo de importe cero.
        total_centimos      INTEGER,
        moneda              TEXT    DEFAULT 'EUR',
        -- El importe en EUROS cuando la moneda es otra, con el cambio del día de
        -- la compra (BCE, vía Frankfurter). Lo rellena services/divisas.js en
        -- segundo plano; NULL mientras no se ha podido convertir. El importe
        -- original NO se toca: es lo que dice el papel.
        total_eur_centimos  INTEGER,
        tasa_eur            REAL,

        -- TIQUET COMPARTIDO: el total del papel no se toca; lo que cuenta en
        -- las estadísticas es MI parte. compartido_entre = cuántos éramos
        -- (NULL o 1 = no compartido). mi_parte_centimos = lo que pagué yo, en la
        -- moneda del tiquet, si no fue a partes iguales (NULL = total / N).
        compartido_entre    INTEGER,
        mi_parte_centimos   INTEGER,
        metodo_pago         TEXT,

        -- DATOS FLEXIBLES
        items               TEXT,                       -- JSON: [{producto, cantidad, precio_centimos}]
        detalles            TEXT,                       -- JSON: {clave: valor} específicos del tipo

        -- ARCHIVO / DEDUPE
        -- Una foto puede contener VARIOS tiquets, así que el archivo (y su hash)
        -- ya no identifica una fila: identifica una foto. Lo que identifica la
        -- fila es el par (hash_imagen, indice_en_foto).
        ruta_imagen         TEXT,
        hash_imagen         TEXT,                       -- SHA-256 del archivo subido
        indice_en_foto      INTEGER DEFAULT 0,          -- 0..N-1, orden de lectura dentro de la foto
        total_en_foto       INTEGER DEFAULT 1,          -- cuántos tiquets se extrajeron de esa foto
        -- Coordenadas aproximadas del tiquet dentro de la foto, en fracciones
        -- 0..1: {"x":..,"y":..,"ancho":..,"alto":..}. NULL si el modelo no las da.
        -- SOLO sirve para pintar un marco encima de la foto al revisarla. El
        -- archivo NUNCA se recorta: se guarda entero y compartido por las N filas.
        recuadro            TEXT,
        clave_tiquet        TEXT,                       -- establecimiento_id|fecha[+hora]|total_centimos
        hora_conocida       INTEGER NOT NULL DEFAULT 0, -- 1 si fecha_compra trae hora explícita

        -- AUSENCIAS CONFIRMADAS A MANO
        -- Hay documentos que legítimamente NO imprimen importe (la ENTRADA de un
        -- parking, que se paga a la salida) ni fecha (un billete ya validado). Sin
        -- esto se quedaban en 'incompleto' para siempre y la marca ámbar perdía su
        -- significado: si un tercio de las filas está permanentemente en ámbar, el
        -- ámbar ya no avisa de nada.
        --
        -- 1 = YO he revisado el documento y confirmo que ese dato no está impreso.
        -- Solo lo pone una edición manual: el modelo no puede confirmar una
        -- ausencia, únicamente no encontrar el dato, que es otra cosa.
        --
        -- Invariante: sin_importe = 1 implica total_centimos IS NULL, y
        -- sin_fecha = 1 implica fecha_compra IS NULL. Confirmar una ausencia NO
        -- inventa un 0 ni una fecha, y tampoco genera clave_tiquet: sin importe no
        -- hay con qué comparar duplicados.
        sin_importe         INTEGER NOT NULL DEFAULT 0,
        sin_fecha           INTEGER NOT NULL DEFAULT 0,

        -- ESTADO
        -- procesado  = extracción completa y usable
        -- incompleto = hay que mirarlo a mano: falta total o fecha_compra, o
        --              viene de una foto con varios tiquets (total_en_foto > 1),
        --              que siempre se revisa aunque la lectura parezca completa.
        -- pendiente  = la IA no respondió por un fallo temporal o por cuota
        --              agotada. La imagen está guardada; se puede reintentar.
        -- error      = fallo que hay que resolver fuera: configuración de la API
        --              (clave o modelo), o una foto con demasiados tiquets para
        --              una sola respuesta. La imagen está guardada.
        estado              TEXT    NOT NULL DEFAULT 'procesado', -- procesado|incompleto|pendiente|error

        -- QUÉ MODELO LA LEYÓ
        -- Nombre del modelo de Gemini que extrajo ESTOS datos. Sirve para
        -- comparar calidad entre modelos con tiquets propios, que es la única
        -- comparación que vale: los benchmarks no usan mis fotos arrugadas.
        --
        -- NULL significa "nadie lo ha leído todavía o no se sabe": las filas
        -- pendientes/error que se guardaron sin extracción, y las que existían
        -- antes de esta columna. No se rellena con un valor por defecto: inventar
        -- el nombre de un modelo que quizá no leyó esa fila envenenaría justo la
        -- comparación para la que existe la columna.
        --
        -- Las N filas de una misma foto comparten valor, porque las ha leído una
        -- sola llamada. Una edición manual NO lo cambia: sigue siendo cierto que
        -- ese modelo hizo la lectura de la que se partió.
        modelo_usado        TEXT,

        -- SISTEMA
        created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- La cola de geocodificación pregunta siempre por este campo.
    CREATE INDEX IF NOT EXISTS idx_establecimientos_geo    ON establecimientos(geo_estado);
    CREATE INDEX IF NOT EXISTS idx_establecimientos_nombre ON establecimientos(nombre);
    CREATE INDEX IF NOT EXISTS idx_establecimientos_google ON establecimientos(google_estado);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_establecimientos_place
        ON establecimientos(place_id) WHERE place_id IS NOT NULL;

    -- Búsquedas frecuentes.
    CREATE INDEX IF NOT EXISTS idx_tickets_fecha_compra    ON tickets(fecha_compra);
    -- Las estadísticas agrupan por establecimiento y por categoría.
    CREATE INDEX IF NOT EXISTS idx_tickets_establecimiento ON tickets(establecimiento_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_categoria       ON tickets(categoria);
    CREATE INDEX IF NOT EXISTS idx_tickets_tipo_documento  ON tickets(tipo_documento);
    CREATE INDEX IF NOT EXISTS idx_tickets_hash_imagen     ON tickets(hash_imagen);

    -- Dedupe Nivel 1: lo único de una fila es (foto, posición dentro de la foto).
    -- Sustituye al "un hash, una fila" de antes. Las filas sin hash (no debería
    -- haberlas, pero la columna admite NULL) quedan fuera por el WHERE.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_foto_indice
        ON tickets(hash_imagen, indice_en_foto)
        WHERE hash_imagen IS NOT NULL;

    -- Dedupe Nivel 2: unicidad SOLO cuando ambas partes tienen hora conocida.
    -- Con hora_conocida=0 se permiten claves repetidas (dos compras iguales el
    -- mismo día pueden ser legítimamente distintas).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_clave_tiquet_alta_conf
        ON tickets(clave_tiquet)
        WHERE hora_conocida = 1 AND clave_tiquet IS NOT NULL;

    -- Índice normal (no único) para el lookup general por clave.
    CREATE INDEX IF NOT EXISTS idx_tickets_clave_tiquet
        ON tickets(clave_tiquet);

    -- Tipos de cambio ya consultados: uno por día y moneda, para no volver a
    -- preguntar nunca lo mismo.
    CREATE TABLE IF NOT EXISTS tasas_cambio (
        fecha   TEXT NOT NULL,
        moneda  TEXT NOT NULL,
        tasa    REAL NOT NULL,
        PRIMARY KEY (fecha, moneda)
    );

    -- Si cambian el importe, la moneda o la fecha, la conversión ya no vale:
    -- se borra y services/divisas.js la vuelve a hacer.
    CREATE TRIGGER IF NOT EXISTS tickets_invalidar_eur
    AFTER UPDATE OF total_centimos, moneda, fecha_compra ON tickets
    FOR EACH ROW
    WHEN OLD.total_centimos IS NOT NEW.total_centimos
      OR OLD.moneda IS NOT NEW.moneda
      OR OLD.fecha_compra IS NOT NEW.fecha_compra
    BEGIN
        UPDATE tickets SET total_eur_centimos = NULL, tasa_eur = NULL WHERE id = NEW.id;
    END;

    -- Mantiene updated_at al día sin tocarlo desde la aplicación.
    -- El WHEN evita bucle infinito cuando el propio trigger reescribe la fila.
    CREATE TRIGGER IF NOT EXISTS tickets_touch_updated_at
    AFTER UPDATE ON tickets
    FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at
    BEGIN
        UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
`;

// --- MIGRACIONES -------------------------------------------------------------
// Cuando el esquema cambie de forma incompatible:
//   1. Sube SCHEMA_VERSION a N.
//   2. Añade aquí el paso (N-1) -> N: un ALTER TABLE, o una reconstrucción de
//      tabla completa si SQLite no admite el cambio in-place (quitar un NOT NULL,
//      por ejemplo, exige crear tabla nueva + INSERT ... SELECT + DROP + RENAME).
//   3. Ejecútalo dentro de una transacción y cierra con
//      `db.pragma('user_version = N')` para que no se aplique dos veces.
// Mientras no exista el paso, la comprobación de abajo rechaza la base en vez de
// dejar que la aplicación reviente más tarde con "no such column".
const migraciones = {
    // 1 -> 2: tipo_documento pasa a admitir NULL, para poder guardar una fila
    // cuando la extracción no llegó a ejecutarse (503, cuota, clave inválida).
    // SQLite no sabe quitar un NOT NULL con ALTER TABLE: hay que reconstruir la
    // tabla entera. Los índices y el trigger desaparecen con el DROP; el
    // `db.exec(schema)` posterior los vuelve a crear.
    2: (db) => {
        db.exec(`
            CREATE TABLE tickets_v2 (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                tipo_documento      TEXT,
                categoria           TEXT,
                establecimiento_id  INTEGER REFERENCES establecimientos(id),
                fecha_compra        TEXT,
                fecha_evento        TEXT,
                total_centimos      INTEGER,
                moneda              TEXT    DEFAULT 'EUR',
                metodo_pago         TEXT,
                items               TEXT,
                detalles            TEXT,
                ruta_imagen         TEXT,
                hash_imagen         TEXT,
                clave_tiquet        TEXT,
                hora_conocida       INTEGER NOT NULL DEFAULT 0,
                estado              TEXT    NOT NULL DEFAULT 'procesado',
                created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            INSERT INTO tickets_v2 (
                id, tipo_documento, categoria, establecimiento_id,
                fecha_compra, fecha_evento, total_centimos, moneda, metodo_pago,
                items, detalles, ruta_imagen, hash_imagen, clave_tiquet,
                hora_conocida, estado, created_at, updated_at
            )
            SELECT
                id, tipo_documento, categoria, establecimiento_id,
                fecha_compra, fecha_evento, total_centimos, moneda, metodo_pago,
                items, detalles, ruta_imagen, hash_imagen, clave_tiquet,
                hora_conocida, estado, created_at, updated_at
            FROM tickets;

            DROP TABLE tickets;
            ALTER TABLE tickets_v2 RENAME TO tickets;
        `);
    },

    // 2 -> 3: una foto puede contener varios tiquets. Tres columnas nuevas y
    // nada que reconstruir: ADD COLUMN con DEFAULT vale, y los valores por
    // defecto son exactamente los correctos para las filas que ya existen (todas
    // vienen de fotos de un solo tiquet: índice 0 de un total de 1).
    3: (db) => {
        db.exec(`
            ALTER TABLE tickets ADD COLUMN indice_en_foto INTEGER DEFAULT 0;
            ALTER TABLE tickets ADD COLUMN total_en_foto  INTEGER DEFAULT 1;
            ALTER TABLE tickets ADD COLUMN recuadro       TEXT;
        `);
        // ADD COLUMN ... DEFAULT rellena las filas existentes con el default en
        // SQLite, pero dejarlo explícito cuesta nada y protege de un NULL si
        // alguna fila se hubiera insertado con la columna a NULL a mano.
        db.exec(`
            UPDATE tickets SET indice_en_foto = 0 WHERE indice_en_foto IS NULL;
            UPDATE tickets SET total_en_foto  = 1 WHERE total_en_foto  IS NULL;
        `);
    },

    // 3 -> 4: poder confirmar a mano que un documento no imprime importe o fecha.
    //
    // Por qué DOS COLUMNAS booleanas y no un JSON tipo
    // ausencias_confirmadas = ["total","fecha"]:
    //   · El conjunto de campos que definen el estado es cerrado y son dos, total y
    //     fecha (CAMPOS_ESTADO en normalizacion.js). No es una lista abierta que
    //     vaya a crecer sola: añadir un tercero cambiaría calcularEstado, el
    //     formulario y el significado del estado, o sea, cambiaría el esquema de
    //     todas formas. Una migración es el sitio honesto para registrar eso.
    //   · Son consultables directamente en SQL ("¿cuántos documentos sin importe
    //     tengo?" es un WHERE sin_importe = 1), e indexables si algún día hace
    //     falta. Con JSON haría falta json_each o un LIKE frágil.
    //   · Ya existe ese idioma en la tabla: hora_conocida es exactamente la misma
    //     idea (una bandera que dice "este dato no está en el papel"). Mantener la
    //     coherencia vale más que la extensibilidad teórica.
    //   · Un JSON malformado significaría en silencio "ninguna ausencia
    //     confirmada", devolviendo la fila a ámbar sin que nadie se enterase. Un
    //     INTEGER no tiene ese modo de fallo.
    // El JSON de esta base es para lo IMPREVISTO (detalles). Esto no es imprevisto:
    // es parte de la máquina de estados.
    //
    // DEFAULT 0 es el valor correcto para todas las filas existentes: nadie había
    // podido confirmar nada todavía.
    4: (db) => {
        db.exec(`
            ALTER TABLE tickets ADD COLUMN sin_importe INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE tickets ADD COLUMN sin_fecha   INTEGER NOT NULL DEFAULT 0;
        `);
    },

    // 4 -> 5: con qué modelo se leyó cada tiquet.
    //
    // Un ADD COLUMN sin DEFAULT, así que las filas existentes quedan a NULL, que
    // es exactamente lo correcto: se leyeron cuando había un único GEMINI_MODEL y
    // nadie guardaba cuál. Rellenarlas con el valor actual de GEMINI_MODELOS[0]
    // sería inventarse un dato —y encima el dato cuya fiabilidad importa, porque
    // la columna existe para comparar modelos entre sí—.
    5: (db) => {
        db.exec(`ALTER TABLE tickets ADD COLUMN modelo_usado TEXT;`);
    },

    // 5 -> 6: dos cosas que van juntas porque las dos preparan el panel de
    // finanzas.
    //
    // (a) GEOCODIFICACIÓN. Tres columnas nuevas en establecimientos. El estado
    //     por defecto es 'pendiente', que es la verdad para todo lo que ya hay:
    //     nadie lo ha intentado nunca. Si alguna fila tuviera ya coordenadas
    //     (puestas a mano), se marca 'ok' para no volver a preguntar por ella.
    //
    // (b) CAMBIO DE CRITERIO: un importe ausente ya NO deja la fila incompleta.
    //     Hay que aplicarlo a lo ya guardado, o el historial viejo seguiría en
    //     ámbar para siempre mientras el nuevo no, y el mismo color significaría
    //     dos cosas distintas según la fecha de subida.
    //
    //     Dos pasos, los dos conservadores:
    //
    //     1. sin_importe = 1 donde no hay total. SOLO en filas que alguien ha
    //        leído ('procesado'/'incompleto'): una fila 'pendiente' o 'error' no
    //        es un documento sin importe, es un documento sin leer, y marcarla
    //        sería afirmar algo que nadie ha comprobado.
    //
    //     2. 'incompleto' -> 'procesado' SOLO si el único motivo era el importe.
    //        De ahí las tres condiciones extra:
    //          · fecha_compra IS NOT NULL OR sin_fecha = 1  → la fecha sigue
    //            mandando: sin fecha se queda incompleta, como pide el criterio.
    //          · total_en_foto = 1  → una foto con varios tiquets se revisa
    //            siempre, por diseño. No se promociona.
    //          · total_centimos IS NULL  → no se toca ninguna fila CON importe,
    //            que es justo lo que se pidió.
    //        Lo que no se puede distinguir desde aquí es si una fila quedó
    //        incompleta por un descarte de contenido corrupto. Al exigir que la
    //        fecha esté y que la foto sea de un solo tiquet, el único caso que se
    //        promociona de más es el de un total descartado por corrupto, que
    //        pasa a 'procesado' con sin_importe = 1. Es un puñado de filas como
    //        mucho, se ven en el historial con su marca, y la alternativa —no
    //        migrar nada— deja el problema en todas.
    6: (db) => {
        db.exec(`
            ALTER TABLE establecimientos ADD COLUMN geo_estado       TEXT NOT NULL DEFAULT 'pendiente';
            ALTER TABLE establecimientos ADD COLUMN geo_intentado_at DATETIME;
            ALTER TABLE establecimientos ADD COLUMN geo_mensaje      TEXT;
        `);
        db.exec(`
            UPDATE establecimientos
               SET geo_estado = 'ok'
             WHERE latitud IS NOT NULL AND longitud IS NOT NULL;
        `);

        db.exec(`
            UPDATE tickets
               SET sin_importe = 1
             WHERE total_centimos IS NULL
               AND estado IN ('procesado', 'incompleto');
        `);
        db.exec(`
            UPDATE tickets
               SET estado = 'procesado'
             WHERE estado = 'incompleto'
               AND total_centimos IS NULL
               AND total_en_foto = 1
               AND (fecha_compra IS NOT NULL OR sin_fecha = 1);
        `);
    },

    // 7 -> 8: el lugar deducido del contenido para los documentos que no
    // imprimen dirección. Columna nueva y vacía: los establecimientos que ya
    // existen la rellenan al reintentar la lectura o al editarlos a mano.
    8: (db) => {
        db.exec(`ALTER TABLE establecimientos ADD COLUMN lugar_inferido TEXT;`);
    },

    // 8 -> 9: país por establecimiento y conversión a euros de las compras en
    // otra moneda. Columnas nuevas y vacías: la conversión la hace el servicio
    // de divisas al arrancar.
    // 9 -> 10: Google Places. El nombre deja de ser único (dos tiendas de la
    // misma cadena en ciudades distintas son dos sitios) y entran las columnas
    // de Google. Quitar un UNIQUE de columna exige reconstruir la tabla.
    10: (db) => {
        db.exec(`
            CREATE TABLE establecimientos_v10 (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                nombre          TEXT    NOT NULL,
                direccion       TEXT,
                ciudad          TEXT,
                codigo_postal   TEXT,
                pais            TEXT,
                lugar_inferido  TEXT,
                latitud         REAL,
                longitud        REAL,
                geo_estado      TEXT NOT NULL DEFAULT 'pendiente',
                geo_intentado_at DATETIME,
                geo_mensaje     TEXT,
                geo_precision   TEXT,
                place_id              TEXT,
                google_estado         TEXT NOT NULL DEFAULT 'pendiente',
                google_nombre         TEXT,
                google_direccion      TEXT,
                google_candidatos     TEXT,
                google_actualizado_at DATETIME,
                created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO establecimientos_v10 (
                id, nombre, direccion, ciudad, codigo_postal, pais, lugar_inferido,
                latitud, longitud, geo_estado, geo_intentado_at, geo_mensaje, geo_precision, created_at
            )
            SELECT id, nombre, direccion, ciudad, codigo_postal, pais, lugar_inferido,
                   latitud, longitud, geo_estado, geo_intentado_at, geo_mensaje, geo_precision, created_at
            FROM establecimientos;
            DROP TABLE establecimientos;
            ALTER TABLE establecimientos_v10 RENAME TO establecimientos;
        `);
    },

    // 11 -> 12: solo datos. Los tiquets de bonÀrea de euros justos (35 €, 50 €)
    // son gasolina: TRANSPORTE. Lo nuevo lo hace services/reglas_categoria.js
    // al leer el tiquet; esto arregla lo que ya estaba guardado, una vez.
    12: (db) => {
        db.exec(`
            UPDATE tickets SET categoria = 'TRANSPORTE'
            WHERE total_centimos > 0 AND total_centimos % 100 = 0
              AND COALESCE(categoria, '') <> 'TRANSPORTE'
              AND establecimiento_id IN (
                  SELECT id FROM establecimientos
                  WHERE UPPER(nombre) LIKE '%BONAREA%' OR UPPER(nombre) LIKE '%BON AREA%'
                     OR nombre LIKE '%BONÀREA%' OR nombre LIKE '%bonÀrea%' OR nombre LIKE '%BON ÀREA%'
                     OR UPPER(COALESCE(google_nombre, '')) LIKE '%BONAREA%'
                     OR COALESCE(google_nombre, '') LIKE '%bonÀrea%' OR COALESCE(google_nombre, '') LIKE '%BONÀREA%'
              );
        `);
    },

    // 10 -> 11: tiquets compartidos (ver el esquema).
    11: (db) => {
        db.exec(`ALTER TABLE tickets ADD COLUMN compartido_entre INTEGER;`);
        db.exec(`ALTER TABLE tickets ADD COLUMN mi_parte_centimos INTEGER;`);
    },

    9: (db) => {
        db.exec(`ALTER TABLE establecimientos ADD COLUMN pais TEXT;`);
        db.exec(`ALTER TABLE tickets ADD COLUMN total_eur_centimos INTEGER;`);
        db.exec(`ALTER TABLE tickets ADD COLUMN tasa_eur REAL;`);
    },

    // 6 -> 7: con cuánta precisión está situado cada establecimiento.
    //
    // Los que ya tienen coordenadas se marcan 'exacta': se consiguieron con la
    // búsqueda de una sola etapa, que era la dirección completa o nada. Es la
    // verdad sobre cómo se obtuvieron.
    7: (db) => {
        db.exec(`ALTER TABLE establecimientos ADD COLUMN geo_precision TEXT;`);
        db.exec(`
            UPDATE establecimientos
               SET geo_precision = 'exacta'
             WHERE geo_estado = 'ok' AND latitud IS NOT NULL AND longitud IS NOT NULL;
        `);
    }
};

/**
 * Aplica en orden los pasos que faltan desde `desde` hasta SCHEMA_VERSION.
 * Devuelve false, sin tocar nada, si falta algún paso del camino: en ese caso
 * quien llama decide (y aborta).
 */
function aplicarMigraciones(desde) {
    for (let v = desde + 1; v <= SCHEMA_VERSION; v++) {
        if (!migraciones[v]) return false;
    }

    // Las reconstrucciones de tabla necesitan las FK desactivadas, y el PRAGMA
    // no surte efecto dentro de una transacción: por eso va aquí fuera.
    db.pragma('foreign_keys = OFF');
    try {
        for (let v = desde + 1; v <= SCHEMA_VERSION; v++) {
            console.log(`🔧 Migrando base de datos: versión ${v - 1} → ${v}...`);
            db.transaction(() => {
                migraciones[v](db);
                db.pragma(`user_version = ${v}`);
            })();
        }
        const rotas = db.pragma('foreign_key_check');
        if (rotas.length > 0) {
            throw new Error(`foreign_key_check falló tras migrar: ${JSON.stringify(rotas)}`);
        }
    } finally {
        db.pragma('foreign_keys = ON');
    }
    return true;
}

// --- ARRANQUE: crear o validar ----------------------------------------------
// Una base recién creada no tiene ninguna tabla de usuario. Ese es el único caso
// en el que podemos aplicar el esquema entero y sellar la versión sin preguntar.
const tablasExistentes = db.prepare(`
    SELECT COUNT(*) AS n FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
`).get().n;

const versionActual = db.pragma('user_version', { simple: true });

if (tablasExistentes === 0) {
    // Base nueva: esquema completo y sellado.
    db.exec(schema);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
} else if (versionActual === SCHEMA_VERSION) {
    // Base ya conocida. El esquema es idempotente (IF NOT EXISTS), así que lo
    // reejecutamos para recuperar cualquier índice o trigger que falte.
    db.exec(schema);
} else if (versionActual < SCHEMA_VERSION && aplicarMigraciones(versionActual)) {
    // Migrada. Reejecutamos el esquema para recrear los índices y el trigger que
    // se hayan perdido al reconstruir tablas.
    db.exec(schema);
    console.log(`✅ Base de datos migrada a la versión ${SCHEMA_VERSION}.`);
} else {
    // Base preexistente con una versión que este código no sabe manejar.
    // Abortamos: continuar significaría fallar más tarde y de forma confusa.
    console.error(`
╔══════════════════════════════════════════════════════════════════════════╗
║  ESQUEMA DE BASE DE DATOS INCOMPATIBLE                                   ║
╚══════════════════════════════════════════════════════════════════════════╝

  Fichero:          ${dbPath}
  Versión en disco: ${versionActual}
  Versión esperada: ${SCHEMA_VERSION}

  Esta base se creó con otra versión del esquema y no hay migración escrita
  para ella (ver "migraciones" en src/config/db.js).

  Si la base NO tiene datos que quieras conservar, bórrala y se recreará
  vacía al siguiente arranque:

      rm database/tickets.db database/tickets.db-wal database/tickets.db-shm

  Si SÍ tiene datos, haz copia antes y escribe la migración correspondiente.
`);
    process.exit(1);
}

// La versión del esquema, colgada de la conexión: las pruebas comprueban que una
// base vieja acaba aquí sin tener que repetir el número (y desactualizarlo).
db.SCHEMA_VERSION = SCHEMA_VERSION;

module.exports = db;
