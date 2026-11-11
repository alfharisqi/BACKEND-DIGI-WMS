import { randomBytes } from 'node:crypto';

export type Row = Record<string, any>;
export class InboundError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const fail = (status: number, message: string): never => { throw new InboundError(status, message); };
export const sameId = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b);
export function body(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Body harus berupa objek JSON.');
  return value as Row;
}
export function text(value: unknown, label: string, max = 150): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, `${label} wajib diisi, maksimal ${max} karakter.`);
  return (value as string).trim();
}
export function numeric(value: unknown, label: string, integer = false, minimum = 0, max = 2147483647): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > max || (integer && !Number.isInteger(value))) fail(400, `${label} harus berupa ${integer ? 'bilangan bulat' : 'angka'} antara ${minimum} dan ${max}.`);
  return value as number;
}
export function id(value: unknown): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^(?:[1-9]\d*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(String(value))) fail(400, 'ID harus berupa UUID atau ID numerik sumber data.');
  return String(value);
}
export function productInput(b: Row): Row {
  const price = numeric(b.price !== undefined ? b.price : b.unit_price !== undefined ? b.unit_price : b.price_idr !== undefined ? b.price_idr : 0, 'Harga', false, 0, 9999999999.99);
  if (Math.abs(price * 100 - Math.round(price * 100)) > 0.0001) fail(400, 'Harga maksimal dua angka desimal.');
  const result: Row = {
    sku: text(b.sku, 'SKU', 50), name: text(b.name, 'Nama'), category: text(b.category, 'Kategori', 100),
    price, min_stock_alert: numeric(b.min_stock_alert !== undefined ? b.min_stock_alert : b.min_stock_threshold !== undefined ? b.min_stock_threshold : b.min_stock !== undefined ? b.min_stock : 20, 'Minimum stok', true),
  };
  if (b.default_location_code !== undefined) result.default_location_code = b.default_location_code === null || b.default_location_code === '' ? null : text(b.default_location_code, 'Lokasi default', 100);
  return result;
}
export function grnInput(b: Row): Row {
  if (b.status !== undefined && b.status !== 'MENUNGGU_VERIFIKASI') fail(409, 'Gunakan endpoint verifikasi atau pembatalan untuk perubahan status GRN.');
  if (b.rfid_tagging_status !== undefined && b.rfid_tagging_status !== 'MENUNGGU_TAGGING') fail(409, 'Status RFID tidak dapat dinyatakan selesai tanpa konfirmasi tagging.');
  const date = b.receipt_date === undefined ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) : b.receipt_date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000') || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) fail(400, 'Tanggal penerimaan tidak valid (YYYY-MM-DD).');
  const result: Row = { po_number: text(b.po_number, 'Nomor PO', 50), supplier_name: text(b.supplier_name, 'Supplier'), receipt_date: date, total_qty: numeric(b.total_qty, 'Jumlah barang', true, 1) };
  if (b.product_id != null && b.product_id !== '') result.product_id = id(b.product_id);
  return result;
}
export const tagTypes = ['STANDARD_LABEL', 'ON_METAL', 'HARD_TAG'];
export function tagType(value: unknown): string {
  if (!tagTypes.includes(String(value))) fail(400, 'Tipe tag tidak didukung.');
  return String(value);
}
export function epcInput(value?: unknown): string {
  if (value === undefined || value === '') return randomBytes(12).toString('hex').toUpperCase();
  if (typeof value !== 'string') fail(400, 'EPC harus berupa teks hexadecimal.');
  const epc = (value as string).trim().toUpperCase();
  if (!/^[0-9A-F]{24}$/.test(epc)) fail(400, 'EPC 96-bit harus tepat 24 karakter hexadecimal (0–9, A–F).');
  return epc;
}
