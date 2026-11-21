import jwt from 'jsonwebtoken';
import { uuidPattern } from './orang1-picking/contract';

const warehouseRoles = ['ADMIN', 'SUPERVISOR', 'WAREHOUSE_STAFF', 'OPERATOR'];
type Reject = (status: number, message: string) => never;
export type WarehouseSession = { id: string; role: string };

export function warehouseSession(authorization: string | undefined, reject: Reject): WarehouseSession {
  const token = /^Bearer (\S+)$/i.exec(authorization ?? '')?.[1];
  if (!token) return reject(401, 'Silakan login untuk melanjutkan.');
  const secret = process.env.JWT_SECRET;
  if (!secret) return reject(503, 'Konfigurasi autentikasi gudang belum tersedia.');
  let claims: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (typeof decoded === 'string') throw new Error('Sesi tidak valid');
    claims = decoded;
  } catch {
    return reject(401, 'Sesi tidak valid atau sudah kedaluwarsa. Silakan login kembali.');
  }
  const role = String(claims.role).toUpperCase();
  if (!warehouseRoles.includes(role)) return reject(403, 'Role ini tidak memiliki akses gudang.');
  if (typeof claims.id !== 'string' || !uuidPattern.test(claims.id)) return reject(401, 'Sesi memerlukan akun gudang dengan UUID.');
  return { id: claims.id, role };
}

export function requireWarehouseAccount<T extends { is_active?: unknown; role?: unknown }>(
  session: WarehouseSession, account: T | undefined, reject: Reject,
): T {
  const role = String(account?.role).toUpperCase();
  if (account?.is_active !== true || !warehouseRoles.includes(role) || role !== session.role) {
    return reject(403, 'Akun gudang tidak aktif atau hak akses berubah. Silakan login kembali.');
  }
  return account;
}
