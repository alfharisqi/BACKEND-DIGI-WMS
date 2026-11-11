import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

test('Compiled application boots and serves real HTTP CRUD using isolated fallback', { timeout: 30000 }, async () => {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  // Process-only overrides. Port 1 intentionally has no test DB/broker; existing services are untouched.
  const child = spawn(process.execPath, ['dist/server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), DATABASE_URL: 'postgresql://test_only@127.0.0.1:1/no_database', MQTT_BROKER_URL: 'mqtt://127.0.0.1:1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const request = async (path, payload) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { signal: AbortSignal.timeout(2000), ...(payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}) });
    assert.ok(response.ok); const json = await response.json();
    if (path === '/health') assert.equal(json.status, 'OK');
    else assert.equal(json.success, true);
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
    const grn = (await request('/inbound/grn', { po_number: 'RUNTIME-QA-PO', supplier_name: 'Runtime QA', total_qty: 1 })).data;
    assert.equal(grn.status, 'MENUNGGU_VERIFIKASI');
    const encoded = await request('/tags/encode', { product_id: products[0].id, grn_id: grn.id });
    assert.match(encoded.tag.epc, /^[0-9A-F]{24}$/);
    assert.equal(encoded.item.product_id, products[0].id);
    assert.equal(encoded.hardware_confirmed, false);
  } finally {
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
  }
});
