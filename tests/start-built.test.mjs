import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import jwt from 'jsonwebtoken';

test('Compiled application serves fallback reads and rejects writes without PostgreSQL', { timeout: 30000 }, async () => {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  // Process-only overrides. Port 1 intentionally has no test DB/broker; existing services are untouched.
  const jwtSecret = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, ['dist/server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), JWT_SECRET: jwtSecret, DATABASE_URL: 'postgresql://test_only@127.0.0.1:1/no_database', MQTT_BROKER_URL: 'mqtt://127.0.0.1:1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const request = async (path, { payload, token, status = 200 } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      signal: AbortSignal.timeout(2000),
      ...(payload && { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(payload) }),
    });
    assert.equal(response.status, status, path);
    const json = await response.json();
    if (path === '/health') assert.equal(json.status, 'OK');
    else assert.equal(json.success, status < 400);
    return json;
  };
  try {
    const deadline = Date.now() + 20000;
    while (true) {
      if (child.exitCode !== null) assert.fail(`Application exited: ${output}`);
      try { await request('/health'); break; }
      catch (error) { if (Date.now() > deadline) throw new Error(`Startup failed: ${output}`, { cause: error }); await delay(100); }
    }
    const products = (await request('/products')).data;
    assert.equal(products.length, 6, 'Original fallback seeds remain available');
    const previous = (await request('/inbound/grn')).data;
    const payload = { po_number: 'RUNTIME-QA-PO', supplier_name: 'Runtime QA', total_qty: 1 };
    await request('/inbound/grn', { payload, status: 401 });
    const token = jwt.sign({ id: randomUUID(), role: 'ADMIN' }, jwtSecret, { expiresIn: '1m' });
    await request('/inbound/grn', { payload, token, status: 503 });
    assert.deepEqual((await request('/inbound/grn')).data, previous);
  } finally {
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
  }
});
