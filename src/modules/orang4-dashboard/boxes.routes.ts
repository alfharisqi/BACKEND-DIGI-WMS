import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { db, isPostgresConnected, memoryStore } from '../../config/db';
import { publishRealtimeEvent } from '../../config/mqtt';

function generateHexEpc(prefix = 'E280'): string {
  const cleanPrefix = prefix.replace(/[^0-9A-F]/gi, '').toUpperCase().slice(0, 4).padEnd(4, '0');
  const randomBytes = crypto.randomBytes(10).toString('hex').toUpperCase();
  return `${cleanPrefix}${randomBytes}`.slice(0, 24);
}

const memoryBoxes: Array<Record<string, any>> = [];
let schemaEnsured = false;

async function ensureMultiLevelBoxSchema() {
  if (schemaEnsured || !isPostgresConnected) return;
  try {
    await db.query(`
      ALTER TABLE public.boxes
        ADD COLUMN IF NOT EXISTS box_level TEXT NOT NULL DEFAULT 'INNER',
        ADD COLUMN IF NOT EXISTS parent_box_id UUID REFERENCES public.boxes(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS inner_box_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS qty_per_inner INTEGER NOT NULL DEFAULT 1;
    `);
    schemaEnsured = true;
  } catch (err: any) {
    console.error('[Box Schema Migration Warning]:', err.message);
  }
}

export async function registerBoxRoutes(app: FastifyInstance) {
  // Jalankan pengecekan kolom multi-level saat route didaftarkan
  ensureMultiLevelBoxSchema().catch(() => {});

  // 1. GET Daftar Master Box & Inner Box (Multi-Level)
  app.get('/api/boxes', async (request) => {
    await ensureMultiLevelBoxSchema();
    const query = (request.query as Record<string, string>) || {};
    const statusFilter = query.status?.toUpperCase();
    const levelFilter = query.level?.toUpperCase();
    const search = query.search?.toLowerCase();

    if (isPostgresConnected) {
      try {
        let sql = `
          SELECT
            b.id,
            b.box_code,
            b.master_epc,
            COALESCE(b.box_level, 'INNER') AS box_level,
            b.parent_box_id,
            pb.box_code AS parent_box_code,
            COALESCE(b.inner_box_count, 0) AS inner_box_count,
            COALESCE(b.qty_per_inner, b.qty_per_box) AS qty_per_inner,
            b.product_id,
            p.sku,
            p.name AS product_name,
            p.category,
            b.qty_per_box,
            b.location_id,
            l.code AS location_code,
            l.name AS location_name,
            l.location_type,
            b.status,
            b.notes,
            b.created_at,
            b.unpacked_at
          FROM boxes b
          INNER JOIN products p ON p.id = b.product_id
          LEFT JOIN locations l ON l.id = b.location_id
          LEFT JOIN boxes pb ON pb.id = b.parent_box_id
          WHERE 1=1
        `;
        const params: unknown[] = [];

        if (statusFilter && ['SEALED', 'IN_RACK', 'UNPACKED', 'SHIPPED'].includes(statusFilter)) {
          params.push(statusFilter);
          sql += ` AND b.status = $${params.length}`;
        }

        if (levelFilter && ['MASTER', 'INNER'].includes(levelFilter)) {
          params.push(levelFilter);
          sql += ` AND COALESCE(b.box_level, 'INNER') = $${params.length}`;
        }

        if (search) {
          params.push(`%${search}%`);
          sql += ` AND (
            LOWER(b.box_code) LIKE $${params.length}
            OR LOWER(b.master_epc) LIKE $${params.length}
            OR LOWER(p.sku) LIKE $${params.length}
            OR LOWER(p.name) LIKE $${params.length}
          )`;
        }

        sql += ` ORDER BY b.created_at DESC`;

        const res = await db.query(sql, params);
        const rows = res.rows;

        const activeRows = rows.filter((r) => r.status === 'SEALED' || r.status === 'IN_RACK');
        const summary = {
          total_boxes: rows.length,
          master_boxes: activeRows.filter((r) => r.box_level === 'MASTER').length,
          inner_boxes: activeRows.filter((r) => r.box_level !== 'MASTER').length,
          sealed_boxes: rows.filter((r) => r.status === 'SEALED').length,
          in_rack_boxes: rows.filter((r) => r.status === 'IN_RACK').length,
          unpacked_boxes: rows.filter((r) => r.status === 'UNPACKED').length,
          total_units_in_active_boxes: activeRows.reduce(
            (acc, r) => acc + Number(r.qty_per_box || 0),
            0
          ),
        };

        return { status: 'ok', success: true, count: rows.length, summary, data: rows };
      } catch (err: any) {
        console.error('[Box List Error]:', err.message);
      }
    }

    let list = [...memoryBoxes];
    if (statusFilter) list = list.filter((b) => b.status === statusFilter);
    if (levelFilter) list = list.filter((b) => (b.box_level || 'INNER') === levelFilter);
    if (search) {
      list = list.filter(
        (b) =>
          String(b.box_code).toLowerCase().includes(search) ||
          String(b.master_epc).toLowerCase().includes(search) ||
          String(b.sku || '').toLowerCase().includes(search)
      );
    }
    const activeMem = list.filter((r) => r.status === 'SEALED' || r.status === 'IN_RACK');
    return {
      status: 'ok',
      success: true,
      count: list.length,
      summary: {
        total_boxes: list.length,
        master_boxes: activeMem.filter((r) => r.box_level === 'MASTER').length,
        inner_boxes: activeMem.filter((r) => r.box_level !== 'MASTER').length,
        sealed_boxes: list.filter((r) => r.status === 'SEALED').length,
        in_rack_boxes: list.filter((r) => r.status === 'IN_RACK').length,
        unpacked_boxes: list.filter((r) => r.status === 'UNPACKED').length,
        total_units_in_active_boxes: activeMem.reduce(
          (acc, r) => acc + Number(r.qty_per_box || 0),
          0
        ),
      },
      data: list,
    };
  });

  // 2. POST Terima / Daftarkan Box Baru (Mendukung MASTER Carton -> Inner Box -> Pcs, atau INNER Box -> Pcs)
  app.post('/api/boxes', async (request, reply) => {
    await ensureMultiLevelBoxSchema();
    const body = (request.body as Record<string, any>) || {};
    const productId = body.product_id;
    const boxLevel = String(body.box_level || 'INNER').toUpperCase() === 'MASTER' ? 'MASTER' : 'INNER';
    const locationCode = String(body.location_code || 'INB01').trim();
    const notes = String(body.notes || '').trim() || null;
    const customEpc = String(body.master_epc || '').trim().toUpperCase();

    let innerBoxCount = 0;
    let qtyPerInner = 1;
    let qtyPerBox = Number(body.qty_per_box);

    if (boxLevel === 'MASTER') {
      innerBoxCount = Number(body.inner_box_count);
      qtyPerInner = Number(body.qty_per_inner);
      if (
        !productId ||
        !Number.isInteger(innerBoxCount) ||
        innerBoxCount < 1 ||
        innerBoxCount > 200 ||
        !Number.isInteger(qtyPerInner) ||
        qtyPerInner < 1 ||
        qtyPerInner > 500
      ) {
        return reply.code(400).send({
          status: 'error',
          success: false,
          message:
            'Untuk Master Carton, jumlah Inner Box harus 1–200 dan isi per Inner Box harus 1–500 unit.',
        });
      }
      qtyPerBox = innerBoxCount * qtyPerInner;
    } else {
      if (!productId || !Number.isInteger(qtyPerBox) || qtyPerBox < 1 || qtyPerBox > 500) {
        return reply.code(400).send({
          status: 'error',
          success: false,
          message: 'Produk wajib dipilih dan isi per box harus angka bulat 1 - 500 unit.',
        });
      }
      qtyPerInner = qtyPerBox;
    }

    if (customEpc && !/^[0-9A-F]{24}$/.test(customEpc)) {
      return reply.code(400).send({
        status: 'error',
        success: false,
        message: 'Master EPC harus tepat 24 digit hexadecimal (atau kosongkan untuk auto-generate).',
      });
    }

    const masterEpc = customEpc || generateHexEpc(boxLevel === 'MASTER' ? 'E28M' : 'E28B');
    const nowTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const codePrefix = boxLevel === 'MASTER' ? 'MBOX' : 'BOX';
    const boxCode = `${codePrefix}-${nowTag}-${Math.floor(1000 + Math.random() * 9000)}`;

    if (isPostgresConnected) {
      const client = await db.connect();
      client.on('error', (err) => console.error('[Box PG Client Error]:', err.message));
      try {
        await client.query('BEGIN');

        const prodRes = await client.query('SELECT id, sku, name FROM products WHERE id = $1 LIMIT 1', [
          productId,
        ]);
        if (prodRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(404).send({
            status: 'error',
            success: false,
            message: 'Produk tidak ditemukan di database.',
          });
        }
        const product = prodRes.rows[0];

        const locRes = await client.query(
          'SELECT id, code, name, location_type FROM locations WHERE code = $1 LIMIT 1',
          [locationCode]
        );
        const loc = locRes.rows[0] || null;
        const initialStatus = loc && loc.location_type === 'RACK' ? 'IN_RACK' : 'SEALED';

        const boxId = crypto.randomUUID();
        const insertRes = await client.query(
          `INSERT INTO boxes (
             id, box_code, master_epc, box_level, parent_box_id, inner_box_count, qty_per_inner,
             product_id, qty_per_box, location_id, status, notes, created_at
           )
           VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11, NOW())
           RETURNING *`,
          [
            boxId,
            boxCode,
            masterEpc,
            boxLevel,
            innerBoxCount,
            qtyPerInner,
            product.id,
            qtyPerBox,
            loc ? loc.id : null,
            initialStatus,
            notes,
          ]
        );

        const qtyLabel =
          boxLevel === 'MASTER'
            ? `+${qtyPerBox} unit (${innerBoxCount} Inner Box × ${qtyPerInner})`
            : `+${qtyPerBox} unit (1 Inner Box)`;

        await client.query(
          `INSERT INTO stock_movements (
            id, tx_code, movement_type, product_id, sku, from_location, to_location,
            qty_change, qty_label, reference_doc, performed_by_name, to_location_id, created_at
          ) VALUES ($1, $2, 'INBOUND', $3, $4, 'Supplier / Master Box', $5, $6, $7, $8, 'Operator Gudang', $9, NOW())`,
          [
            crypto.randomUUID(),
            `BOX-IN-${Date.now().toString().slice(-6)}`,
            product.id,
            product.sku,
            loc ? `${loc.code} - ${loc.name}` : 'Staging Inbound (INB01)',
            qtyPerBox,
            qtyLabel,
            boxCode,
            loc ? loc.id : null,
          ]
        );

        await client.query('COMMIT');

        publishRealtimeEvent('wms/stock/realtime', {
          event: 'MASTER_BOX_RECEIVED',
          box_code: boxCode,
          box_level: boxLevel,
          master_epc: masterEpc,
          sku: product.sku,
          qty_per_box: qtyPerBox,
          inner_box_count: innerBoxCount,
          qty_per_inner: qtyPerInner,
          status: initialStatus,
        });

        const msg =
          boxLevel === 'MASTER'
            ? `Master Carton ${boxCode} (${innerBoxCount} Inner Box × ${qtyPerInner} = ${qtyPerBox} unit ${product.sku}) berhasil didaftarkan!`
            : `Inner Box ${boxCode} (${qtyPerBox} unit ${product.sku}) berhasil didaftarkan!`;

        return reply.code(201).send({
          status: 'ok',
          success: true,
          message: msg,
          data: {
            ...insertRes.rows[0],
            sku: product.sku,
            product_name: product.name,
            location_code: loc?.code || null,
            location_name: loc?.name || null,
          },
        });
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') {
          return reply.code(409).send({
            status: 'error',
            success: false,
            message: 'Master EPC atau Kode Box sudah terdaftar.',
          });
        }
        return reply.code(500).send({
          status: 'error',
          success: false,
          message: `Gagal mendaftarkan Box: ${err.message}`,
        });
      } finally {
        client.release();
      }
    }

    const memBox = {
      id: crypto.randomUUID(),
      box_code: boxCode,
      master_epc: masterEpc,
      box_level: boxLevel,
      parent_box_id: null,
      inner_box_count: innerBoxCount,
      qty_per_inner: qtyPerInner,
      product_id: productId,
      qty_per_box: qtyPerBox,
      location_code: locationCode,
      status: 'SEALED',
      notes,
      created_at: new Date().toISOString(),
    };
    memoryBoxes.unshift(memBox);
    return reply.code(201).send({
      status: 'ok',
      success: true,
      message: `Box ${boxCode} berhasil didaftarkan (mode memori).`,
      data: memBox,
    });
  });

  // 3. PATCH Putaway 1 Box (Master atau Inner) ke Rak Penyimpanan
  app.patch('/api/boxes/:id/putaway', async (request, reply) => {
    await ensureMultiLevelBoxSchema();
    const { id } = request.params as { id: string };
    const body = (request.body as Record<string, any>) || {};
    const locationCode = String(body.location_code || '').trim();

    if (!locationCode) {
      return reply.code(400).send({
        status: 'error',
        success: false,
        message: 'Kode rak tujuan wajib dipilih.',
      });
    }

    if (isPostgresConnected) {
      const client = await db.connect();
      client.on('error', (err) => console.error('[Box Putaway PG Error]:', err.message));
      try {
        await client.query('BEGIN');

        const boxRes = await client.query(
          `SELECT b.*, p.sku, l.code AS current_loc_code, l.name AS current_loc_name
           FROM boxes b
           INNER JOIN products p ON p.id = b.product_id
           LEFT JOIN locations l ON l.id = b.location_id
           WHERE b.id::text = $1 OR b.box_code = $1 OR b.master_epc = $1
           LIMIT 1`,
          [id]
        );
        if (boxRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(404).send({
            status: 'error',
            success: false,
            message: 'Box tidak ditemukan.',
          });
        }
        const box = boxRes.rows[0];
        if (box.status === 'UNPACKED' || box.status === 'SHIPPED') {
          await client.query('ROLLBACK');
          return reply.code(409).send({
            status: 'error',
            success: false,
            message: `Box ${box.box_code} berstatus ${box.status} dan tidak bisa dipindah ke rak.`,
          });
        }

        const locRes = await client.query(
          `SELECT id, code, name, location_type FROM locations WHERE code = $1 AND location_type = 'RACK' LIMIT 1`,
          [locationCode]
        );
        if (locRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(404).send({
            status: 'error',
            success: false,
            message: `Rak tujuan "${locationCode}" tidak ditemukan.`,
          });
        }
        const targetRack = locRes.rows[0];

        const updateRes = await client.query(
          `UPDATE boxes SET location_id = $1, status = 'IN_RACK' WHERE id = $2 RETURNING *`,
          [targetRack.id, box.id]
        );

        await client.query(
          `INSERT INTO stock_movements (
            id, tx_code, movement_type, product_id, sku, from_location, to_location,
            qty_change, qty_label, reference_doc, performed_by_name, from_location_id, to_location_id, created_at
          ) VALUES ($1, $2, 'PUTAWAY', $3, $4, $5, $6, 0, $7, $8, 'Operator Gudang', $9, $10, NOW())`,
          [
            crypto.randomUUID(),
            `BOX-PUT-${Date.now().toString().slice(-6)}`,
            box.product_id,
            box.sku,
            box.current_loc_code ? `${box.current_loc_code} - ${box.current_loc_name}` : 'Staging Inbound (INB01)',
            `${targetRack.code} - ${targetRack.name}`,
            `${box.qty_per_box} unit (1 Box pindah rak)`,
            box.box_code,
            box.location_id || null,
            targetRack.id,
          ]
        );

        await client.query('COMMIT');

        return reply.send({
          status: 'ok',
          success: true,
          message: `Box ${box.box_code} (${box.qty_per_box} unit) berhasil dipindah ke ${targetRack.code} - ${targetRack.name}!`,
          data: {
            ...updateRes.rows[0],
            location_code: targetRack.code,
            location_name: targetRack.name,
          },
        });
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        return reply.code(500).send({
          status: 'error',
          success: false,
          message: `Gagal putaway Box: ${err.message}`,
        });
      } finally {
        client.release();
      }
    }

    return reply.code(503).send({ status: 'error', success: false, message: 'Membutuhkan koneksi PostgreSQL.' });
  });

  // 4. POST Break-Pack 2-Tahap:
  //    - MASTER Carton -> N Inner Box (masing-masing berisi qty_per_inner Pcs)
  //    - INNER Box     -> M Tag RFID Satuan (Pcs)
  app.post('/api/boxes/:id/unpack', async (request, reply) => {
    await ensureMultiLevelBoxSchema();
    const { id } = request.params as { id: string };
    const body = (request.body as Record<string, any>) || {};

    if (isPostgresConnected) {
      const client = await db.connect();
      client.on('error', (err) => console.error('[Box Unpack PG Error]:', err.message));
      try {
        await client.query('BEGIN');

        const boxRes = await client.query(
          `SELECT b.*, p.sku, p.name AS product_name, l.code AS location_code, l.location_type
           FROM boxes b
           INNER JOIN products p ON p.id = b.product_id
           LEFT JOIN locations l ON l.id = b.location_id
           WHERE b.id::text = $1 OR b.box_code = $1 OR b.master_epc = $1
           LIMIT 1`,
          [id]
        );
        if (boxRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(404).send({
            status: 'error',
            success: false,
            message: 'Box tidak ditemukan.',
          });
        }

        const box = boxRes.rows[0];
        if (box.status === 'UNPACKED') {
          await client.query('ROLLBACK');
          return reply.code(409).send({
            status: 'error',
            success: false,
            message: `Box ${box.box_code} sudah pernah dipecah (UNPACKED) sebelumnya.`,
          });
        }
        if (box.status === 'SHIPPED') {
          await client.query('ROLLBACK');
          return reply.code(409).send({
            status: 'error',
            success: false,
            message: `Box ${box.box_code} sudah dikirim (SHIPPED) dan tidak dapat dipecah.`,
          });
        }

        const isMaster = String(box.box_level || 'INNER').toUpperCase() === 'MASTER';
        const requestedMode = String(body.mode || '').toUpperCase();
        const unpackMode =
          requestedMode === 'TO_UNIT'
            ? 'TO_UNIT'
            : isMaster && Number(box.inner_box_count || 0) > 0
            ? 'TO_INNER'
            : 'TO_UNIT';

        // === TAHAP 1: PECAH MASTER CARTON -> INNER BOXES ===
        if (unpackMode === 'TO_INNER') {
          const innerCount = Number(box.inner_box_count);
          const qtyPerInner = Number(box.qty_per_inner || Math.max(1, Math.floor(Number(box.qty_per_box) / innerCount)));
          const childStatus = box.status === 'IN_RACK' ? 'IN_RACK' : 'SEALED';
          const generatedBoxes: Array<Record<string, any>> = [];

          for (let i = 1; i <= innerCount; i += 1) {
            const childId = crypto.randomUUID();
            const childEpc = generateHexEpc('E28B');
            const seq = String(i).padStart(2, '0');
            const childCode = `${box.box_code}-IN${seq}`;

            const childRes = await client.query(
              `INSERT INTO boxes (
                 id, box_code, master_epc, box_level, parent_box_id, inner_box_count, qty_per_inner,
                 product_id, qty_per_box, location_id, status, notes, created_at
               )
               VALUES ($1, $2, $3, 'INNER', $4, 0, $5, $6, $5, $7, $8, $9, NOW())
               RETURNING id, box_code, master_epc, qty_per_box, status`,
              [
                childId,
                childCode,
                childEpc,
                box.id,
                qtyPerInner,
                box.product_id,
                box.location_id || null,
                childStatus,
                `Pecahan dari Master Carton ${box.box_code} (${seq}/${innerCount})`,
              ]
            );
            generatedBoxes.push(childRes.rows[0]);
          }

          const updateBoxRes = await client.query(
            `UPDATE boxes SET status = 'UNPACKED', unpacked_at = NOW() WHERE id = $1 RETURNING *`,
            [box.id]
          );

          await client.query('COMMIT');

          publishRealtimeEvent('wms/stock/realtime', {
            event: 'MASTER_BOX_UNPACKED_TO_INNER',
            box_code: box.box_code,
            sku: box.sku,
            generated_inner_boxes: generatedBoxes.length,
            qty_per_inner: qtyPerInner,
          });

          return reply.send({
            status: 'ok',
            success: true,
            message: `Break-Pack Tahap 1 berhasil! Master Carton ${box.box_code} dipecah menjadi ${generatedBoxes.length} Inner Box (masing-masing ${qtyPerInner} unit).`,
            data: {
              unpack_mode: 'TO_INNER',
              box: updateBoxRes.rows[0],
              target_status: childStatus,
              generated_count: generatedBoxes.length,
              qty_per_inner: qtyPerInner,
              generated_boxes: generatedBoxes,
            },
          });
        }

        // === TAHAP 2: PECAH INNER BOX -> TAG RFID SATUAN (PCS) ===
        const targetStatus = box.status === 'IN_RACK' ? 'IN_STOCK' : 'ENCODED';
        const generatedEpcs: string[] = [];

        for (let i = 0; i < Number(box.qty_per_box); i += 1) {
          const epc = generateHexEpc('E280');
          const tagId = crypto.randomUUID();
          const itemId = crypto.randomUUID();

          await client.query(
            `INSERT INTO tags (id, epc, tag_type, status, encoded_at, created_at, updated_at)
             VALUES ($1, $2, 'Label Biasa (UHF)', $3, NOW(), NOW(), NOW())`,
            [tagId, epc, targetStatus]
          );

          await client.query(
            `INSERT INTO items (id, tag_id, product_id, location_id, status, putaway_at, created_at, updated_at, inbound_purpose)
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), 'SPECIAL')`,
            [
              itemId,
              tagId,
              box.product_id,
              box.location_id || null,
              targetStatus,
              targetStatus === 'IN_STOCK' ? new Date() : null,
            ]
          );

          generatedEpcs.push(epc);
        }

        const updateBoxRes = await client.query(
          `UPDATE boxes SET status = 'UNPACKED', unpacked_at = NOW() WHERE id = $1 RETURNING *`,
          [box.id]
        );

        await client.query('COMMIT');

        memoryStore.audit_logs.unshift({
          id: memoryStore.audit_logs.length + 1,
          user_id: 4,
          user_name: 'Operator Gudang',
          action: 'UNPACK_MASTER_BOX',
          payload: {
            box_code: box.box_code,
            sku: box.sku,
            qty_generated: generatedEpcs.length,
            target_status: targetStatus,
          },
          created_at: new Date().toISOString(),
        });

        publishRealtimeEvent('wms/stock/realtime', {
          event: 'MASTER_BOX_UNPACKED',
          box_code: box.box_code,
          sku: box.sku,
          generated_count: generatedEpcs.length,
          target_status: targetStatus,
        });

        return reply.send({
          status: 'ok',
          success: true,
          message: `Break-Pack Satuan berhasil! Box ${box.box_code} dipecah menjadi ${generatedEpcs.length} tag RFID satuan (${targetStatus}).`,
          data: {
            unpack_mode: 'TO_UNIT',
            box: updateBoxRes.rows[0],
            target_status: targetStatus,
            generated_count: generatedEpcs.length,
            generated_epcs: generatedEpcs,
          },
        });
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        return reply.code(500).send({
          status: 'error',
          success: false,
          message: `Gagal memecah Box: ${err.message}`,
        });
      } finally {
        client.release();
      }
    }

    return reply.code(503).send({ status: 'error', success: false, message: 'Membutuhkan koneksi PostgreSQL.' });
  });
}
