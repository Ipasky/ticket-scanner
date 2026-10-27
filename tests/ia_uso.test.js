// Uso de Gemini por modelo: lo que dice un 429 sobre la cuota y los contadores del día.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TICKETS_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ia-uso-')), 'tickets.db');
const uso = require('../src/services/ia_uso.js');

const error429 = (quotaId, valor, espera = '39s') => Object.assign(new Error(
    `got status: 429 Too Many Requests. {"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED",` +
    `"details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_requests",` +
    `"quotaId":"${quotaId}","quotaDimensions":{"location":"global","model":"gemini-x"},"quotaValue":"${valor}"}]},` +
    `{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"${espera}"}]}}`), { status: 429 });

test('lee del 429 qué cuota se ha agotado, su valor y la espera', () => {
    const c = uso.leerCuota(error429('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 20));
    assert.deepEqual([c.porDia, c.porMinuto, c.valor, c.espera], [true, false, 20, 39]);
    const m = uso.leerCuota(error429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 5, '12s'));
    assert.deepEqual([m.porDia, m.porMinuto, m.valor, m.espera], [false, true, 5, 12]);
});

test('cuenta peticiones, aprende el límite diario y marca agotado hasta la renovación', () => {
    uso._antes('modelo-a'); uso._bien('modelo-a');
    uso._antes('modelo-a'); uso._mal('modelo-a', error429('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 20));
    uso._antes('modelo-b'); uso._mal('modelo-b', Object.assign(new Error('503 Service Unavailable'), { status: 503 }));
    const r = uso.resumen(['modelo-a', 'modelo-b', 'modelo-c']);
    const [a, b, c] = r.modelos;
    assert.deepEqual([a.peticiones, a.ok, a.cuota, a.limite_dia, a.estado], [2, 1, 1, 20, 'agotado_dia']);
    assert.equal(a.agotado_hasta, r.renueva_at, 'agotado hasta la medianoche del Pacífico');
    assert.deepEqual([b.saturado, b.estado], [1, 'saturado']);
    assert.equal(c.estado, 'sin_uso');
});

test('la renovación es la próxima medianoche del Pacífico', () => {
    // 27 oct 2026 12:00 UTC = 05:00 en Los Ángeles (PDT) → renueva el 28 a las 07:00 UTC.
    assert.equal(uso.proximaRenovacion(new Date('2026-10-27T12:00:00Z')).toISOString(), '2026-10-28T07:00:00.000Z');
    // 15 dic (PST, UTC-8): renueva a las 08:00 UTC.
    assert.equal(uso.proximaRenovacion(new Date('2026-12-15T20:00:00Z')).toISOString(), '2026-12-16T08:00:00.000Z');
});
