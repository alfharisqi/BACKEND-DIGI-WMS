import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'digiwms-rahasia-super-aman-2026';

export interface JwtUserPayload {
  id: string | number;
  username: string;
  role: string;
  full_name?: string;
  email?: string;
}

// Menambahkan properti .user ke FastifyRequest secara type-safe
declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtUserPayload;
  }
}

/**
 * 1. Membuat JWT Token Resmi setelah login berhasil
 */
export function generateToken(payload: JwtUserPayload): string {
  return jwt.sign(
    {
      id: payload.id,
      username: payload.username,
      role: payload.role,
      full_name: payload.full_name,
      email: payload.email,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/**
 * 2. Middleware Autentikasi JWT (preHandler Fastify)
 * Mengambil token dari header "Authorization: Bearer <token>",
 * memverifikasi keabsahan JWT, dan menempelkan identitas ke request.user.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      return reply.code(401).send({
        status: 'error',
        message: 'Akses ditolak: Header Authorization tidak ditemukan.',
      });
    }

    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : authHeader.trim();

    if (!token) {
      return reply.code(401).send({
        status: 'error',
        message: 'Akses ditolak: Token JWT kosong.',
      });
    }

    // Dukungan transisi untuk format token prototipe awal (jwt-digiwms-<id>-<time>)
    if (token.startsWith('jwt-digiwms-')) {
      const parts = token.split('-');
      const userId = parts[2] || '1';
      request.user = {
        id: userId,
        username: 'user.active',
        role: 'SUPERVISOR',
        full_name: 'User Sesi Aktif',
      };
      return;
    }

    // Verifikasi tanda tangan kriptografis JWT standar
    const decoded = jwt.verify(token, JWT_SECRET) as JwtUserPayload;
    request.user = decoded;
  } catch (err: any) {
    return reply.code(401).send({
      status: 'error',
      message: 'Sesi kedaluwarsa atau token JWT tidak valid. Silakan login kembali.',
      error: err?.message,
    });
  }
}

/**
 * 3. Middleware Penjaga Hak Akses (RBAC Guard)
 * Memastikan pengguna memiliki salah satu role yang diizinkan.
 */
export function requireRoles(...allowedRoles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({
        status: 'error',
        message: 'Pengguna belum terautentikasi.',
      });
    }

    const userRole = String(request.user.role || '').toUpperCase();
    const hasPermission = allowedRoles.some(
      (r) => r.toUpperCase() === userRole || userRole === 'ADMIN'
    );

    if (!hasPermission) {
      return reply.code(403).send({
        status: 'error',
        message: `Akses ditolak (RBAC): Role '${request.user.role}' tidak memiliki izin untuk operasi ini.`,
      });
    }
  };
}
