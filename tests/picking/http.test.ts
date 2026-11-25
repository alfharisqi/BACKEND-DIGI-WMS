import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { qaPort, startPickingQa } from './qa';
import { qaScenario } from './scenario';

const apiUrl = `http://127.0.0.1:${qaPort}/api`;
const uiUrl = 'http://127.0.0.1:5178';
const root = path.resolve('tests/picking');
const evidence = process.env.ORANG1_PICKING_EVIDENCE_DIR ?? path.join(root, 'evidence');
const toolsDir = process.env.ORANG1_PICKING_TEST_TOOLS ?? path.join(os.tmpdir(), 'digiwms-mvp2-tools');
const testRequire = createRequire(path.join(toolsDir, 'package.json'));
const uiDist = process.env.ORANG1_PICKING_UI_DIST;
const chrome = process.env.ORANG1_PICKING_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let qa: Awaited<ReturnType<typeof startPickingQa>>;
before(async () => {
  await mkdir(evidence, { recursive: true });
  qa = await startPickingQa({ http: true });
  const health = await fetch(apiUrl + '/health').then(r => r.json()) as { qa: { kind: string; isolated: boolean } };
  assert.equal(health.qa.kind, 'digiwms-picking-disposable-pg');
  assert.equal(health.qa.isolated, true);
});
after(async () => { if (qa) await qa.close(); });

test('Newman: execute all 8 requests on the attested disposable QA HTTP listener', {
  skip: !existsSync(path.join(toolsDir, 'node_modules/newman')),
}, async () => {
  const fixture = await qaScenario(qa.pool, 'NEWMAN');
  const order = await fixture.order('01');
  const values: Record<string, string> = {
    qaToken: qa.token(),
    orderNumber: order.number,
    validEpc: (await fixture.item()).epc,
    secondEpc: (await fixture.item({ locationId: fixture.racks.alternate })).epc,
    extraEpc: (await fixture.item()).epc,
    wrongProductEpc: (await fixture.item({ productId: fixture.products.other })).epc,
    missingOrderId: randomUUID(),
  };
  const collection = JSON.parse(await readFile(path.join(root, 'DigiWMS_MVP2_Picking_QA.postman_collection.json'), 'utf8'));
  const environment = JSON.parse(await readFile(path.join(root, 'DigiWMS_MVP2_Picking_QA.postman_environment.json'), 'utf8'));
  environment.values.forEach((variable: { key: string; value: string }) => {
    variable.value = values[variable.key] ?? variable.value;
  });
  assert.equal(environment.values.find((v: { key: string }) => v.key === 'baseUrl').value, apiUrl);
  const newman = testRequire('newman');
  const result: any = await new Promise((resolve, reject) => {
    newman.run({ collection, environment, reporters: [], bail: true, timeout: 30_000, timeoutRequest: 5000 }, (error: Error | null, summary: unknown) => {
      if (error) reject(error);
      else resolve(summary);
    });
  });
  // The raw Newman summary includes authorization headers. Only write safe aggregate/item fields.
  const executions = [...new Map(result.run.executions.map((event: any) => [event.item.id, event])).values()] as any[];
  const rows = executions.map(event => ({
    name: event.item.name, status: event.response?.code ?? null,
    assertions: (event.assertions ?? []).map((assertion: any) => ({ name: assertion.assertion, status: assertion.skipped ? 'SKIP' : assertion.error ? 'FAIL' : 'PASS' })),
  }));
  const assertions = rows.flatMap(row => row.assertions);
  const stats = {
    recordedAt: new Date().toISOString(), version: testRequire('newman/package.json').version,
    postgres: qa.version, target: apiUrl, collectionRequests: rows.length, totalHttp: result.run.stats.requests.total,
    passed: assertions.filter(a => a.status === 'PASS').length,
    failed: assertions.filter(a => a.status === 'FAIL').length,
    skipped: assertions.filter(a => a.status === 'SKIP').length,
    runnerFailures: result.run.failures.length, requests: rows,
  };
  await writeFile(path.join(evidence, 'newman.json'), JSON.stringify(stats, null, 2) + '\n');
  assert.equal(stats.runnerFailures, 0);
  assert.equal(stats.collectionRequests, collection.item.length);
  assert.equal(stats.passed, 24);
  assert.equal(stats.failed + stats.skipped, 0);
  console.log(`Newman: ${stats.collectionRequests} request, ${stats.passed} assertion PASS, ${stats.failed} FAIL, ${stats.skipped} SKIP`);
});

test('Chrome: login, actual sidebar, rack, EPC checklist, packing checklist, reload and tablet', {
  skip: !uiDist || !existsSync(path.join(toolsDir, 'node_modules/playwright-core')) || !existsSync(chrome),
}, async () => {
  const fixture = await qaScenario(qa.pool, 'BROWSER');
  const order = await fixture.order('01');
  const first = await fixture.item();
  const second = await fixture.item({ locationId: fixture.racks.alternate });
  const wrong = await fixture.item({ productId: fixture.products.other });
  const base = path.resolve(uiDist!);
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const staticServer = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', uiUrl).pathname;
      const filename = path.resolve(base, pathname === '/' ? 'index.html' : '.' + pathname);
      assert.ok(filename.startsWith(base + path.sep));
      res.setHeader('Content-Type', types[path.extname(filename)] ?? 'application/octet-stream');
      res.end(await readFile(filename));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((resolve, reject) => {
    staticServer.once('error', reject);
    staticServer.listen(5178, '127.0.0.1', resolve);
  });
  const { chromium } = testRequire('playwright-core');
  const steps: string[] = [];
  let browser: any;
  try {
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    // Reject non-QA API URLs and external MQTT/assets for this browser run.
    await context.route('**/*', (route: any) => {
      const origin = new URL(route.request().url()).origin;
      return [uiUrl, new URL(apiUrl).origin].includes(origin) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    let pageErrors = 0;
    page.on('pageerror', () => { pageErrors++; });
    await page.goto(uiUrl);
    await page.getByPlaceholder(/Contoh: admin/).fill(qa.actor.username);
    await page.getByPlaceholder(/Masukkan password/).fill(qa.password);
    const authenticated = page.waitForResponse((response: any) => response.url() === apiUrl + '/auth/login' && response.request().method() === 'POST');
    await page.getByRole('button', { name: /Masuk ke Sistem/ }).click();
    assert.equal((await authenticated).status(), 200);
    const navigation = page.getByRole('button', { name: /Picking & Packing/ });
    await navigation.waitFor();
    steps.push('Login QA melalui halaman login existing');

    const ordersUrl = apiUrl + '/picking/orders';
    const loaded = page.waitForResponse((response: any) =>
      response.url() === ordersUrl && response.request().method() === 'GET');
    await navigation.click();
    assert.equal((await loaded).status(), 200);
    const column = (name: string) => page.getByRole('region', { name, exact: true });
    const cardIn = (name: string) => column(name).getByRole('article', { name: order.number });
    const waitingCard = cardIn('Menunggu Picking');
    await waitingCard.getByText(/Rak Fisik QA/).waitFor();
    assert.match(await waitingCard.innerText(), new RegExp(fixture.code));
    assert.match(await waitingCard.innerText(), new RegExp(fixture.sku));
    assert.match(await waitingCard.innerText(), /0\/2/);
    for (const name of ['Menunggu Picking', 'Sedang Diambil', 'Siap Packing']) await column(name).waitFor();
    steps.push('Navigasi Picking, HTTP 200, tiga kolom Kanban, SKU/rak/progres dari API');

    const search = page.getByPlaceholder('Cari nomor pesanan, SKU, atau produk');
    await search.fill(fixture.sku);
    assert.equal(await page.getByRole('article').count(), 1);
    await page.getByRole('combobox', { name: 'Filter status picking' }).selectOption('MENUNGGU_PICKING');
    assert.equal(await page.getByRole('region', { name: 'Siap Packing', exact: true }).count(), 0);
    await page.getByRole('combobox', { name: 'Filter status picking' }).selectOption('');
    await waitingCard.getByRole('button', { name: 'Mulai Picking' }).click();
    const dialog = page.getByRole('dialog');
    const firstCandidate = dialog.getByRole('checkbox', { name: new RegExp(first.epc) });
    const secondCandidate = dialog.getByRole('checkbox', { name: new RegExp(second.epc) });
    await firstCandidate.waitFor();
    assert.equal(await dialog.getByRole('checkbox', { name: new RegExp(wrong.epc) }).count(), 0);
    assert.equal(await dialog.getByRole('textbox').count(), 0);
    await waitingCard.waitFor();
    steps.push('Pencarian SKU, filter status dan Mulai Picking menampilkan kandidat SKU tanpa memindahkan kartu');

    assert.match(await dialog.innerText(), /0\/2/);
    await firstCandidate.focus();
    await page.keyboard.press('Space');
    await dialog.getByRole('button', { name: 'Validasi Scan (1 EPC)', exact: true }).click();
    await dialog.getByText('1 berhasil · 0 ditolak.', { exact: true }).waitFor();
    assert.match(await dialog.innerText(), /1\/2/);
    assert.ok(await cardIn('Sedang Diambil').count());
    steps.push('EPC dapat dipilih lewat keyboard dan progres tersimpan 1/2');

    await secondCandidate.check();
    await dialog.getByRole('button', { name: 'Validasi Scan (1 EPC)', exact: true }).click();
    await dialog.getByText('2/2', { exact: true }).waitFor();
    await dialog.getByText(first.epc, { exact: true }).waitFor();
    await dialog.getByText(second.epc, { exact: true }).waitFor();
    assert.match(await dialog.innerText(), /2\/2/);
    await dialog.getByRole('button', { name: 'Tutup' }).click();
    await cardIn('Siap Packing').waitFor();
    steps.push('EPC kedua melengkapi checklist, kartu pindah ke Siap Packing dari respons API');

    await page.reload();
    await navigation.click();
    await cardIn('Siap Packing').getByRole('button', { name: 'Checklist Packing' }).click();
    await dialog.getByText(first.epc, { exact: true }).waitFor();
    assert.match(await dialog.innerText(), new RegExp(first.epc));
    assert.match(await dialog.innerText(), new RegExp(second.epc));
    await dialog.getByRole('button', { name: 'Tutup' }).click();
    steps.push('Reload aplikasi mempertahankan kedua scan dan kolom Siap Packing');

    for (const width of [1440, 820]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const board = column('Siap Packing');
      const box = await board.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1);
    }
    await cardIn('Siap Packing').getByRole('button', { name: 'Checklist Packing' }).click();
    await dialog.getByRole('checkbox').first().waitFor();
    assert.equal(pageErrors, 0);
    await page.screenshot({ path: path.join(evidence, 'packing-tablet.png') });
    await dialog.getByRole('button', { name: 'Tutup' }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(evidence, 'kanban-desktop.png') });
    steps.push('Desktop 1440 px, tablet 820 px, checklist dapat dibuka dan tanpa error JavaScript');

    // Trigger an actual HTTP 503 from the QA backend. Restore the disposable table even on timeout.
    const errorAlert = page.getByRole('alert').filter({ hasText: 'Database atau skema Picking belum tersedia.' });
    await qa.pool.query('ALTER TABLE picking_orders RENAME TO qa_picking_orders');
    try {
      await page.getByRole('button', { name: 'Muat Ulang' }).click();
      await errorAlert.waitFor({ timeout: 6000 });
      await cardIn('Siap Packing').waitFor();
    } finally {
      await qa.pool.query('ALTER TABLE qa_picking_orders RENAME TO picking_orders');
    }
    await page.getByRole('button', { name: 'Muat Ulang' }).click();
    await errorAlert.waitFor({ state: 'hidden' });
    await page.getByText('Memuat pesanan…').waitFor({ state: 'hidden' });
    await cardIn('Siap Packing').waitFor();
    steps.push('HTTP 503 nyata ditampilkan, daftar terakhir dipertahankan, refresh pulih');
    await writeFile(path.join(evidence, 'browser.json'), JSON.stringify({
      recordedAt: new Date().toISOString(), browser: browser.version(), target: apiUrl,
      passed: steps.length, failed: 0, skipped: 0, steps, pageErrors, physicalReaderTested: false,
    }, null, 2) + '\n');
    console.log(`Chrome: ${steps.length} tahap UI PASS`);
  } catch (error) {
    console.log('Tahap UI yang telah terverifikasi: ' + steps.join(' | '));
    throw error;
  } finally {
    await browser?.close();
    await new Promise<void>(resolve => staticServer.close(() => resolve()));
  }
});
