import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db, isPostgresConnected, memoryStore } from './db';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SKIP_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/settings',
  '/api/mqtt/test-publish',
  '/api/dev/ready',
]);

function describeActivity(
  method: string,
  routeUrl: string,
  body: Record<string, any>,
  params: Record<string, any>
): { action: string; note: string } | null {
  const path = routeUrl.split('?')[0];

  if (SKIP_PATHS.has(path) || path.startsWith('/api/users')) {
    return null;
  }

  // Master Produk / SKU
  if (method === 'POST' && path === '/api/products') {
    return {
      action: 'CREATE_PRODUCT',
      note: `Menambah SKU baru ${body.sku || '-'} (${body.name || '-'})`,
    };
  }
  if (method === 'PUT' && path.startsWith('/api/products/')) {
    return {
      action: 'UPDATE_PRODUCT',
      note: `Memperbarui produk ${body.sku || params.id || '-'} (${body.name || '-'})`,
    };
  }
  if (method === 'DELETE' && path.startsWith('/api/products/')) {
    return {
      action: 'DELETE_PRODUCT',
      note: `Menghapus produk ID ${params.id || path.split('/').pop()}`,
    };
  }

  // Inbound GRN
  if (method === 'POST' && path === '/api/inbound/grn') {
    return {
      action: 'CREATE_GRN',
      note: `Mencatat penerimaan GRN ${body.po_number || '-'} dari ${body.supplier_name || '-'}`,
    };
  }
  if (method === 'PUT' && path.startsWith('/api/inbound/grn/')) {
    return {
      action: 'UPDATE_GRN',
      note: `Memperbarui draft GRN ${body.po_number || params.id || '-'}`,
    };
  }
  if (method === 'PATCH' && path.endsWith('/verify') && path.includes('/inbound/grn/')) {
    return {
      action: 'VERIFY_GRN',
      note: `Memverifikasi penerimaan fisik GRN ${params.id || path.split('/')[4] || '-'}`,
    };
  }
  if (method === 'PATCH' && path.endsWith('/cancel') && path.includes('/inbound/grn/')) {
    return {
      action: 'CANCEL_GRN',
      note: `Membatalkan GRN (${body.reason || 'tanpa alasan'})`,
    };
  }

  // Tag RFID & Encoding
  if (method === 'POST' && path === '/api/tags/encode') {
    return {
      action: 'ENCODE_RFID_TAG',
      note: `Registrasi Tag RFID ${body.epc_custom || 'Auto-EPC'} (${body.type || 'UHF'})`,
    };
  }
  if (method === 'PATCH' && path.startsWith('/api/tags/') && !path.endsWith('/deactivate')) {
    return {
      action: 'UPDATE_RFID_TAG',
      note: `Memperbarui metadata Tag RFID ${params.id || '-'}`,
    };
  }
  if (method === 'PATCH' && path.endsWith('/deactivate')) {
    return {
      action: 'DEACTIVATE_RFID_TAG',
      note: `Menandai Tag RFID rusak (${body.reason || params.id || '-'})`,
    };
  }
  if (method === 'POST' && path.endsWith('/replace')) {
    return {
      action: 'REPLACE_RFID_TAG',
      note: `Mengganti EPC Tag RFID (${body.reason || params.id || '-'})`,
    };
  }

  // Master Box & Inner Box
  if (method === 'POST' && path === '/api/boxes') {
    const qtyDesc =
      String(body.box_level || '').toUpperCase() === 'MASTER'
        ? `${body.inner_box_count || 0} Inner Box × ${body.qty_per_inner || 0} Pcs`
        : `${body.qty_per_box || 0} unit`;
    return {
      action: 'RECEIVE_BOX',
      note: `Menerima ${String(body.box_level || '').toUpperCase() === 'MASTER' ? 'Master Carton' : 'Inner Box'} (${qtyDesc})`,
    };
  }
  if (method === 'PATCH' && path.includes('/api/boxes/') && path.endsWith('/putaway')) {
    return {
      action: 'PUTAWAY_BOX',
      note: `Memindahkan Box ${params.id || '-'} ke rak ${body.location_code || '-'}`,
    };
  }
  if (method === 'POST' && path.includes('/api/boxes/') && path.endsWith('/unpack')) {
    return {
      action: 'BREAK_PACK_BOX',
      note: `Melakukan Break-Pack Box ${params.id || '-'} (${body.mode || 'AUTO'})`,
    };
  }

  // Putaway & Outbound
  if (method === 'POST' && path === '/api/inventory/putaway') {
    return {
      action: 'PUTAWAY_RACK',
      note: `Putaway barang ke rak ${body.target_location_code || body.location_code || '-'}`,
    };
  }
  if (method === 'POST' && path === '/api/outbound/shipments') {
    return {
      action: 'CREATE_SHIPMENT',
      note: `Membuat pengiriman ${body.invoice_or_resi || '-'} via ${body.courier || '-'} (${Array.isArray(body.epcs) ? body.epcs.length : 0} EPC)`,
    };
  }
  if (method === 'POST' && path === '/api/outbound/authorize') {
    return {
      action: 'AUTHORIZE_OUTBOUND',
      note: `Otorisasi keluar ${Array.isArray(body.epcs) ? body.epcs.length : 0} EPC outbound`,
    };
  }

  // Picking & Packing
  if (method === 'POST' && (path === '/api/picking/orders' || path === '/api/outbound/picking-orders')) {
    return {
      action: 'CREATE_PICKING_ORDER',
      note: `Membuat pesanan picking ${body.order_number || '-'}`,
    };
  }
  if (method === 'POST' && (path === '/api/picking/scan' || path.includes('/picking-orders/'))) {
    return {
      action: 'PICKING_SCAN',
      note: `Scan RFID picking EPC ${body.epc || '-'}`,
    };
  }
  if (method === 'PUT' && path.includes('/packing')) {
    return {
      action: 'UPDATE_PACKING',
      note: `Memperbarui checklist packing order ${params.id || '-'}`,
    };
  }

  // Kasir POS & Retur
  if (method === 'POST' && path === '/api/pos/scan') {
    return null; // Jangan penuhi log untuk scan item keranjang sebelum checkout
  }
  if (method === 'POST' && path === '/api/pos/checkout') {
    return {
      action: 'POS_CHECKOUT',
      note: `Checkout POS pelanggan ${body.customer_name || 'Umum'} (${body.payment || 'CASH'})`,
    };
  }
  if (method === 'POST' && (path.includes('/pos/return') || path.includes('/returns'))) {
    return {
      action: 'POS_RETURN',
      note: `Memproses retur POS (${body.invoice_no || body.epc || '-'})`,
    };
  }

  // Stock Opname
  if (method === 'POST' && path === '/api/stocktake/sessions') {
    return {
      action: 'START_OPNAME',
      note: `Memulai sesi Stock Opname zona ${body.zone || '-'}`,
    };
  }
  if (method === 'POST' && path === '/api/stocktake/scan-submit') {
    return {
      action: 'SUBMIT_OPNAME_SCAN',
      note: `Mengirim hasil scan opname (${Array.isArray(body.epcs) ? body.epcs.length : 0} EPC)`,
    };
  }
  if (method === 'POST' && path === '/api/stocktake/approve') {
    return {
      action: 'APPROVE_OPNAME',
      note: `Menyetujui penyesuaian Stock Opname ke Buku Besar Stok`,
    };
  }

  // Gate Security & Gate Pass
  if (method === 'POST' && path === '/api/gate-passes/generate') {
    return {
      action: 'GENERATE_GATE_PASS',
      note: `Menerbitkan Gate Pass untuk ${body.reference_resi || '-'} (${body.customer_or_destination || '-'})`,
    };
  }
  if (method === 'POST' && path.includes('/api/gate-passes/') && path.endsWith('/scan-out')) {
    return {
      action: 'GATE_SCAN_OUT',
      note: `Mengizinkan keluar gerbang Gate Pass ${params.code || path.split('/')[3] || '-'}`,
    };
  }
  if ((method === 'POST' || method === 'PATCH') && path.includes('/api/gate-passes/') && path.endsWith('/cancel')) {
    return {
      action: 'CANCEL_GATE_PASS',
      note: `Membatalkan Gate Pass ${params.code || path.split('/')[3] || '-'} (${body.reason || '-'})`,
    };
  }
  if (method === 'POST' && path === '/api/gate/simulate-breach') {
    return {
      action: 'SIMULATE_GATE_ALARM',
      note: `Simulasi alarm penyusupan gerbang RFID`,
    };
  }

  // Fallback untuk endpoint mutasi lainnya
  const slug = path
    .replace(/^\/api\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
  return {
    action: `${method}_${slug}`.slice(0, 60),
    note: `${method} ${path}`,
  };
}

async function resolveActor(request: FastifyRequest): Promise<{
  userId: string | null;
  username: string;
  fullName: string;
  role: string;
}> {
  const reqUser = (request as any).user as
    | { id?: string; username?: string; full_name?: string; role?: string }
    | undefined;

  const headerId = String(request.headers['x-actor-id'] || '').trim();
  const headerUsername = String(request.headers['x-actor-username'] || '').trim();
  const headerRole = String(request.headers['x-actor-role'] || '').trim();
  const headerName = String(request.headers['x-actor-name'] || '').trim();

  const candidateId = reqUser?.id || (UUID_REGEX.test(headerId) ? headerId : null);
  const candidateUsername = reqUser?.username || headerUsername || '';
  const candidateRole = reqUser?.role || headerRole || 'STAFF';
  const candidateName = reqUser?.full_name || headerName || candidateUsername || 'System';

  let resolvedUserId: string | null = candidateId && UUID_REGEX.test(candidateId) ? candidateId : null;
  let resolvedName = candidateName;
  let resolvedRole = candidateRole;
  let resolvedUsername = candidateUsername || candidateName;

  if (isPostgresConnected && (!resolvedUserId || !reqUser)) {
    try {
      if (resolvedUserId) {
        const res = await db.query(
          'SELECT id, username, full_name, role FROM public.users WHERE id = $1 LIMIT 1',
          [resolvedUserId]
        );
        if (res.rows[0]) {
          resolvedUsername = res.rows[0].username;
          resolvedName = res.rows[0].full_name || res.rows[0].username;
          resolvedRole = res.rows[0].role;
        }
      } else if (candidateUsername) {
        const res = await db.query(
          'SELECT id, username, full_name, role FROM public.users WHERE LOWER(username) = LOWER($1) LIMIT 1',
          [candidateUsername]
        );
        if (res.rows[0]) {
          resolvedUserId = res.rows[0].id;
          resolvedUsername = res.rows[0].username;
          resolvedName = res.rows[0].full_name || res.rows[0].username;
          resolvedRole = res.rows[0].role;
        }
      }
    } catch {
      // Abaikan error lookup user agar tidak mengganggu respons utama
    }
  }

  return {
    userId: resolvedUserId,
    username: resolvedUsername,
    fullName: resolvedName,
    role: resolvedRole,
  };
}

export function registerActivityAuditHook(app: FastifyInstance) {
  app.addHook('onResponse', async (request, reply) => {
    try {
      const method = request.method.toUpperCase();
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
      if (reply.statusCode < 200 || reply.statusCode >= 300) return;

      const body =
        request.body && typeof request.body === 'object'
          ? (request.body as Record<string, any>)
          : {};
      const params =
        request.params && typeof request.params === 'object'
          ? (request.params as Record<string, any>)
          : {};

      const info = describeActivity(method, request.url, body, params);
      if (!info) return;

      const actor = await resolveActor(request);
      const payload = {
        username: actor.username,
        full_name: actor.fullName,
        role: actor.role,
        method,
        path: request.url.split('?')[0],
        note: info.note,
      };

      if (isPostgresConnected) {
        await db.query(
          'INSERT INTO audit_logs (user_id, action, payload) VALUES ($1, $2, $3)',
          [actor.userId, info.action, JSON.stringify(payload)]
        );
      } else {
        memoryStore.audit_logs.unshift({
          id: memoryStore.audit_logs.length + 1,
          user_id: (actor.userId as any) || 0,
          user_name: actor.fullName,
          action: info.action,
          payload,
          created_at: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      console.error('[Activity Audit Hook Warning]:', err?.message || err);
    }
  });
}
