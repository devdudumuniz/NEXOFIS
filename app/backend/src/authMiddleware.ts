import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export type NexofisRole = 'admin' | 'analyst' | 'viewer';

export interface NexofisPrincipal {
  userId: string;
  email?: string;
  displayName?: string;
  role: NexofisRole;
  authEnabled: boolean;
  issuedAt?: number;
  expiresAt?: number;
}

export interface AuthenticatedRequest extends Request {
  nexofisPrincipal?: NexofisPrincipal;
}

export interface SignedTokenPayload {
  sub: string;
  email?: string;
  displayName?: string;
  role: NexofisRole;
  iat: number;
  exp: number;
}

const VALID_ROLES = new Set<NexofisRole>(['admin', 'analyst', 'viewer']);

// Ephemeral in-memory fallback secret for non-production local runs when NEXOFIS_SESSION_SECRET is not set.
// Never hardcoded and never persisted to disk.
const EPHEMERAL_SESSION_SECRET = crypto.randomBytes(32).toString('hex');

function resolveSigningSecret(explicitSecret?: string): string {
  const fromArg = explicitSecret?.trim();
  if (fromArg) return fromArg;
  const fromEnv = process.env.NEXOFIS_SESSION_SECRET?.trim();
  if (fromEnv) return fromEnv;
  return EPHEMERAL_SESSION_SECRET;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64').toString('utf8');
}

export function signNexofisToken(
  claims: { sub: string; email?: string; displayName?: string; role: NexofisRole },
  options: { ttlSeconds?: number; secret?: string; nowSeconds?: number } = {}
): string {
  if (!VALID_ROLES.has(claims.role)) {
    throw new Error(`Papel RBAC inválido: ${String(claims.role)}`);
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = Math.max(60, Math.min(options.ttlSeconds ?? 3600, 86400));
  const payload: SignedTokenPayload = {
    sub: claims.sub,
    email: claims.email,
    displayName: claims.displayName,
    role: claims.role,
    iat: now,
    exp: now + ttl,
  };

  const headerPart = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'NXF' }));
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerPart}.${payloadPart}`;
  const sig = crypto
    .createHmac('sha256', resolveSigningSecret(options.secret))
    .update(signingInput)
    .digest();

  return `${signingInput}.${base64UrlEncode(sig)}`;
}

export function verifyNexofisToken(
  token: string,
  options: { secret?: string; nowSeconds?: number } = {}
): { valid: true; payload: SignedTokenPayload } | { valid: false; reason: string } {
  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'Formato de token inválido.' };
  }

  const [headerPart, payloadPart, sigPart] = parts;
  const signingInput = `${headerPart}.${payloadPart}`;
  const expectedSig = base64UrlEncode(
    crypto
      .createHmac('sha256', resolveSigningSecret(options.secret))
      .update(signingInput)
      .digest()
  );

  const a = Buffer.from(sigPart);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'Assinatura HMAC inválida.' };
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payloadPart)) as Partial<SignedTokenPayload>;
    if (!parsed.sub || !parsed.role || !VALID_ROLES.has(parsed.role)) {
      return { valid: false, reason: 'Claims obrigatórios ausentes ou papel inválido.' };
    }
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (typeof parsed.exp !== 'number' || parsed.exp <= now) {
      return { valid: false, reason: 'Token expirado.' };
    }
    return {
      valid: true,
      payload: {
        sub: String(parsed.sub),
        email: parsed.email ? String(parsed.email) : undefined,
        displayName: parsed.displayName ? String(parsed.displayName) : undefined,
        role: parsed.role,
        iat: typeof parsed.iat === 'number' ? parsed.iat : now,
        exp: parsed.exp,
      },
    };
  } catch {
    return { valid: false, reason: 'Payload de token malformado.' };
  }
}

export function hashPasswordScrypt(password: string, saltHex?: string): string {
  const salt = saltHex ?? crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPasswordScrypt(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Fail-closed production auth policy (A09):
 * - Always enforced if NEXOFIS_AUTH_ENABLED=true.
 * - In NODE_ENV=production, ALWAYS enforced by default unless NEXOFIS_ALLOW_INSECURE_LOCAL=true is explicitly set.
 */
export function isAuthEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicitEnabled = String(env.NEXOFIS_AUTH_ENABLED ?? '').trim().toLowerCase();
  if (explicitEnabled === 'true') return true;

  const isProd = String(env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  const allowInsecureLocal =
    String(env.NEXOFIS_ALLOW_INSECURE_LOCAL ?? '').trim().toLowerCase() === 'true';

  if (isProd && !allowInsecureLocal) {
    return true;
  }

  return false;
}

/**
 * Validates production auth prerequisites at boot (A09):
 * Refuses to run with an ephemeral/weak signing secret when auth is enforced in production.
 */
export function validateProductionAuthConfig(env: NodeJS.ProcessEnv = process.env): void {
  const isProd = String(env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  if (!isProd) return;
  if (!isAuthEnforced(env)) return;

  const secret = env.NEXOFIS_SESSION_SECRET?.trim() ?? '';
  if (secret.length < 32) {
    throw new Error(
      'Configuração insegura em produção: NEXOFIS_SESSION_SECRET com pelo menos 32 caracteres é obrigatório quando NODE_ENV=production (ou defina NEXOFIS_ALLOW_INSECURE_LOCAL=true apenas para uso estritamente local).'
    );
  }
}

export function extractOptionalPrincipal(
  req: Request,
  options?: { secret?: string }
): NexofisPrincipal | null {
  const authHeader = String(req.headers.authorization ?? '').trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) return null;
  const rawToken = authHeader.slice(7).trim();
  const verification = verifyNexofisToken(rawToken, { secret: options?.secret });
  if (!verification.valid) return null;
  return {
    userId: verification.payload.sub,
    email: verification.payload.email,
    displayName: verification.payload.displayName,
    role: verification.payload.role,
    authEnabled: true,
    issuedAt: verification.payload.iat,
    expiresAt: verification.payload.exp,
  };
}

export function createAuthMiddleware(options?: {
  allowedRoles?: NexofisRole[];
  enforceOverride?: boolean;
  secret?: string;
}) {
  const allowedRoles = options?.allowedRoles ?? ['admin', 'analyst'];

  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const enforced = options?.enforceOverride ?? isAuthEnforced();
    if (!enforced) {
      // Even in local mode, respect a valid Bearer token if present so actor attribution works consistently
      const optional = extractOptionalPrincipal(req, { secret: options?.secret });
      req.nexofisPrincipal = optional ?? {
        userId: 'local-workspace',
        displayName: 'Workspace Local (sem autenticação)',
        role: 'admin',
        authEnabled: false,
      };
      next();
      return;
    }

    const authHeader = String(req.headers.authorization ?? '').trim();
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      res.status(401).json({
        error: 'Autenticação obrigatória. Envie o cabeçalho Authorization: Bearer <token>.',
      });
      return;
    }

    const rawToken = authHeader.slice(7).trim();
    const verification = verifyNexofisToken(rawToken, { secret: options?.secret });
    if (!verification.valid) {
      res.status(401).json({
        error: `Token inválido ou expirado: ${verification.reason}`,
      });
      return;
    }

    if (!allowedRoles.includes(verification.payload.role)) {
      res.status(403).json({
        error: `Permissão insuficiente para esta operação. Papel atual: ${verification.payload.role}.`,
      });
      return;
    }

    req.nexofisPrincipal = {
      userId: verification.payload.sub,
      email: verification.payload.email,
      displayName: verification.payload.displayName,
      role: verification.payload.role,
      authEnabled: true,
      issuedAt: verification.payload.iat,
      expiresAt: verification.payload.exp,
    };
    next();
  };
}
