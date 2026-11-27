export const pickingStatuses = ['MENUNGGU_PICKING', 'SEDANG_DIAMBIL', 'SIAP_PACKING', 'DIKIRIM', 'DIBATALKAN'] as const;
export type PickingStatus = typeof pickingStatuses[number];
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const packingFields = ['quantity_checked', 'epc_checked', 'condition_checked', 'packaging_checked', 'label_checked'] as const;
export type PackingChecklist = Record<typeof packingFields[number], boolean>;

export class PickingError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export class ScanRejected extends PickingError {}

export const pickingCancellationRole = 'ADMIN';

const cancellationReasons = [
  'STOK_TIDAK_MENCUKUPI', 'BARANG_TIDAK_TERSEDIA', 'PESANAN_PELANGGAN_DIBATALKAN',
  'KESALAHAN_PEMBUATAN_PESANAN', 'KESALAHAN_PEMILIHAN_SKU', 'LAINNYA',
] as const;

export function cancellationInput(body: unknown) {
  const input = body as { reason?: unknown; notes?: unknown; physical_return_confirmed?: unknown; return_scan_ids?: unknown } | null;
  const reason = cancellationReasons.find(value => value === input?.reason);
  if (!reason) throw new PickingError(400, 'Pilih alasan pembatalan yang valid.');
  if (input?.notes != null && typeof input.notes !== 'string') {
    throw new PickingError(400, 'Keterangan pembatalan harus berupa teks.');
  }
  const notes = input?.notes?.trim() || null;
  if (reason === 'LAINNYA' && notes === null) throw new PickingError(400, 'Isi keterangan untuk alasan Lainnya.');
  const physicalReturnConfirmed = input?.physical_return_confirmed ?? false;
  const scanIds = input?.return_scan_ids ?? [];
  if (typeof physicalReturnConfirmed !== 'boolean' || !Array.isArray(scanIds)
    || scanIds.some(id => typeof id !== 'string' || !uuidPattern.test(id))) {
    throw new PickingError(400, 'Konfirmasi pengembalian dan daftar reservasi EPC tidak valid.');
  }
  const returnScanIds = scanIds.map(id => id.toLowerCase());
  if (new Set(returnScanIds).size !== returnScanIds.length || physicalReturnConfirmed !== (returnScanIds.length > 0)) {
    throw new PickingError(400, 'Konfirmasi pengembalian harus cocok dengan daftar reservasi EPC.');
  }
  return { reason, notes, physicalReturnConfirmed, returnScanIds };
}

// Both Picking entry points accept native 96-bit and legacy MVP 1 EPCs.
export const pickingEpcPattern = /^(?:[0-9A-F]{24}|[0-9A-F]{4}(?:-[0-9A-F]{4}){3})$/;

export function scanInput(body: unknown) {
  const input = body as Record<string, unknown> | null;
  if (typeof input?.order_id !== 'string' || !uuidPattern.test(input.order_id)) {
    throw new PickingError(400, 'order_id harus berupa UUID.');
  }
  const epc = typeof input.epc === 'string' ? input.epc.trim().toUpperCase() : '';
  if (!pickingEpcPattern.test(epc)) {
    throw new PickingError(400, 'EPC harus berisi 24 digit heksadesimal atau memakai format EPC lama yang terdaftar.');
  }
  return { orderId: input.order_id.toLowerCase(), epc };
}

export function productIdInput(value: unknown) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new PickingError(400, 'product_id harus berupa UUID.');
  }
  return value.toLowerCase();
}

export function createOrderInput(body: unknown) {
  const input = body as { order_number?: unknown; lines?: unknown } | null;
  const orderNumber = typeof input?.order_number === 'string' ? input.order_number.trim() : '';
  if (!orderNumber || orderNumber.length > 80) {
    throw new PickingError(400, 'Nomor pesanan picking wajib diisi (maks 80 karakter).');
  }
  if (!Array.isArray(input?.lines) || !input.lines.length) {
    throw new PickingError(400, 'Minimal 1 baris produk/SKU wajib dipilih untuk pesanan picking.');
  }
  const quantities = new Map<string, number>();
  for (const value of input.lines) {
    const line = value as { product_id?: unknown; requested_qty?: unknown } | null;
    const productId = productIdInput(line?.product_id);
    const quantity = line?.requested_qty;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
      throw new PickingError(400, 'Jumlah unit harus berupa bilangan bulat positif.');
    }
    const total = (quantities.get(productId) ?? 0) + quantity;
    if (total > 2147483647) throw new PickingError(400, 'Jumlah unit melebihi batas yang dapat disimpan.');
    quantities.set(productId, total);
  }
  return { orderNumber, lines: Array.from(quantities, ([productId, quantity]) => ({ productId, quantity })) };
}

export function statusInput(query: unknown): PickingStatus | null {
  const status = (query as { status?: unknown }).status;
  if (status === undefined) return null;
  if (pickingStatuses.some(value => value === status)) return status as PickingStatus;
  throw new PickingError(400, 'Status picking tidak valid.');
}

export function orderIdInput(value: unknown) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new PickingError(400, 'ID pesanan harus berupa UUID.');
  return value.toLowerCase();
}

export function packingRevision(body: unknown) {
  const revision = (body as { revision?: unknown } | null)?.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0 || revision >= 2147483647) {
    throw new PickingError(400, 'Revisi checklist tidak valid.');
  }
  return revision;
}

export function checklistInput(body: unknown) {
  const revision = packingRevision(body);
  const input = (body as { checklist?: Record<string, unknown> }).checklist;
  if (!input || typeof input !== 'object' || Object.keys(input).length !== packingFields.length
      || !packingFields.every(field => typeof input[field] === 'boolean')) {
    throw new PickingError(400, 'Checklist harus memuat lima pemeriksaan dengan nilai boolean.');
  }
  return { revision, checklist: input as PackingChecklist };
}
