import { Repository } from './repository';
import { epcInput, fail, grnInput, id, productInput, receiptLinesInput, Row, sameId, tagType, text } from './validation';
import { canonicalTagType, nativeTagTypes } from './schema-contract';

type Publisher = (topic: string, payload: Row) => void;
const pending = 'MENUNGGU_VERIFIKASI';
export class InboundService {
  constructor(private repo: Repository, private publish: Publisher, private actor?: { id: string; role: string }) {}
  private audit(repo: Repository, entity: string, entityId: unknown, action: string, before: Row | null, after: Row, reason?: string) {
    return repo.audit(entity, entityId, action, before, after, reason, true, this.actor?.id);
  }
  private supervisor() {
    if (!this.actor || !['ADMIN', 'SUPERVISOR'].includes(this.actor.role)) fail(403, 'Operasi ini memerlukan Admin atau Supervisor.');
  }
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
      await this.audit(repo, 'product', row.id, value ? 'UPDATE' : 'CREATE', old, row);
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
      await this.audit(repo, 'product', row.id, 'DELETE', row, {});
      await repo.removeProduct(value);
      return { id: row.id };
    });
  }
  private async receiptView(repo: Repository, row: Row): Promise<Row & { lines: Row[] }> {
    if (!row.has_sku_lines) return { ...row, lines: [], tagging_progress: null };
    const lines = await repo.receiptLines(String(row.id));
    const tagged = lines.reduce((sum, line) => sum + line.tagged_qty, 0);
    const complete = lines.length > 0 && lines.every(line => line.tagged_qty === line.received_qty);
    return { ...row, lines, tagging_progress: { tagged, total: row.total_qty },
      rfid_tagging_status: complete ? 'SELESAI_TAGGING' : tagged > 0 ? 'SEDANG_TAGGING' : 'MENUNGGU_TAGGING' };
  }
  async grns(value?: string) {
    if (!value) return Promise.all((await this.repo.all('goods_receipts')).map(row => this.receiptView(this.repo, row)));
    const row = await this.required(this.repo, 'goods_receipts', value);
    return { ...await this.receiptView(this.repo, row), audit_history: await this.repo.history('grn', value) };
  }
  private async grnUnused(repo: Repository, row: Row) {
    const items = await repo.all('items');
    const linked = items.filter(i => sameId(i.grn_id, row.id));
    const movements = await repo.all('stock_movements');
    if (movements.some(m => m.reference_doc === row.po_number || linked.some(i => sameId(i.id, m.item_id)))) fail(409, 'GRN sudah berdampak pada stok/putaway. Diperlukan reversal terotorisasi; ledger tidak diubah.');
    if (linked.length) fail(409, 'GRN memiliki item/tag terkait. Selesaikan penanganan relasi sebelum mengubah atau membatalkan penerimaan.');
  }
  async saveGrn(b: Row, value?: string) {
    return this.repo.transaction(async repo => {
      const modern = (await repo.columns('goods_receipts')).includes('has_sku_lines');
      const old = value ? await this.receiptView(repo, structuredClone(await this.required(repo, 'goods_receipts', value))) : null;
      if (old) {
        if (old.status !== pending) fail(409, 'Hanya GRN menunggu verifikasi yang boleh diedit.');
        if (modern && !old.has_sku_lines) fail(409, 'GRN lama memerlukan rekonsiliasi terotorisasi sebelum dapat diubah.');
        await this.grnUnused(repo, old);
      }
      if (!modern && b.lines !== undefined) fail(503, 'Migrasi rincian SKU belum tersedia.');
      const details = modern ? receiptLinesInput(b.lines) : undefined;
      const input = grnInput(b, details?.total);
      await this.unique(repo, 'goods_receipts', 'po_number', input.po_number, value);
      if (input.product_id) {
        const product = await this.required(repo, 'products', input.product_id);
        if (!(await repo.columns('goods_receipts')).includes('product_id')) fail(400, 'Skema GRN aktif tidak memiliki kolom produk. Tautkan produk melalui tag/item dengan grn_id.');
        input.product_id = product.id;
      }
      if (details) {
        if (input.product_id) fail(400, 'Produk GRN harus ditentukan pada baris SKU.');
        input.has_sku_lines = true;
        for (const line of details.lines) line.product_id = (await this.required(repo, 'products', line.product_id)).id;
      }
      const row = value ? await repo.update('goods_receipts', value, input) : await repo.insert('goods_receipts', { ...input, status: pending, rfid_tagging_status: 'MENUNGGU_TAGGING' });
      if (details) {
        if (value) await repo.clearReceiptLines(value);
        for (const line of details.lines) await repo.insert('goods_receipt_lines', { ...line, grn_id: row.id });
      }
      const result = await this.receiptView(repo, row);
      await this.audit(repo, 'grn', row.id, value ? 'UPDATE' : 'CREATE', old, result);
      return result;
    });
  }
  async verifyGrn(value: string, b: Row = {}) {
    return this.repo.transaction(async repo => {
      const old = structuredClone(await this.required(repo, 'goods_receipts', value));
      if (old.status !== pending) fail(409, 'GRN hanya dapat diverifikasi satu kali dari status menunggu verifikasi.');
      const columns = await repo.columns('goods_receipts');
      const before = await this.receiptView(repo, old);
      if (columns.includes('has_sku_lines')) {
        if (!old.has_sku_lines) fail(409, 'Rekonsiliasi GRN lama diperlukan sebelum verifikasi per SKU.');
        const { lines } = receiptLinesInput(b.lines);
        const counts = new Map(lines.map(line => [line.product_id, line.received_qty]));
        if (lines.length !== before.lines.length || before.lines.some(line => counts.get(String(line.product_id)) !== line.received_qty))
          fail(409, 'Hasil hitung fisik berbeda dengan draft. Periksa dan edit rincian penerimaan sebelum verifikasi.');
      }
      const fields: Row = { status: 'SELESAI' };
      if (columns.includes('verified_at')) fields.verified_at = new Date().toISOString();
      if (columns.includes('verified_by')) fields.verified_by = this.actor?.id;
      const row = await repo.update('goods_receipts', value, fields);
      const result = await this.receiptView(repo, row);
      await this.audit(repo, 'grn', row.id, 'VERIFY', before, result);
      return result;
    });
  }
  async cancelGrn(value: string, b: Row) {
    const reason = text(b.reason, 'Alasan pembatalan', 1000);
    return this.repo.transaction(async repo => {
      if ((await repo.columns('goods_receipts')).includes('has_sku_lines')) this.supervisor();
      const old = structuredClone(await this.required(repo, 'goods_receipts', value));
      if (old.status !== pending) fail(409, 'Pembatalan sederhana hanya untuk GRN menunggu verifikasi; GRN selesai memerlukan prosedur reversal terotorisasi.');
      await this.grnUnused(repo, old);
      await this.supportedStatus(repo, 'goods_receipts', 'DIBATALKAN');
      const row = await repo.update('goods_receipts', value, { status: 'DIBATALKAN' });
      await this.audit(repo, 'grn', row.id, 'CANCEL', old, row, reason);
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
        item_id: item?.id, grn_id: item?.grn_id ?? null, grn_line_id: item?.grn_line_id ?? null,
        inbound_purpose: item?.inbound_purpose ?? null, location_id: item?.location_id ?? null,
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
  private async registerEncoding(repo: Repository, b: Row) {
    if (b.mode !== undefined && b.mode !== 'simulation') fail(409, 'Encoding hardware belum didukung: reader/SDK dan konfirmasi perangkat belum tersedia.');
    if (b.status !== undefined && b.status !== 'ENCODED') fail(409, 'Registrasi meja hanya menghasilkan status ENCODED.');
    const epc = epcInput(b.epc_custom !== undefined ? b.epc_custom : b.epc);
    const type = tagType(b.type !== undefined ? b.type : 'STANDARD_LABEL');
    await this.unique(repo, 'tags', 'epc', epc);
    const modern = (await repo.columns('goods_receipts')).includes('has_sku_lines');
    let grn: Row | undefined, line: Row | undefined;
    if (b.grn_id != null && b.grn_id !== '') {
      grn = await this.required(repo, 'goods_receipts', id(b.grn_id));
      if (modern) {
        if (grn.status !== 'SELESAI' || !grn.has_sku_lines) fail(409, 'Pilih GRN dengan rincian SKU yang sudah diverifikasi.');
        const lineId = id(b.grn_line_id);
        line = (await repo.receiptLines(String(grn.id))).find(row => sameId(row.id, lineId));
        if (!line) return fail(409, 'Baris SKU tidak termasuk dalam GRN yang dipilih.');
        if (b.product_id !== undefined && !sameId(line.product_id, id(b.product_id))) fail(409, 'Produk tag tidak sesuai dengan baris SKU GRN.');
        if (line.tagged_qty >= line.received_qty) fail(409, 'Kuota tagging untuk SKU ini sudah terpenuhi.');
      } else {
        if (![pending, 'SELESAI'].includes(grn.status)) fail(409, 'Tag tidak dapat ditautkan ke GRN yang dibatalkan.');
        if (grn.product_id != null && !sameId(grn.product_id, b.product_id)) fail(409, 'Produk tag tidak sesuai dengan produk GRN.');
        if ((await repo.all('items')).filter(i => sameId(i.grn_id, grn!.id)).length >= grn.total_qty) fail(409, 'Jumlah tag sudah mencapai jumlah unit GRN.');
      }
    } else if (modern) {
      if (b.grn_line_id != null || !['ASSET', 'SPECIAL'].includes(b.inbound_purpose)) fail(400, 'Pilih GRN terverifikasi atau kategori non-GRN yang valid.');
      this.supervisor();
    }
    const product = await this.required(repo, 'products', id(line?.product_id ?? b.product_id));
    const auditFields = modern ? { encoded_by: this.actor?.id, encoded_at: new Date().toISOString() } : {};
    const tag = await repo.insert('tags', { epc, ...await this.tagFields(repo, type), status: 'ENCODED', ...auditFields });
    const linkage = modern ? { grn_line_id: line?.id ?? null, inbound_purpose: line ? 'RECEIPT' : b.inbound_purpose } : {};
    const item = await repo.insert('items', await this.itemFields(repo, { product_id: product.id, tag_id: tag.id, grn_id: grn?.id ?? null, ...linkage }));
    await this.audit(repo, 'tag', tag.id, 'ENCODE_SIMULATION', null, { ...tag, product_id: product.id, item_id: item.id, grn_id: item.grn_id, ...linkage });
    return { tag, item, product };
  }

  private encodingResponse(result: Awaited<ReturnType<InboundService['registerEncoding']>>) {
    this.event(result.tag, result.item, result.product);
    return { tag: { ...result.tag, type: canonicalTagType(result.tag.type ?? result.tag.tag_type), product_id: result.product.id, sku: result.product.sku, product_name: result.product.name }, item: result.item, mode: 'simulation', hardware_confirmed: false };
  }
  async encode(b: Row) {
    const result = await this.repo.transaction(repo => this.registerEncoding(repo, b));
    return this.encodingResponse(result);
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
        if ((await repo.columns('goods_receipts')).includes('has_sku_lines')) {
          if (!item!.grn_line_id) {
            if (item!.grn_id != null || !['ASSET', 'SPECIAL'].includes(b.inbound_purpose)) fail(409, 'Gunakan registrasi GRN baru atau pilih kategori non-GRN.');
            this.supervisor();
            item = await repo.update('items', String(item!.id), { inbound_purpose: b.inbound_purpose });
          }
          fields.encoded_by = this.actor?.id;
          fields.encoded_at = new Date().toISOString();
        }
        product ??= await this.required(repo, 'products', String(item!.product_id));
        fields.status = 'ENCODED';
      }
      const tag = Object.keys(fields).length ? await repo.update('tags', value, fields) : old;
      await this.audit(repo, 'tag', tag.id, 'UPDATE', { ...old, product_id: previousProductId }, { ...tag, product_id: product?.id ?? item?.product_id });
      return { tag, item, product, encoded: old.status === 'UNASSIGNED' && tag.status === 'ENCODED' };
    });
    if (result.encoded) this.event(result.tag, result.item!, result.product!);
    return result.tag;
  }
  private async retireTag(repo: Repository, value: string, reason: string) {
    const old = structuredClone(await this.required(repo, 'tags', value));
    await this.supportedStatus(repo, 'tags', 'DAMAGED');
    const item = await this.editableTag(repo, old);
    const row = await repo.update('tags', value, { status: 'DAMAGED' });
    await this.audit(repo, 'tag', row.id, 'DEACTIVATE', old, { ...row, grn_id: item?.grn_id, grn_line_id: item?.grn_line_id }, reason);
    return { tag: row, item };
  }
  async deactivateTag(value: string, b: Row) {
    const reason = text(b.reason, 'Alasan penonaktifan', 1000);
    return this.repo.transaction(async repo => {
      if ((await repo.columns('goods_receipts')).includes('has_sku_lines')) this.supervisor();
      return (await this.retireTag(repo, value, reason)).tag;
    });
  }
  async replaceTag(value: string, b: Row) {
    this.supervisor();
    const reason = text(b.reason, 'Alasan penggantian', 1000);
    const result = await this.repo.transaction(async repo => {
      const previous = await this.required(repo, 'tags', value);
      if (previous.status !== 'ENCODED') fail(409, 'Penggantian meja memerlukan tag ENCODED.');
      const { tag, item } = await this.retireTag(repo, value, reason);
      if (!item?.inbound_purpose) return fail(409, 'Tag legacy memerlukan rekonsiliasi sebelum penggantian.');
      const replacement = await this.registerEncoding(repo, { product_id: item.product_id, grn_id: item.grn_id,
        grn_line_id: item.grn_line_id, inbound_purpose: item.inbound_purpose, epc: b.epc,
        type: canonicalTagType(tag.type ?? tag.tag_type), mode: 'simulation' });
      await this.audit(repo, 'tag', replacement.tag.id, 'REPLACE_SIMULATION', { tag_id: tag.id, epc: tag.epc },
        { tag_id: replacement.tag.id, epc: replacement.tag.epc, grn_line_id: item.grn_line_id }, reason);
      return replacement;
    });
    return this.encodingResponse(result);
  }
}
