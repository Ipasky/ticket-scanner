/**
 * Banco con Enable Banking SIMULADO: firma, signo de los importes y que una
 * segunda descarga no duplica movimientos.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const { crearBanco, abrirBase, crearJwt, normalizarMovimiento } = require('../src/services/banco.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-banco-'));
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const RUTA_CLAVE = path.join(TMP, 'clave.pem');
fs.writeFileSync(RUTA_CLAVE, privateKey.export({ type: 'pkcs8', format: 'pem' }));

test('el JWT va firmado con la clave y lleva el id de la aplicación', () => {
    const jwt = crearJwt('app-1', fs.readFileSync(RUTA_CLAVE, 'utf8'), 1000);
    const [c, p, f] = jwt.split('.');
    assert.equal(JSON.parse(Buffer.from(c, 'base64url')).kid, 'app-1');
    assert.equal(JSON.parse(Buffer.from(p, 'base64url')).aud, 'api.enablebanking.com');
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${c}.${p}`), publicKey, Buffer.from(f, 'base64url')));
});

test('un cargo es negativo y un abono positivo', () => {
    const cargo = normalizarMovimiento({ transaction_amount: { amount: '12.34', currency: 'EUR' },
        credit_debit_indicator: 'DBIT', booking_date: '2026-10-01', remittance_information: ['COMPRA ABACUS'] }, 'c1');
    const abono = normalizarMovimiento({ transaction_amount: { amount: '5', currency: 'EUR' },
        credit_debit_indicator: 'CRDT', booking_date: '2026-10-01', entry_reference: 'x1' }, 'c1');
    assert.equal(cargo.importe_centimos, -1234);
    assert.equal(cargo.concepto, 'COMPRA ABACUS');
    assert.equal(abono.importe_centimos, 500);
    assert.equal(abono.clave, 'c1|x1');
});

test('sincronizar dos veces no duplica movimientos', async () => {
    const db = abrirBase(path.join(TMP, 'banco.db'));
    db.prepare(`INSERT INTO sesiones (id, banco, valida_hasta, activa) VALUES ('s1', 'Santander', '2099-01-01', 1)`).run();
    db.prepare(`INSERT INTO cuentas (uid, sesion_id, iban, leer) VALUES ('c1', 's1', 'ES0000000000000000001234', 1)`).run();
    db.prepare(`INSERT INTO cuentas (uid, sesion_id, iban, leer) VALUES ('c2', 's1', 'ES0000000000000000005678', 0)`).run();
    const pedidas = [];
    const banco = crearBanco({
        db,
        config: { appId: 'app-1', rutaClave: RUTA_CLAVE, activa: true, pais: 'ES', nombreBanco: 'Santander' },
        hacerPeticion: async (url) => {
            pedidas.push(String(url));
            return { ok: true, status: 200, text: async () => JSON.stringify({ transactions: [
                { transaction_id: 't1', transaction_amount: { amount: '10.00', currency: 'EUR' }, credit_debit_indicator: 'DBIT', booking_date: '2026-10-02' },
                { transaction_amount: { amount: '3.50', currency: 'EUR' }, credit_debit_indicator: 'DBIT', booking_date: '2026-10-03', remittance_information: ['CAFE'] }
            ] }) };
        }
    });
    assert.equal((await banco.sincronizar()).nuevos, 2);
    assert.equal((await banco.sincronizar()).nuevos, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM movimientos').get().n, 2);
    assert.ok(pedidas.every(u => u.includes('/accounts/c1/')), 'la cuenta no marcada no se lee');
});

test('un cargo casa con su tiquet por importe, fecha y nombre; el dudoso no', () => {
    const { cruzar, parsearConcepto } = require('../src/services/banco_analisis.js');
    const db = abrirBase(path.join(TMP, 'cruce.db'));
    const ins = db.prepare(`INSERT INTO movimientos (cuenta_uid, clave, fecha, importe_centimos, concepto, clase, comercio)
                            VALUES ('c1', ?, ?, ?, ?, 'tarjeta', ?)`);
    for (const [clave, fecha, imp, concepto] of [
        ['a', '2026-10-03', -1230, 'PAGO MOVIL EN CARREF MANRESA, MANRESA ES, TARJ. :*1'],
        ['b', '2026-10-03', -500, 'PAGO MOVIL EN BAR X, MANRESA ES, TARJ. :*1']]) {
        ins.run(clave, fecha, imp, concepto, parsearConcepto(concepto).comercio);
    }
    const tiquets = () => [
        { id: 7, dia: '2026-10-02', total_centimos: 1230, nombre: 'CARREFOUR MARKET', alias: [] },
        { id: 8, dia: '2026-10-02', total_centimos: 500, nombre: 'CAFE UNO', alias: [] },
        { id: 9, dia: '2026-10-01', total_centimos: 500, nombre: 'CAFE DOS', alias: [] }
    ];
    assert.equal(cruzar(db, tiquets), 1);
    assert.equal(db.prepare("SELECT tiquet_id FROM movimientos WHERE clave = 'a'").get().tiquet_id, 7);
    assert.equal(db.prepare("SELECT tiquet_id FROM movimientos WHERE clave = 'b'").get().tiquet_id, null);
});

test('categorías: regla por tipo, y la puesta a mano se aprende para el comercio', () => {
    const { crearBanco: crear, abrirBase: abrir } = require('../src/services/banco.js');
    const db = abrir(path.join(TMP, 'cat.db'));
    db.prepare(`INSERT INTO cuentas (uid, sesion_id, iban, leer) VALUES ('c1', 's1', 'ES00', 1)`).run();
    const ins = db.prepare(`INSERT INTO movimientos (cuenta_uid, clave, fecha, importe_centimos, concepto) VALUES ('c1', ?, ?, ?, ?)`);
    ins.run('1', '2026-10-01', -300, 'BIZUM A ANA CONCEPTO Cena');
    ins.run('2', '2026-10-02', -1500, 'PAGO MOVIL EN GIMNAS FIT, MANRESA ES, TARJ. :*1');
    ins.run('3', '2026-11-02', -1500, 'PAGO MOVIL EN GIMNAS FIT, MANRESA ES, TARJ. :*1');
    const ticketsDb = { prepare: () => ({ all: () => [], get: () => null }) };
    const b = crear({ db, ticketsDb, config: { activa: true } });
    b.analizar();
    assert.equal(db.prepare("SELECT categoria FROM movimientos WHERE clave = '1'").get().categoria, 'BIZUM');
    const id = db.prepare("SELECT id FROM movimientos WHERE clave = '2'").get().id;
    b.ponerCategoria(id, 'suscripciones');
    assert.equal(db.prepare("SELECT categoria FROM movimientos WHERE clave = '3'").get().categoria, 'SUSCRIPCIONES');
    ins.run('4', '2026-12-02', -1500, 'PAGO MOVIL EN GIMNAS FIT, MANRESA ES, TARJ. :*1');
    b.analizar();
    assert.equal(db.prepare("SELECT categoria FROM movimientos WHERE clave = '4'").get().categoria, 'SUSCRIPCIONES');
});

test('extracto importado: no duplica lo que ya trajo la API ni lo importado antes', () => {
    const { crearBanco: crear, abrirBase: abrir, normalizarMovimiento: norm } = require('../src/services/banco.js');
    const db = abrir(path.join(TMP, 'importar.db'));
    db.prepare(`INSERT INTO cuentas (uid, sesion_id, iban, leer) VALUES ('c1', 's1', 'ES0012345678901234567890', 1)`).run();
    const ticketsDb = { prepare: () => ({ all: () => [], get: () => null }) };
    const b = crear({ db, ticketsDb, config: { activa: true } });
    // Por la API: un café (con la tarjeta enmascarada a su manera).
    const { insertarSinDuplicar } = require('../src/services/banco.js');
    insertarSinDuplicar(db, norm({ transaction_id: 't1', transaction_amount: { amount: '1.50', currency: 'EUR' },
        credit_debit_indicator: 'DBIT', booking_date: '2026-10-02', transaction_date: '2026-10-01',
        remittance_information: ['PAGO MOVIL EN BAR X, MANRESA ES, TARJ. :*123456'] }, 'c1'), 'api');
    const filas = [
        { fecha: '2026-10-01', concepto: 'Pago Movil En Bar X, Manresa Es, Tarj. :*56', importe: -1.5, saldo: 100 },
        { fecha: '2026-10-01', concepto: 'Pago Movil En Bar X, Manresa Es, Tarj. :*56', importe: -1.5, saldo: 98.5 },
        { fecha: '2026-09-20', concepto: 'Bizum De Ana Concepto Cena', importe: 12, saldo: 101.5 }
    ];
    const r = b.importar({ iban: 'ES00 1234 5678 9012 3456 7890', filas });
    assert.deepEqual([r.nuevos, r.emparejados], [2, 1], 'el primer café ya estaba; el segundo es otro café');
    const r2 = b.importar({ iban: 'ES0012345678901234567890', filas });
    assert.deepEqual([r2.nuevos, r2.repetidos], [0, 3]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM movimientos').get().n, 3);
    // Y si la API vuelve a traer el mismo café, tampoco se duplica.
    insertarSinDuplicar(db, norm({ transaction_id: 't1', transaction_amount: { amount: '1.50', currency: 'EUR' },
        credit_debit_indicator: 'DBIT', booking_date: '2026-10-02', remittance_information: ['PAGO MOVIL EN BAR X, MANRESA ES, TARJ. :*123456'] }, 'c1'), 'api');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM movimientos').get().n, 3);
});

test('cambiar el establecimiento de un pago solo cambia ese pago; con todos, el comercio entero', () => {
    const { crearBanco: crear, abrirBase: abrir } = require('../src/services/banco.js');
    const db = abrir(path.join(TMP, 'est.db'));
    db.prepare(`INSERT INTO cuentas (uid, sesion_id, iban, leer) VALUES ('c1', 's1', 'ES00', 1)`).run();
    const ins = db.prepare(`INSERT INTO movimientos (cuenta_uid, clave, fecha, importe_centimos, concepto) VALUES ('c1', ?, ?, ?, ?)`);
    ins.run('1', '2026-10-01', -280, 'PAGO MOVIL EN INDIGO S. JOAN, MANRESA ES, TARJ. :*1');
    ins.run('2', '2026-10-02', -300, 'PAGO MOVIL EN INDIGO S. JOAN, MANRESA ES, TARJ. :*1');
    const ests = [{ id: 1, nombre: 'INDIGO' }, { id: 2, nombre: 'BM' }];
    const ticketsDb = { prepare: (sql) => ({ all: () => (/FROM establecimientos/.test(sql) ? ests : []), get: () => null }) };
    const b = crear({ db, ticketsDb, config: { activa: true } });
    b.analizar();
    const [m1, m2] = db.prepare('SELECT id FROM movimientos ORDER BY clave').all().map(f => f.id);
    b.ponerEstablecimiento(m1, { id: 1, todos: true });
    assert.equal(b.movimiento(m2).establecimiento.id, 1);
    assert.equal(b.movimiento(m1).pagos_comercio, 2);
    // Solo este pago: el otro sigue en INDIGO.
    b.ponerEstablecimiento(m1, { id: 2 });
    assert.equal(b.movimiento(m1).establecimiento.id, 2);
    assert.equal(b.movimiento(m2).establecimiento.id, 1);
    // Volver a poner el del comercio quita el propio.
    b.ponerEstablecimiento(m1, { id: 1 });
    assert.equal(db.prepare('SELECT est_propio FROM movimientos WHERE id = ?').get(m1).est_propio, null);
});

test('el mismo apunte, primero sin referencia y luego con ella, no se duplica (y los ya duplicados se unen)', () => {
    const { abrirBase: abrir, normalizarMovimiento: norm, insertarSinDuplicar } = require('../src/services/banco.js');
    const ruta = path.join(TMP, 'huella.db');
    const db = abrir(ruta);
    db.prepare(`INSERT INTO cuentas (uid, sesion_id, iban, leer) VALUES ('c1', 's1', 'ES00', 1)`).run();
    const apunte = { transaction_amount: { amount: '6.50', currency: 'EUR' }, credit_debit_indicator: 'DBIT',
        booking_date: '2026-10-23', value_date: '2026-10-23', status: 'BOOK',
        remittance_information: ['PAGO MOVIL EN MERCADONA, MANRESA ES, TARJ. :*1'] };
    assert.equal(insertarSinDuplicar(db, norm(apunte, 'c1'), 'api'), 'nuevo');
    db.prepare('UPDATE movimientos SET tiquet_id = 90').run();
    assert.equal(insertarSinDuplicar(db, norm({ ...apunte, entry_reference: 'REF1' }, 'c1'), 'api'), 'repetido');
    const filas = db.prepare('SELECT clave, tiquet_id FROM movimientos').all();
    assert.deepEqual(filas, [{ clave: 'c1|REF1', tiquet_id: 90 }]);

    // Los que ya entraron repetidos (de antes de este arreglo): al abrir la base se unen.
    const otro = { ...apunte, transaction_amount: { amount: '30.00', currency: 'EUR' } };
    const ins = db.prepare(`INSERT INTO movimientos (cuenta_uid, clave, fecha, importe_centimos, concepto, crudo, origen, est_propio)
        VALUES (@cuenta_uid, @clave, @fecha, @importe_centimos, @concepto, @crudo, 'api', @est)`);
    ins.run({ ...norm(otro, 'c1'), est: null });
    ins.run({ ...norm({ ...otro, entry_reference: 'REF2' }, 'c1'), est: 7 });
    db.close();
    const db2 = abrir(ruta);
    const de30 = db2.prepare('SELECT clave, est_propio FROM movimientos WHERE importe_centimos = -3000').all();
    assert.deepEqual(de30, [{ clave: 'c1|REF2', est_propio: 7 }]);
    db2.close();
});
