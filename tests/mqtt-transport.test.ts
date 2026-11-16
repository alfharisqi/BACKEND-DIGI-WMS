// Real MQTT TCP packets against an isolated protocol simulator; this is not an EMQX certification test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import mqttPacket from 'mqtt-packet';

test('Existing MQTT helper publishes only successful committed encoding over MQTT TCP', { timeout: 15000 }, async () => {
  const messages: any[] = [], sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const parser = mqttPacket.parser(); socket.on('data', chunk => parser.parse(chunk));
    const send = (packet: any) => socket.write(mqttPacket.generate(packet));
    parser.on('packet', (packet: any) => {
      if (packet.cmd === 'connect') send({ cmd: 'connack', returnCode: 0, sessionPresent: false });
      if (packet.cmd === 'subscribe') send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => 0) });
      if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
      if (packet.cmd === 'publish') {
        messages.push({ topic: packet.topic, payload: JSON.parse(packet.payload.toString()) });
        if (packet.qos === 1) send({ cmd: 'puback', messageId: packet.messageId });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  process.env.MQTT_BROKER_URL = `mqtt://127.0.0.1:${port}`;
  const { initMqttClient } = await import('../src/config/mqtt');
  const client = initMqttClient();
  const { default: Fastify } = await import('fastify');
  const { orang1InboundRoutes } = await import('../src/modules/orang1-inbound/routes');
  const { MemoryRepository } = await import('../src/modules/orang1-inbound/repository');
  const uuid = '18b635db-0ec3-41b1-a1ec-e15da1438ce2';
  const source = { products: [{ id: uuid, sku: 'MQTT-QA', name: 'MQTT QA', category: 'QA', price: 0, min_stock_alert: 0 }], tags: [], items: [], goods_receipts: [], stock_movements: [], gate_events: [] };
  const repository = new MemoryRepository(source), app = Fastify();
  try {
    if (!client.connected) await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('error', reject); });
    await app.register(orang1InboundRoutes, { repository });
    const payload = { product_id: uuid, epc_custom: '300833B2DDD9014000000099' };
    const response = await app.inject({ method: 'POST', url: '/api/tags/encode', payload });
    assert.equal(response.statusCode, 201);
    const deadline = Date.now() + 3000;
    while (!messages.length && Date.now() < deadline) await delay(10);
    assert.equal(messages.length, 1); assert.equal(messages[0].topic, 'wms/tags/encoded');
    assert.equal(messages[0].payload.product_id, uuid); assert.equal(messages[0].payload.hardware_confirmed, false);
    assert.equal(messages[0].payload.mode, 'simulation'); assert.equal(typeof messages[0].payload.timestamp, 'number');
    assert.equal((await repository.all('tags')).length, 1); assert.equal((await repository.all('items')).length, 1);
    assert.equal((await app.inject({ method: 'POST', url: '/api/tags/encode', payload })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: '/api/tags/encode', payload: { ...payload, epc_custom: 'INVALID' } })).statusCode, 400);
    await delay(100); assert.equal(messages.length, 1, 'Failed operations must not publish MQTT');
  } finally {
    await app.close(); await client.endAsync(true);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
