const { spawn, execFile } = require('node:child_process');
const { watch } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { root, assertAvailable, startDatabase, archiveDatabase } = require('./dev-db.cjs');

const run = promisify(execFile);
let postgres;
let backend;
let backendClosed;
let sourceWatcher;
let reloadTimer;
let reloadQueue = Promise.resolve();
let cancelled = false;
let status = 0;
let finish;
const done = new Promise(resolve => { finish = resolve; });
function stop() { cancelled = true; finish(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('disconnect', stop);
process.on('message', message => { if (message === 'stop') stop(); });

async function stopBackend() {
  const child = backend;
  backend = undefined;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // The child is owned by this launcher. /T also stops any tsx worker it started.
    try { await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
    catch (error) { if (child.exitCode === null && child.signalCode === null) throw error; }
  } else {
    child.kill('SIGTERM');
  }
  await backendClosed;
}

function startBackend(env, directory) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: directory, env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
  });
  backend = child;
  backendClosed = once(child, 'close').catch(() => undefined);
  child.once('error', error => { console.error('[Development]', error.message); status = 1; stop(); });
  child.once('exit', (code, signal) => {
    if (backend !== child || cancelled) return;
    console.error('[Development] Backend berhenti:', code ?? signal);
    status = 1;
    stop();
  });
}

async function claimLock(lockPath) {
  try { return await fs.open(lockPath, 'wx'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const busy = () => new Error('Launcher Development lain sedang aktif. Periksa lock ' + lockPath);
  const recoveryPath = lockPath + '.recovery';
  const recovery = await fs.open(recoveryPath, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw busy();
    throw error;
  });
  try {
    const owner = Number(await fs.readFile(lockPath, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }));
    if (owner) {
      if (!Number.isSafeInteger(owner) || owner <= 0) throw busy();
      try { process.kill(owner, 0); throw busy(); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      await fs.unlink(lockPath);
    } else if (await fs.stat(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
      // Another process may have opened the lock and not written its PID yet.
      throw busy();
    }
    return await fs.open(lockPath, 'wx');
  } finally { await recovery.close(); await fs.unlink(recoveryPath); }
}

async function main() {
  const archive = process.argv.includes('--archive');
  if (!archive && (!process.send || !process.env.DIGIWMS_DEV_SERVICE_ID || !process.env.DIGIWMS_DEV_FRONTEND_ORIGIN)) {
    throw new Error('Jalankan npm run dev dari FRONTEND-DIGI-WMS.');
  }
  if (!archive) await assertAvailable(5102, '127.0.0.1').catch(error => {
    if (error.code === 'EADDRINUSE') throw new Error('Port backend Development 5102 sedang dipakai. Hentikan secara manual bila sesuai.');
    throw error;
  });
  await fs.mkdir(path.dirname(root), { recursive: true });
  const lockPath = root + '.launcher.lock';
  const lock = await claimLock(lockPath);
  try {
    await lock.writeFile(String(process.pid));
    if (archive) { console.log(await archiveDatabase()); return; }
    postgres = await startDatabase();
    if (cancelled) return;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PG[A-Z_]|DATABASE_URL$|JWT_SECRET$|MQTT_|NODE_OPTIONS$)/i.test(key)));
    const directory = path.resolve(__dirname, '..');
    const backendEnv = { ...env, DIGIWMS_LOCAL_DEV: '1', DIGIWMS_DEV_IDENTITY_FILE: postgres.identityFile };
    startBackend(backendEnv, directory);
    sourceWatcher = watch(path.join(directory, 'src'), { recursive: true }, (_event, filename) => {
      if (cancelled || !filename?.endsWith('.ts')) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadQueue = reloadQueue.then(async () => {
          if (cancelled) return;
          console.log('[Development] Memuat ulang backend karena file TypeScript berubah.');
          await stopBackend();
          if (!cancelled) startBackend(backendEnv, directory);
        }).catch(error => { console.error('[Development]', error.message); status = 1; stop(); });
      }, 250);
    });
    sourceWatcher.on('error', error => { console.error('[Development]', error.message); status = 1; stop(); });
    const deadline = Date.now() + 35_000;
    while (!cancelled && Date.now() < deadline) {
      const response = await fetch('http://127.0.0.1:5102/api/dev/ready', {
        headers: { 'x-digiwms-dev-probe': process.env.DIGIWMS_DEV_SERVICE_ID }, signal: AbortSignal.timeout(1500),
      }).catch(() => null);
      if (response?.ok) {
        process.send({ ready: true, loginFile: postgres.loginFile });
        await done;
        return;
      }
      await delay(250);
    }
    if (!cancelled) throw new Error('Backend Development gagal siap. Periksa pesan Fastify di terminal.');
  } finally {
    sourceWatcher?.close();
    clearTimeout(reloadTimer);
    try { await reloadQueue; await stopBackend(); }
    finally {
      try { await postgres?.stop(); }
      finally { await lock.close(); await fs.unlink(lockPath); }
    }
  }
}

main().catch(error => { console.error('[Development]', error.message); status = 1; }).finally(() => {
  process.exitCode = status;
  if (process.connected) process.disconnect();
});
