// Opt-in only: explicit user approval required. One synthetic publish, dedicated unique QA topic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';

test('Real EMQX: one approved QA publish reaches isolated TCP and WebSocket observers', { skip: process.env.ORANG1_QA_MQTT_ALLOW_PUBLISH !== '1', timeout: 20000 }, async () => {
  const correlation = randomUUID(), topic = `wms/qa/orang1/mqtt-test/${correlation}`;
  const clients: mqtt.MqttClient[] = [];
  const connect = async (url: string, name: string) => {
    const client = mqtt.connect(url, { clientId: `orang1_qa_${name}_${correlation}`, clean: true, reconnectPeriod: 0, connectTimeout: 5000 });
    clients.push(client);
    await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('error', reject); });
    await client.subscribeAsync(topic, { qos: 1 });
    return client;
  };
  let publisher: mqtt.MqttClient | undefined;
  try {
    const tcp = await connect('mqtt://127.0.0.1:1883', 'tcp');
    const ws = await connect('ws://127.0.0.1:8083/mqtt', 'ws');
    // Process-only endpoint/client ID overrides. No broker or .env configuration is changed.
    process.env.MQTT_BROKER_URL = 'mqtt://127.0.0.1:1883';
    process.env.MQTT_CLIENT_ID_PREFIX = 'orang1_qa_publisher_';
    const { initMqttClient, publishRealtimeEvent } = await import('../src/config/mqtt');
    publisher = initMqttClient();
    await new Promise<void>((resolve, reject) => { publisher!.once('connect', () => resolve()); publisher!.once('error', reject); });
    const receive = (client: mqtt.MqttClient) => new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('QA message not received')), 5000);
      client.on('message', (receivedTopic, buffer) => {
        if (receivedTopic !== topic) return;
        clearTimeout(timeout); resolve(JSON.parse(buffer.toString()));
      });
    });
    const received = Promise.all([receive(tcp), receive(ws)]);
    publishRealtimeEvent(topic, { qa: true, business_event: false, purpose: 'MQTT_TRANSPORT_ONLY', correlation_id: correlation });
    for (const message of await received) {
      assert.equal(message.correlation_id, correlation); assert.equal(message.business_event, false);
      assert.equal(message.qa, true); assert.equal(typeof message.timestamp, 'number');
      assert.equal(message.product_id, undefined); assert.equal(message.epc, undefined);
    }
    console.log(`QA topic only: ${topic}; synthetic publishes=1; TCP and WebSocket receive=PASS; no RFID/business event`);
  } finally {
    await Promise.allSettled([...clients, ...(publisher ? [publisher] : [])].map(client => client.endAsync(true)));
  }
});
