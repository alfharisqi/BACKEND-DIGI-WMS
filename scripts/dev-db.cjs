const { execFile, spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const run = promisify(execFile);
const repository = path.resolve(__dirname, '..');
const root = path.join(process.env.LOCALAPPDATA || os.homedir(), 'DigiWMS', 'Development');
const directory = path.join(root, 'pgdata');
const identityFile = path.join(root, 'identity.json');
const loginFile = path.join(root, 'login-password.txt');
const pgPort = Number(process.env.DIGIWMS_DEV_PG_PORT || 55436);
if (!Number.isInteger(pgPort) || pgPort < 1024 || pgPort > 65535 || pgPort === 5102) {
  throw new Error('DIGIWMS_DEV_PG_PORT harus merupakan port PostgreSQL Development yang valid.');
}
const dbName = 'digiwms_development';
const pgBin = process.env.DIGIWMS_DEV_PG_BIN || 'C:/Program Files/PostgreSQL/16/bin';
const secret = () => randomBytes(32).toString('hex');
const samePath = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return canonical(a) === canonical(b);
};

function readIdentity(filename = identityFile) {
  if (!samePath(filename, identityFile)) throw new Error('Lokasi identitas PostgreSQL Development tidak sah.');
  const identity = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (identity.kind !== 'digiwms-local-development-v1' || !samePath(identity.directory, directory)
      || !/^\d{10,24}$/.test(identity.systemIdentifier) || !/^[a-f0-9]{64}$/.test(identity.proof)
      || !/^[a-f0-9]{64}$/.test(identity.dbPassword) || !/^[a-f0-9]{64}$/.test(identity.jwtSecret)) {
    throw new Error('Identitas PostgreSQL Development tidak valid.');
  }
  if (fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(directory).isSymbolicLink()
      || !samePath(fs.realpathSync(directory), directory)) throw new Error('Direktori cluster Development dialihkan.');
  return identity;
}

function verifyPidFile(identity) {
  const [pid, dataDir, , port, , listening] = fs.readFileSync(path.join(directory, 'postmaster.pid'), 'utf8').split(/\r?\n/);
  if (!/^[1-9]\d*$/.test(pid) || !samePath(dataDir, identity.directory)
      || port !== String(pgPort) || listening !== '127.0.0.1') throw new Error('Listener PostgreSQL bukan cluster Development yang diharapkan.');
  process.kill(Number(pid), 0);
}

function dbOptions(identity, database = dbName) {
  return { host: '127.0.0.1', port: pgPort, database, user: 'postgres', password: identity.dbPassword,
    ssl: false, connectionTimeoutMillis: 4500, options: '-c search_path=public,pg_catalog' };
}

async function verifyConnection(db, identity, database = dbName, checkProof = true) {
  const { rows: [row] } = await db.query(`SELECT current_database() AS db, current_user AS username,
    current_setting('data_directory') AS directory, host(inet_server_addr()) AS host,
    inet_server_port() AS port, system_identifier::text FROM pg_control_system()`);
  if (!row || row.db !== database || row.username !== 'postgres' || row.host !== '127.0.0.1'
      || row.port !== pgPort || !samePath(row.directory, identity.directory) || row.system_identifier !== identity.systemIdentifier) {
    throw new Error('Koneksi ditolak: identitas cluster PostgreSQL Development tidak cocok.');
  }
  if (database === dbName && checkProof) {
    const proof = await db.query('SELECT proof FROM digiwms_local.identity');
    if (proof.rowCount !== 1 || proof.rows[0].proof !== identity.proof) throw new Error('Koneksi ditolak: penanda database Development tidak cocok.');
  }
}

async function pg(command, args, extra = {}) {
  const executable = path.resolve(pgBin, command + (process.platform === 'win32' ? '.exe' : ''));
  return run(executable, args, { windowsHide: true, timeout: 150_000,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, ...extra });
}

async function startPostgres() {
  // On Windows a restarted postmaster can keep pg_ctl's captured pipes open.
  // Use ignored stdio and PostgreSQL's own -w timeout, with details in postgres.log.
  const executable = path.resolve(pgBin, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['-D', directory, '-l', path.join(root,'postgres.log'), '-o',
      `-h 127.0.0.1 -p ${pgPort}`, '-w', '-t', '40', 'start'], { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('PostgreSQL Development gagal dimulai. Periksa postgres.log.')));
  });
}

async function restrictDirectory() {
  if (process.platform !== 'win32') return;
  const { stdout } = await run('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = stdout.match(/S-1-(?:\d+-)+\d+/)?.[0];
  if (!sid) throw new Error('SID pengguna Windows untuk folder Development tidak dapat diperiksa.');
  await run('icacls.exe', [root, '/inheritance:r', '/grant:r',
    `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true });
}

async function controlId() {
  const { stdout } = await pg('pg_controldata', [directory]);
  const id = stdout.match(/^Database system identifier:\s*(\d+)\s*$/m)?.[1];
  if (!id) throw new Error('System identifier PostgreSQL tidak dapat dibaca.');
  return id;
}

async function clusterRunning() {
  try { await pg('pg_ctl', ['status', '-D', directory]); return true; }
  catch (error) { if (error.code === 3) return false; throw error; }
}

async function assertAvailable(port, host) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, host, () => probe.close(resolve));
  });
}

async function initialize() {
  if (fs.existsSync(root)) {
    const identity = readIdentity();
    await restrictDirectory();
    return identity;
  }
  await fsp.mkdir(path.dirname(root), { recursive: true });
  await fsp.mkdir(root, { mode: 0o700 });
  await restrictDirectory();
  const identity = { kind: 'digiwms-local-development-v1', directory, proof: secret(), dbPassword: secret(), jwtSecret: secret() };
  const passwordFile = path.join(root, 'pg-init.secret');
  await fsp.writeFile(passwordFile, `${identity.dbPassword}\n`, { flag: 'wx', mode: 0o600 });
  try {
    console.log('[Development] Menyiapkan cluster PostgreSQL 16 lokal untuk pertama kali…');
    await pg('initdb', ['-D', directory, '-U', 'postgres', '-A', 'scram-sha-256', '--pwfile='+passwordFile, '--no-locale', '--encoding=UTF8']);
  } finally { await fsp.unlink(passwordFile); }
  identity.systemIdentifier = await controlId();
  await fsp.writeFile(loginFile, randomBytes(24).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 });
  await fsp.writeFile(identityFile, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
  return readIdentity();
}

async function apply(db, name, sql, values = []) {
  const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
  await db.query('BEGIN');
  try {
    await db.query('LOCK TABLE digiwms_local.applied IN EXCLUSIVE MODE');
    const { rows: [prior] } = await db.query('SELECT sha256 FROM digiwms_local.applied WHERE name=$1', [name]);
    if (prior && prior.sha256 !== checksum) throw new Error(`Migrasi Development yang sudah diterapkan berubah (${name}). Gunakan migrasi aditif baru.`);
    if (!prior) {
      await db.query(sql, values);
      await db.query('INSERT INTO digiwms_local.applied(name,sha256) VALUES($1,$2)', [name, checksum]);
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}

const file = relative => fsp.readFile(path.join(repository, relative), 'utf8');
async function applyPickingMigrations(db, identity) {
  await verifyConnection(db, identity);
  for (const name of ['001_orang1_inbound_audit.sql', '002_orang1_picking.sql', '003_orang1_packing.sql', '004_orang1_grn_lines.sql']) {
    const sql = (await file('sql/migrations/'+name)).replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
    await apply(db, name, sql);
  }
}

async function provision(identity) {
  verifyPidFile(identity);
  const admin = new Client(dbOptions(identity, 'postgres'));
  let created = false;
  try {
    await admin.connect();
    await verifyConnection(admin, identity, 'postgres');
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName])).rowCount) {
      await admin.query('CREATE DATABASE digiwms_development');
      created = true;
    }
  } finally { await admin.end(); }
  const db = new Client(dbOptions(identity));
  try {
    await db.connect();
    if (created) {
      await verifyConnection(db, identity, dbName, false);
      await db.query('BEGIN');
      await db.query(`CREATE SCHEMA digiwms_local;
        REVOKE ALL ON SCHEMA digiwms_local FROM PUBLIC;
        CREATE TABLE digiwms_local.identity(proof TEXT PRIMARY KEY);
        CREATE TABLE digiwms_local.applied(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)`);
      await db.query('INSERT INTO digiwms_local.identity VALUES ($1)', [identity.proof]);
      await db.query('COMMIT');
    }
    await verifyConnection(db, identity);
    await apply(db, 'uuid-base-v1', await file('tests/fixtures/supabase-orang1.sql'));
    await apply(db, 'mvp1-compat-v1', await file('sql/development/mvp1-compat.sql'));
    await applyPickingMigrations(db, identity);
    const password = (await fsp.readFile(loginFile, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{32}$/.test(password)) throw new Error('File password akun Development tidak valid.');
    await apply(db, 'sample-data-v1', await file('sql/development/seed.sql'));
    // Preserve a manually changed Development password. Only create a missing account.
    if (!(await db.query("SELECT 1 FROM users WHERE username='admin.dev'")).rowCount) {
      const hash = await bcrypt.hash(password, 12);
      await db.query(`INSERT INTO users(username,email,full_name,role,password_hash)
        VALUES('admin.dev','admin.dev@example.invalid','Admin Development','ADMIN',$1) ON CONFLICT(username) DO NOTHING`, [hash]);
    }
  } finally { await db.end(); }
}

async function startDatabase() {
  await pg('initdb', ['--version']).then(({ stdout }) => {
    if (!/PostgreSQL\) 16\./.test(stdout)) throw new Error('Launcher membutuhkan PostgreSQL 16.');
  }).catch(error => { if (error.code === 'ENOENT') throw new Error('PostgreSQL 16 tidak ditemukan. Set DIGIWMS_DEV_PG_BIN ke folder bin.'); throw error; });
  await assertAvailable(pgPort, '127.0.0.1').catch(error => {
    if (error.code !== 'EADDRINUSE' || !fs.existsSync(identityFile)) throw error;
  });
  const identity = await initialize();
  if (await controlId() !== identity.systemIdentifier) throw new Error('Cluster Development berubah. Startup dihentikan.');
  let owned = false;
  const stop = async () => {
    if (!owned || !(await clusterRunning())) return;
    verifyPidFile(identity);
    await pg('pg_ctl', ['-D', directory, '-m', 'fast', '-w', 'stop']);
  };
  try {
    if (!(await clusterRunning())) {
      await assertAvailable(pgPort, '127.0.0.1');
      try { await startPostgres(); owned = true; }
      catch (error) { if (await clusterRunning()) { owned = true; await stop(); } throw error; }
    }
    await provision(identity);
    return { identity, identityFile, loginFile, stop };
  } catch (error) { await stop(); throw error; }
}

async function archiveDatabase() {
  const identity = readIdentity();
  if (await controlId() !== identity.systemIdentifier || await clusterRunning()) throw new Error('Hentikan cluster Development yang terverifikasi sebelum mengarsipkan.');
  const archive = path.join(path.dirname(root), 'Development-backup-' + Date.now());
  await fsp.rename(root, archive);
  return archive;
}

module.exports = { root, dbOptions, readIdentity, verifyPidFile, verifyConnection, applyPickingMigrations, startDatabase, archiveDatabase, assertAvailable };
