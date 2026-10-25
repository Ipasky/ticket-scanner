#!/usr/bin/env node
/**
 * Genera la línea que va en AUTH_PASSWORD_HASH del .env.
 *
 *     npm run hash-password
 *
 * Pide la contraseña por consola SIN mostrarla y la pide dos veces: un error de
 * tecleo aquí significa quedarse fuera de la aplicación y no enterarse hasta el
 * siguiente login.
 *
 * En el .env va el HASH, nunca la contraseña. Este script no escribe en ningún
 * fichero ni guarda la contraseña en ninguna parte: la imprime hasheada y se
 * olvida de ella.
 *
 * Si se le pasa la contraseña por una tubería (`echo 'x' | npm run hash-password`)
 * también funciona, para automatizar. Ojo: eso la deja en el historial del shell.
 */
const readline = require('node:readline');
const { hashearPassword, verificarPassword, SCRYPT } = require('../src/services/password.js');

const LONGITUD_MINIMA = 12;

/** Lee una línea del terminal sin eco. Devuelve '' si se cancela. */
function preguntarOculto(pregunta) {
    return new Promise((resolve, reject) => {
        const entrada = process.stdin;
        const salida = process.stdout;

        // Sin TTY (tubería, CI) no hay eco que ocultar: se lee la línea tal cual.
        if (!entrada.isTTY) {
            const rl = readline.createInterface({ input: entrada });
            // Ojo con el orden: rl.close() emite 'close' de forma SÍNCRONA, así que
            // si se cerrase antes de resolver, el resolve('') del cierre ganaría la
            // carrera y la línea leída se perdería.
            rl.once('line', (linea) => { resolve(linea); rl.close(); });
            rl.once('close', () => resolve(''));   // no llegó ninguna línea
            return;
        }

        salida.write(pregunta);
        let valor = '';
        entrada.setRawMode(true);
        entrada.resume();
        entrada.setEncoding('utf8');

        const alPulsar = (tecla) => {
            // Enter: terminamos.
            if (tecla === '\n' || tecla === '\r' || tecla === '\u0004') {
                entrada.setRawMode(false);
                entrada.pause();
                entrada.removeListener('data', alPulsar);
                salida.write('\n');
                return resolve(valor);
            }
            // Ctrl+C: salir sin hacer nada.
            if (tecla === '\u0003') {
                entrada.setRawMode(false);
                entrada.pause();
                salida.write('\n');
                return reject(new Error('cancelado'));
            }
            // Borrado.
            if (tecla === '\u007f' || tecla === '\b') {
                if (valor.length > 0) {
                    valor = valor.slice(0, -1);
                    salida.write('\b \b');
                }
                return;
            }
            // Caracteres de control sueltos: se ignoran.
            if (tecla < ' ') return;

            valor += tecla;
            salida.write('*');
        };

        entrada.on('data', alPulsar);
    });
}

async function principal() {
    console.log(`
Generador del hash de contraseña para AUTH_PASSWORD_HASH
─────────────────────────────────────────────────────────
Un solo usuario. La contraseña no se guarda en ningún sitio: lo que se pega en
el .env es el hash scrypt (N=${SCRYPT.N}, r=${SCRYPT.r}, p=${SCRYPT.p}).
`);

    const password = await preguntarOculto('Contraseña: ');
    if (!password) {
        console.error('\n❌ No has escrito nada. No se genera ningún hash.');
        process.exit(1);
    }

    // Con tubería no se puede confirmar: solo hay una línea.
    if (process.stdin.isTTY) {
        const repetida = await preguntarOculto('Repítela:   ');
        if (repetida !== password) {
            console.error('\n❌ Las dos contraseñas no coinciden. No se genera ningún hash.');
            process.exit(1);
        }
    }

    if (password.length < LONGITUD_MINIMA) {
        console.warn(
            `\n⚠️  Son solo ${password.length} caracteres. Se genera el hash igualmente, ` +
            `pero para algo que queda expuesto en una red conviene pasar de ${LONGITUD_MINIMA}.`
        );
    }

    const hash = hashearPassword(password);

    // Comprobación de cordura: que el hash recién generado valide su contraseña.
    // Si esto fallara, el .env quedaría con un hash inservible y sin manera de
    // entrar; mejor descubrirlo aquí.
    if (!verificarPassword(password, hash)) {
        console.error('\n❌ El hash generado no verifica su propia contraseña. No lo uses; abre una incidencia.');
        process.exit(1);
    }

    console.log(`
✅ Hecho. Copia esta línea COMPLETA en tu .env:

AUTH_PASSWORD_HASH=${hash}

Recuerda también:
  AUTH_MODE=local
  SESSION_SECRET=<48 bytes aleatorios; genéralo con el comando de abajo>

  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
`);
}

principal().catch((error) => {
    if (error && error.message === 'cancelado') {
        console.error('Cancelado.');
        process.exit(130);
    }
    console.error('❌ Error generando el hash:', error);
    process.exit(1);
});
