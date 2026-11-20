import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import jwt from 'jsonwebtoken';

export const qaInboundActor = { id: randomUUID(), role: 'ADMIN', is_active: true };
const secret = randomBytes(32).toString('hex');
export function qaInboundToken(role: string = qaInboundActor.role) {
  process.env.JWT_SECRET = secret;
  return jwt.sign({ id: qaInboundActor.id, role }, secret, { expiresIn: '20m' });
}

export const qaInboundHeaders = (role?: string) => ({ authorization: 'Bearer ' + qaInboundToken(role) });

export async function addQaInboundAccount(pool: Pool) {
  await pool.query('ALTER TABLE users ADD COLUMN role text, ADD COLUMN is_active boolean');
  await pool.query('INSERT INTO users(id,role,is_active) VALUES($1,$2,true)', [qaInboundActor.id,qaInboundActor.role]);
}
