import mqtt, { MqttClient } from 'mqtt';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const CLIENT_ID = `${process.env.MQTT_CLIENT_ID_PREFIX || 'digiwms_api_'}${Math.random()
  .toString(16)
  .substring(2, 8)}`;

export let mqttClient: MqttClient | null = null;

export function initMqttClient(): MqttClient {
  mqttClient = mqtt.connect(BROKER_URL, {
    clientId: CLIENT_ID,
    clean: true,
    connectTimeout: 4000,
    reconnectPeriod: 3000,
  });

  mqttClient.on('connect', () => {
    console.log(`[EMQX MQTT] Terhubung ke broker ${BROKER_URL} sebagai ${CLIENT_ID}`);

    // Subscribe topik dari Handheld Opname & Gate Reader
    mqttClient?.subscribe(['wms/opname/+/scan', 'wms/gate/+/read'], (err) => {
      if (!err) {
        console.log('[EMQX MQTT] Aktif mendengarkan topik: wms/opname/+/scan & wms/gate/+/read');
      }
    });
  });

  mqttClient.on('error', (err) => {
    console.warn('[EMQX MQTT] Peringatan koneksi broker:', err.message);
  });

  return mqttClient;
}

/**
 * Helper untuk mem-publish pesan live update ke EMQX Broker
 * Diterima langsung oleh Frontend React.js via MQTT over WebSocket (Port 8083)
 */
export function publishRealtimeEvent(topic: string, payload: Record<string, unknown>): void {
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(topic, JSON.stringify({ ...payload, timestamp: Date.now() }), { qos: 1 });
  }
}
