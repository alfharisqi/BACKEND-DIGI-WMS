import { Repository } from './repository';
import { epcInput, fail, grnInput, id, productInput, Row, sameId, tagType, text } from './validation';
import { canonicalTagType, nativeTagTypes } from './schema-contract';

type Publisher = (topic: string, payload: Row) => void;
const pending = 'MENUNGGU_VERIFIKASI';
export class InboundService {
  constructor(private repo: Repository, private publish: Publisher) {}
  private async required(repo: Repository, table: 'products' | 'goods_receipts' | 'tags', value: string) {
    const row = await repo.get(table, value);
    if (!row) fail(404, table === 'products' && value.includes('-')
      ? 'Produk UUID tidak ditemukan pada sumber data aktif; identitas tidak diganti atau dikonversi.'
      : 'Data tidak ditemukan.');
    return row!;
  }
  private async unique(repo: Repository, table: 'products' | 'goods_receipts' | 'tags', field: string, value: string, except?: string) {
    if ((await repo.all(table)).some(row => row[field] === value && !sameId(row.id, except))) fail(409, `${field === 'sku' ? 'SKU' : field === 'po_number' ? 'Nomor PO' : 'EPC'} sudah terdaftar.`);
  }
  async products(value?: string): Promise<Row[]> {
    const rows = value ? [await this.required(this.repo, 'products', value)] : await this.repo.all('products');
    // Supabase exposes the existing stock projection on products. Never overwrite it with
    // an incomplete legacy ledger or infer physical stock from one RFID tag.
    const movements = rows.some(row => row.current_stock == null) ? await this.repo.all('stock_movements') : [];
    return rows.map(row => ({ ...row, price: row.price ?? row.unit_price, unit_price: row.unit_price ?? row.price,
      // Keep the shared dashboard/CSV contract from main alongside canonical inbound fields.
      price_idr: row.price_idr ?? row.unit_price ?? row.price,
      min_stock: row.min_stock ?? row.min_stock_threshold ?? row.min_stock_alert,
      min_stock_alert: row.min_stock_alert ?? row.min_stock_threshold,
      min_stock_threshold: row.min_stock_threshold ?? row.min_stock_alert,
      current_stock: row.current_stock ?? movements.filter(m => m.product_id != null ? sameId(m.product_id, row.id) : m.sku === row.sku)
        .reduce((sum, m) => sum + Number(m.qty ?? m.qty_change), 0),
      stock_source: row.current_stock != null ? 'products.current_stock' : 'stock_movements' }));
  }
  private async supportedStatus(repo: Repository, table: 'goods_receipts' | 'tags', status: string) {
    const values = await repo.allowedValues(table, 'status');
    if (values && !values.includes(status)) fail(409, `Skema database aktif belum mendukung status ${status}. Perubahan tidak disimpan; perubahan constraint memerlukan review dan persetujuan terpisah.`);
  }
  private async tagFields(repo: Repository, type: string): Promise<Row> {
    const columns = await repo.columns('tags');
    if (columns.includes('type')) return { type };
    if (!columns.includes('tag_type')) fail(409, 'Skema tag tidak memiliki kolom tipe yang didukung.');
    const values = await repo.allowedValues('tags', 'tag_type');
    const value = values?.includes(type) ? type : nativeTagTypes[type];
    if (!value || (values && !values.includes(value))) fail(409, 'Tipe tag tidak sesuai constraint database aktif.');
    return { tag_type: value };
  }
  private async itemFields(repo: Repository, data: Row): Promise<Row> {
    // Supabase defaults items.status to IN_STOCK. Desk registration must explicitly stay ENCODED.
    return (await repo.columns('items')).includes('status') ? { ...data, status: 'ENCODED' } : data;
  }
  private async productColumns(repo: Repository, input: Row) {
    const columns = await repo.columns('products');
    const result = { ...input };
    if (!columns.includes('price') && columns.includes('unit_price')) { result.unit_price = result.price; delete result.price; }
    if (!columns.includes('min_stock_alert') && columns.includes('min_stock_threshold')) { result.min_stock_threshold = result.min_stock_alert; delete result.min_stock_alert; }
    if ('default_location_code' in result && !columns.includes('default_location_code')) {
      if (result.default_location_code) fail(400, 'Skema aktif belum mendukung lokasi default produk.');
      delete result.default_location_code;
    }
    return result;
  }
  async saveProduct(b: Row, value?: string) {
    const input = productInput(b);
    return this.repo.transaction(async repo => {
      const old = value ? structuredClone(await this.required(repo, 'products', value)) : null;
      await this.unique(repo, 'products', 'sku', input.sku, value);
      // Legacy fallback tags may only carry a SKU. Do not break those associations.
      if (old && old.sku !== input.sku && (await repo.all('tags')).some(t => t.sku === old.sku && t.product_id == null)) fail(409, 'SKU masih digunakan tag legacy; pertahankan SKU agar relasinya tidak terputus.');
      if (old && old.sku !== input.sku && (await repo.all('stock_movements')).some(m => m.product_id == null && m.sku === old.sku)) fail(409, 'SKU masih menjadi identitas ledger legacy tanpa UUID produk; perubahan SKU ditolak agar riwayat tidak terputus.');
      const fields = await this.productColumns(repo, input);
      const row = value ? await repo.update('products', value, fields) : await repo.insert('products', fields);
      await repo.audit('product', row.id, value ? 'UPDATE' : 'CREATE', old, row);
      return row;
    });
  }
  async deleteProduct(value: string) {
    return this.repo.transaction(async repo => {
      const row = await this.required(repo, 'products', value);
      if (Number(row.current_stock ?? 0) > 0) fail(409, 'Produk masih memiliki stok tercatat dan tidak dapat dihapus.');
      const items = await repo.all('items');
      const tags = await repo.all('tags');
      const grns = await repo.all('goods_receipts');
      const movements = await repo.all('stock_movements');
      if (items.some(i => sameId(i.product_id, row.id)) || tags.some(t => sameId(t.product_id, row.id) || t.sku === row.sku) || grns.some(g => sameId(g.product_id, row.id)) || movements.some(m => sameId(m.product_id, row.id) || m.sku === row.sku)) fail(409, 'Produk memiliki relasi GRN, item, tag, atau mutasi stok dan tidak dapat dihapus.');
      await repo.audit('product', row.id, 'DELETE', row, {});
      await repo.removeProduct(value);
      return { id: row.id };
    });
  }
  async grns(value?: string) {
    if (!value) return this.repo.all('goods_receipts');
    const row = await this.required(this.repo, 'goods_receipts', value);
    return { ...row, audit_history: await this.repo.history('grn', value) };
  }
  private async grnUnused(repo: Repository, row: Row) {
    const items = await repo.all('items');
    const linked = items.filter(i => sameId(i.grn_id, row.id));
    const movements = await repo.all('stock_movements');
    if (movements.some(m => m.reference_doc === row.po_number || linked.some(i => sameId(i.id, m.item_id)))) fail(409, 'GRN sudah berdampak pada stok/putaway. Diperlukan reversal terotorisasi; ledger tidak diubah.');
    if (linked.length) fail(409, 'GRN memiliki item/tag terkait. Selesaikan penanganan relasi sebelum mengubah atau membatalkan penerimaan.');
  }
  async saveGrn(b: Row, value?: string) {
    const input = grnInput(b);
    return this.repo.transaction(async repo => {
      const old = value ? structuredClone(await this.required(repo, 'goods_receipts', value)) : null;
      if (old) {
        if (old.status !== pending) fail(409, 'Hanya GRN menunggu verifikasi yang boleh diedit.');
        await this.grnUnused(repo, old);
      }
      await this.unique(repo, 'goods_receipts', 'po_number', input.po_number, value);
      if (input.product_id) {
        const product = await this.required(repo, 'products', input.product_id);
        if (!(await repo.columns('goods_receipts')).includes('product_id')) fail(400, 'Skema GRN aktif tidak memiliki kolom produk. Tautkan produk melalui tag/item dengan grn_id.');
        input.product_id = product.id;
      }
      const row = value ? await repo.update('goods_receipts', value, input) : await repo.insert('goods_receipts', { ...input, status: pending, rfid_tagging_status: 'MENUNGGU_TAGGING' });
      await repo.audit('grn', row.id, value ? 'UPDATE' : 'CREATE', old, row);
      return row;
    });
  }
  async verifyGrn(value: string) {
    return this.repo.transaction(async repo => {
      const old = structuredClone(await this.required(repo, 'goods_receipts', value));
      if (old.status !== pending) fail(409, 'GRN hanya dapat diverifikasi satu kali dari status menunggu verifikasi.');
      const fields: Row = { status: 'SELESAI' };
      if ((await repo.columns('goods_receipts')).includes('verified_at')) fields.verified_at = new Date().toISOString();
      const row = await repo.update('goods_receipts', value, fields);
      await repo.audit('grn', row.id, 'VERIFY', old, row, undefined, true);
      return row;
    });
  }
  async cancelGrn(value: string, b: Row) {
    const reason = text(b.reason, 'Alasan pembatalan', 1000);
    return this.repo.transaction(async repo => {
      const old = structuredClone(await this.required(repo, 'goods_receipts', value));
      if (old.status !== pending) fail(409, 'Pembatalan sederhana hanya untuk GRN menunggu verifikasi; GRN selesai memerlukan prosedur reversal terotorisasi.');
      await this.grnUnused(repo, old);
      await this.supportedStatus(repo, 'goods_receipts', 'DIBATALKAN');
      const row = await repo.update('goods_receipts', value, { status: 'DIBATALKAN' });
      await repo.audit('grn', row.id, 'CANCEL', old, row, reason, true);
      return row;
    });
  }
  async tags(value?: string) {
    const rows = value ? [await this.required(this.repo, 'tags', value)] : await this.repo.all('tags');
    const [items, products, locations] = await Promise.all([this.repo.all('items'), this.repo.all('products'), this.repo.all('locations')]);
    const result = rows.map(tag => {
      const item = items.find(i => sameId(i.tag_id, tag.id));
      const product = products.find(p => sameId(p.id, item?.product_id ?? tag.product_id) || (!item && tag.product_id == null && p.sku === tag.sku));
      return { ...tag, type: canonicalTagType(tag.type ?? tag.tag_type), product_id: product?.id ?? null, sku: product?.sku ?? tag.sku, product_name: product?.name ?? tag.product_name,
        item_id: item?.id, grn_id: item?.grn_id ?? null, location_id: item?.location_id ?? null,
        rack_name: locations.find(location => sameId(location.id, item?.location_id))?.rack_name
          ?? locations.find(location => sameId(location.id, item?.location_id))?.name ?? tag.rack_name ?? null };
    });
    return value ? { ...result[0], audit_history: await this.repo.history('tag', value) } : result;
  }
  private event(tag: Row, item: Row, product: Row) {
    // Database commit is already complete. Broker failure cannot undo saved data.
    try { this.publish('wms/tags/encoded', { epc: tag.epc, product_id: product.id, tag_id: tag.id, item_id: item.id, status: 'ENCODED', mode: 'simulation', hardware_confirmed: false }); }
    catch { /* Best effort MQTT; durable outbox is a separate future integration. */ }
  }
  async encode(b: Row) {
    if (b.mode !== undefined && b.mode !== 'simulation') fail(409, 'Encoding hardware belum didukung: reader/SDK dan konfirmasi perangkat belum tersedia.');
    if (b.status !== undefined && b.status !== 'ENCODED') fail(409, 'Registrasi meja hanya menghasilkan status ENCODED.');
    const productId = id(b.product_id);
    const epc = epcInput(b.epc_custom !== undefined ? b.epc_custom : b.epc);
    const type = tagType(b.type !== undefined ? b.type : 'STANDARD_LABEL');
    const result = await this.repo.transaction(async repo => {
      const product = await this.required(repo, 'products', productId);
      await this.unique(repo, 'tags', 'epc', epc);
      let grn: Row | undefined;
      if (b.grn_id != null && b.grn_id !== '') {
        grn = await this.required(repo, 'goods_receipts', id(b.grn_id));
        if (![pending, 'SELESAI'].includes(grn.status)) fail(409, 'Tag tidak dapat ditautkan ke GRN yang dibatalkan.');
        if (grn.product_id != null && !sameId(grn.product_id, product.id)) fail(409, 'Produk tag tidak sesuai dengan produk GRN.');
        if ((await repo.all('items')).filter(i => sameId(i.grn_id, grn!.id)).length >= grn.total_qty) fail(409, 'Jumlah tag sudah mencapai jumlah unit GRN.');
      }
      const tag = await repo.insert('tags', { epc, ...await this.tagFields(repo, type), status: 'ENCODED' });
      const item = await repo.insert('items', await this.itemFields(repo, { product_id: product.id, tag_id: tag.id, grn_id: grn?.id ?? null }));
      await repo.audit('tag', tag.id, 'ENCODE_SIMULATION', null, { ...tag, product_id: product.id, item_id: item.id });
      return { tag, item, product };
    });
    this.event(result.tag, result.item, result.product);
    return { tag: { ...result.tag, type, product_id: result.product.id, sku: result.product.sku, product_name: result.product.name }, item: result.item, mode: 'simulation', hardware_confirmed: false };
  }
  private async editableTag(repo: Repository, tag: Row) {
    if (!['UNASSIGNED', 'ENCODED'].includes(tag.status)) fail(409, 'Tag sudah dipakai dalam transaksi atau dinonaktifkan; perubahan meja tidak diperbolehkan.');
    const items = (await repo.all('items')).filter(i => sameId(i.tag_id, tag.id));
    const movements = await repo.all('stock_movements');
    if (items.some(i => i.location_id != null || (i.status && i.status !== 'ENCODED') || movements.some(m => sameId(m.item_id, i.id)))
      || movements.some(m => sameId(m.tag_id, tag.id))
      || (await repo.all('gate_events')).some(e => e.epc === tag.epc || sameId(e.tag_id, tag.id))) fail(409, 'Tag memiliki riwayat stok, lokasi, atau gate; diperlukan prosedur terotorisasi.');
    return items[0];
  }
  async updateTag(value: string, b: Row) {
    if ('epc' in b || 'epc_custom' in b) fail(409, 'EPC tidak boleh diubah atau digunakan ulang.');
    if (!['type', 'product_id', 'status'].some(key => key in b)) fail(400, 'Tidak ada perubahan tag yang didukung.');
    const result = await this.repo.transaction(async repo => {
      const old = structuredClone(await this.required(repo, 'tags', value));
      let item = await this.editableTag(repo, old);
      const previousProductId = item?.product_id;
      if (b.status !== undefined && !(old.status === 'UNASSIGNED' && b.status === 'ENCODED')) fail(409, 'Transisi tidak valid. Putaway IN_STOCK milik Orang 2; gunakan endpoint deactivate untuk DAMAGED.');
      const fields: Row = b.type !== undefined ? await this.tagFields(repo, tagType(b.type)) : {};
      let product: Row | undefined;
      if (b.product_id !== undefined) {
        product = await this.required(repo, 'products', id(b.product_id));
        if (item?.grn_id != null && !sameId(item.product_id, product.id)) fail(409, 'Produk tag sudah ditautkan ke GRN dan tidak boleh diganti.');
        if (!item && old.sku && old.sku !== product.sku) fail(409, 'Relasi tag legacy belum terverifikasi; produk tidak dapat diganti.');
        if (item) item = await repo.update('items', String(item.id), { product_id: product.id });
        else item = await repo.insert('items', await this.itemFields(repo, { product_id: product.id, tag_id: old.id }));
      }
      if (b.status === 'ENCODED') {
        if (!item) fail(400, 'Pilih produk sebelum mengubah tag menjadi ENCODED.');
        product ??= await this.required(repo, 'products', String(item!.product_id));
        fields.status = 'ENCODED';
      }
      const tag = Object.keys(fields).length ? await repo.update('tags', value, fields) : old;
      await repo.audit('tag', tag.id, 'UPDATE', { ...old, product_id: previousProductId }, { ...tag, product_id: product?.id ?? item?.product_id }, undefined, true);
      return { tag, item, product, encoded: old.status === 'UNASSIGNED' && tag.status === 'ENCODED' };
    });
    if (result.encoded) this.event(result.tag, result.item!, result.product!);
    return result.tag;
  }
  async deactivateTag(value: string, b: Row) {
    const reason = text(b.reason, 'Alasan penonaktifan', 1000);
    return this.repo.transaction(async repo => {
      const old = structuredClone(await this.required(repo, 'tags', value));
      await this.editableTag(repo, old);
      await this.supportedStatus(repo, 'tags', 'DAMAGED');
      const row = await repo.update('tags', value, { status: 'DAMAGED' });
      await repo.audit('tag', row.id, 'DEACTIVATE', old, row, reason, true);
      return row;
    });
  }
}
