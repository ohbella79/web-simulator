'use strict';

// Authentication & authorization: scrypt password hashing, opaque server-side
// sessions (HttpOnly cookie), role enforcement and audit logging.

const crypto = require('crypto');
const { db } = require('./db');
const { ROLES } = require('./lib/constants');

const COOKIE_NAME = 'island_session';
const SESSION_HOURS = 12;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expires);
  return token;
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function currentUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, s.token, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND u.active = 1`).get(token);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString().replace('T', ' ').slice(0, 19)) {
    destroySession(token);
    return null;
  }
  return row;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

// ---------- middleware ----------
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    if (!roles.includes(user.role)) {
      audit(user, 'access_denied', req.method + ' ' + req.path, '', 'Role "' + user.role + '" is not authorized for this action');
      return res.status(403).json({ error: `Your role (${user.role}) is not authorized for this action. Allowed roles: ${roles.join(', ')}.` });
    }
    req.user = user;
    next();
  };
}

function audit(user, action, entity, entityId, detail) {
  db.prepare(`INSERT INTO audit_logs (actor_email, actor_role, action, entity, entity_id, detail)
    VALUES (?,?,?,?,?,?)`).run(
    user ? user.email : 'anonymous',
    user ? user.role : '',
    action, entity || '', entityId == null ? '' : String(entityId), detail || ''
  );
}

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, currentUser,
  setSessionCookie, clearSessionCookie, requireAuth, requireRole, audit,
  COOKIE_NAME, SESSION_HOURS
};
