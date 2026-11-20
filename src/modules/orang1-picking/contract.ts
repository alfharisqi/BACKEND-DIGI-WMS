export const pickingStatuses = ['MENUNGGU_PICKING', 'SEDANG_DIAMBIL', 'SIAP_PACKING'] as const;
export type PickingStatus = typeof pickingStatuses[number];
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const packingFields = ['quantity_checked', 'epc_checked', 'condition_checked', 'packaging_checked', 'label_checked'] as const;
export type PackingChecklist = Record<typeof packingFields[number], boolean>;

export class PickingError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export function scanInput(body: unknown) {
  const input = body as Record<string, unknown> | null;
  if (typeof input?.order_id !== 'string' || !uuidPattern.test(input.order_id)) {
    throw new PickingError(400, 'order_id harus berupa UUID.');
  }
  const epc = typeof input.epc === 'string' ? input.epc.trim().toUpperCase() : '';
  // Native RFID is 96-bit. MVP 1 also assigned 4-group identifiers which must remain usable.
  if (!/^(?:[0-9A-F]{24}|[0-9A-F]{4}(?:-[0-9A-F]{4}){3})$/.test(epc)) {
    throw new PickingError(400, 'EPC harus berisi 24 digit heksadesimal atau memakai format EPC lama yang terdaftar.');
  }
  return { orderId: input.order_id.toLowerCase(), epc };
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
