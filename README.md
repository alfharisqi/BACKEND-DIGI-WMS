# BACKEND DIGI WMS (Fastify + TypeScript + PostgreSQL + EMQX MQTT)

Repositori Backend API, Skema Database PostgreSQL (13 Tabel Inti + Immutable Stock Ledger), dan Docker Compose (PostgreSQL + EMQX MQTT Broker) untuk sistem **DIGI WMS**.

## Pembagian Modul Tim (`src/modules/`)
1. **Orang 1 (`src/modules/orang1-inbound/routes.ts`):** Master SKU, Dokumen Penerimaan (GRN) & Encoding Tag RFID.
2. **Orang 2 (`src/modules/orang2-inventory/routes.ts`):** Lokasi Rak, Putaway & Buku Besar Mutasi Stok (*Append-Only Ledger* + Publish EMQX `wms/stock/realtime`).
3. **Orang 3 (`src/modules/orang3-opname/routes.ts`):** Sesi Stock Opname Handheld RFID, Analisis Selisih & Approval ke Ledger.
4. **Orang 4 (`src/modules/orang4-dashboard/routes.ts`):** Health Check, Metrik KPI Dashboard & Manajemen User.

## Cara Menjalankan
```bash
# 1. (Opsional) Nyalakan PostgreSQL & EMQX via Docker
docker compose up -d

# 2. Install & jalankan server Backend API (Port 5000)
npm install
npm run dev
```
Server aktif di **`http://localhost:5000`** (Dilengkapi *In-Memory Ledger Fallback* sehingga tetap berjalan penuh meskipun Docker belum aktif).
