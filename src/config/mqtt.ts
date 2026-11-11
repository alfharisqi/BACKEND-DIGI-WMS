import mqtt, { MqttClient } from 'mqtt';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const CLIENT_ID = `${process.env.MQTT_CLIENT_ID_PREFIX || 'digiwms_api_'}${Math.random()
  .toString(16)
  .substring(2, 8)}`;

export let mqttClient: MqttClient | null = null;
let hasLoggedOfflineNotice = false;

export function initMqttClient(): MqttClient {
  mqttClient = mqtt.connect(BROKER_URL, {
    clientId: CLIENT_ID,
    clean: true,
    connectTimeout: 3000,
    reconnectPeriod: 0, // Jangan spam reconnect jika Docker EMQX belum dinyalakan
  });

  mqttClient.on('connect', () => {
    hasLoggedOfflineNotice = false;
    console.log(`[EMQX MQTT] Terhubung ke broker ${BROKER_URL} sebagai ${CLIENT_ID}`);

    mqttClient?.subscribe(['digiwms/#', 'wms/opname/+/scan', 'wms/gate/+/read'], (err) => {
      if (!err) {
        console.log('[EMQX MQTT] Aktif mendengarkan topik: digiwms/#, wms/opname/+/scan & wms/gate/+/read');
      }
    });
  });

  mqttClient.on('error', () => {
    if (!hasLoggedOfflineNotice) {
      hasLoggedOfflineNotice = true;
      console.log(
        `[EMQX MQTT] Broker Docker (${BROKER_URL}) belum aktif -> Mode Simulasi HTTP/Memory siap digunakan`
      );
    }
    mqttClient?.end(true);
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
