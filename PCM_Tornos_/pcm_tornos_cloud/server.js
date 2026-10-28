'use strict';
require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { isDeepStrictEqual } = require('util');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN;
if (!process.env.DATABASE_URL || !JWT_SECRET || !BOOTSTRAP_TOKEN) {
  console.error('Configure DATABASE_URL, JWT_SECRET e BOOTSTRAP_TOKEN nas variáveis de ambiente.');
  process.exit(1);
}
app.disable('x-powered-by');
// CSP desativada porque a interface original contém script inline; demais cabeçalhos Helmet permanecem ativos.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20mb' }));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });

const DEFAULT_PERMS = {
  admin: ['*'],
  gestor: ['equipment','records','failures','workOrders','plans','items','movements','suppliers','costs','audit','seq'],
  tecnico: ['failures','workOrders','audit','seq'],
  operador: ['failures','audit','seq']
};
const PUBLIC_USER_FIELDS = ['id','name','username','role','active'];
const publicUsers = users => (users || []).map(u => Object.fromEntries(PUBLIC_USER_FIELDS.filter(k => u[k] !== undefined).map(k => [k,u[k]])));
function publicData(data) {
  const copy = structuredClone(data);
  copy.users = publicUsers(copy.users);
  return copy;
}
function dataForRole(data, role, userId) {
  const copy = publicData(data);
  if (!['admin','gestor'].includes(role)) {
    copy.costs = [];
    copy.suppliers = [];
    copy.audit = [];
    copy.settings = { ...copy.settings, laborRate: 0, downtimeCostPerHour: 0 };
  }
  if (role === 'tecnico') copy.plans = [];
  if (role === 'operador') {
    copy.records = []; copy.workOrders = []; copy.plans = []; copy.items = []; copy.movements = [];
    copy.equipment = copy.equipment.map(e => { const x = { ...e }; delete x.acqValue; delete x.estValue; return x; });
  }
  return copy;
}
function mergeAudit(existing, incoming) {
  const out = [...(incoming || []), ...(existing || [])], seen = new Set(), unique = [];
  for (const item of out) {
    const key = JSON.stringify([item.at,item.user,item.action,item.entity,item.id,item.detail]);
    if (!seen.has(key)) { seen.add(key); unique.push(item); }
    if (unique.length >= 600) break;
  }
  return unique;
}
function hashLegacy(password, salt) {
  let h = crypto.createHash('sha256').update(String(salt) + String(password), 'utf8').digest('hex');
  for (let i = 0; i < 1500; i++) h = crypto.createHash('sha256').update(h + String(salt), 'utf8').digest('hex');
  return h;
}
function safeEqual(a,b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function validState(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.users) || !Array.isArray(data.equipment)) return false;
  const arrays = ['records','failures','workOrders','plans','items','movements','suppliers','costs','audit'];
  return arrays.every(k => Array.isArray(data[k])) && data.settings && typeof data.settings === 'object';
}
async function getState(client = pool) {
  const result = await client.query('SELECT id, version, data, updated_at FROM pcm_state WHERE id=1');
  return result.rows[0] || null;
}
async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS pcm_state (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    version BIGINT NOT NULL DEFAULT 1,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  app.listen(PORT, () => console.log(`PCM Tornos disponível na porta ${PORT}`));
}
function bearer(req, res, next) {
  const value = req.headers.authorization || '';
  if (!value.startsWith('Bearer ')) return res.status(401).json({ error: 'Sessão ausente. Entre novamente.' });
  try { req.claims = jwt.verify(value.slice(7), JWT_SECRET); next(); }
  catch (_) { return res.status(401).json({ error: 'Sessão inválida ou expirada. Entre novamente.' }); }
}
async function actorFor(req, row) {
  if (!row) return null;
  return (row.data.users || []).find(u => u.id === req.claims.sub && u.active !== false) || null;
}
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Muitas tentativas de acesso. Aguarde 15 minutos e tente novamente.' } });
app.get('/api/status', async (_req,res) => {
  try { const row = await getState(); res.json({ initialized: !!row }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Não foi possível consultar o estado do servidor.' }); }
});
app.post('/api/bootstrap', async (req,res) => {
  if (!safeEqual(String(req.headers['x-bootstrap-token'] || ''), BOOTSTRAP_TOKEN)) return res.status(403).json({ error: 'Token de inicialização inválido.' });
  const data = req.body && req.body.data;
  if (!validState(data)) return res.status(400).json({ error: 'Arquivo de dados inválido ou incompleto.' });
  if (!data.users.some(u => u.username && (u.hash && u.salt || u.passwordHash))) return res.status(400).json({ error: 'O backup não contém um usuário com credenciais válidas.' });
  try {
    const result = await pool.query('INSERT INTO pcm_state (id, version, data) VALUES (1, 1, $1::jsonb) ON CONFLICT (id) DO NOTHING RETURNING version', [JSON.stringify(data)]);
    if (!result.rowCount) return res.status(409).json({ error: 'O banco já foi inicializado. A importação inicial só pode ocorrer uma vez.' });
    res.json({ ok: true, version: 1, message: 'Dados importados. Faça login com uma conta já existente no backup.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Falha ao importar os dados.' }); }
});
app.post('/api/login', loginLimiter, async (req,res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await getState(client);
    if (!row) { await client.query('ROLLBACK'); return res.status(503).json({ error: 'Banco não inicializado. Acesse Importar dados e carregue o backup do sistema antigo.' }); }
    const user = row.data.users.find(u => String(u.username || '').toLowerCase() === username && u.active !== false);
    let valid = false, upgrade = false;
    if (user?.passwordHash) valid = await bcrypt.compare(password, user.passwordHash);
    else if (user?.hash && user?.salt) { valid = safeEqual(hashLegacy(password, user.salt), user.hash); upgrade = valid; }
    if (!valid) { await client.query('ROLLBACK'); return res.status(401).json({ error: 'Usuário ou senha inválidos.' }); }
    let data = row.data, version = Number(row.version);
    if (upgrade) {
      data = structuredClone(row.data);
      const stored = data.users.find(u => u.id === user.id);
      stored.passwordHash = await bcrypt.hash(password, 12); delete stored.hash; delete stored.salt;
      const update = await client.query('UPDATE pcm_state SET data=$1::jsonb, version=version+1, updated_at=NOW() WHERE id=1 AND version=$2 RETURNING version', [JSON.stringify(data), row.version]);
      if (update.rowCount) version = Number(update.rows[0].version);
      else { const fresh = await getState(client); data = fresh.data; version = Number(fresh.version); }
    }
    await client.query('COMMIT');
    const token = jwt.sign({ username: user.username }, JWT_SECRET, { subject: user.id, expiresIn: '8h', issuer: 'pcm-tornos' });
    const fresh = await getState();
    const activeUser = fresh.data.users.find(u => u.id === user.id);
    res.json({ token, user: { id: activeUser.id, username: activeUser.username, role: activeUser.role, name: activeUser.name }, version: Number(fresh.version), data: dataForRole(fresh.data, activeUser.role, activeUser.id) });
  } catch (e) { await client.query('ROLLBACK').catch(()=>{}); console.error(e); res.status(500).json({ error: 'Falha ao autenticar no servidor.' }); }
  finally { client.release(); }
});
app.get('/api/state', bearer, async (req,res) => {
  try {
    const row = await getState(); if (!row) return res.status(503).json({ error: 'Banco de dados ainda não inicializado.' });
    const actor = await actorFor(req,row); if (!actor) return res.status(401).json({ error: 'Usuário inativo ou sessão revogada.' });
    res.json({ version: Number(row.version), data: dataForRole(row.data, actor.role, actor.id), updatedAt: row.updated_at });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Falha ao carregar dados do servidor.' }); }
});
app.put('/api/state', bearer, async (req,res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await getState(client); if (!row) { await client.query('ROLLBACK'); return res.status(503).json({ error: 'Banco não inicializado.' }); }
    const actor = await actorFor(req,row); if (!actor) { await client.query('ROLLBACK'); return res.status(401).json({ error: 'Usuário inativo ou sessão revogada.' }); }
    if (Number(req.body?.version) !== Number(row.version)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Conflito: os dados foram alterados por outro usuário. Atualize a página para carregar a versão mais recente.' }); }
    const incoming = req.body?.data;
    if (!validState(incoming)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Estrutura de dados inválida.' }); }
    const allowed = DEFAULT_PERMS[actor.role] || [];
    const currentView = dataForRole(row.data, actor.role, actor.id);
    const changed = [...new Set([...Object.keys(currentView), ...Object.keys(incoming)])].filter(k => k === 'users' ? !isDeepStrictEqual(publicUsers(currentView.users), publicUsers(incoming.users)) : !isDeepStrictEqual(currentView[k], incoming[k]));
    const denied = changed.filter(k => k === 'users' ? actor.role !== 'admin' : !allowed.includes('*') && !allowed.includes(k));
    if (denied.length) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Seu perfil não pode alterar: ' + denied.join(', ') }); }
    // Mescla somente grupos autorizados; dados ocultos/read-only nunca são substituídos por arrays filtrados do cliente.
    const merged = structuredClone(row.data);
    for (const key of changed) {
      if (key === 'users') {
        if (actor.role !== 'admin') continue;
        const oldUsers = new Map(row.data.users.map(u => [u.id,u]));
        for (const u of incoming.users) {
          const old = oldUsers.get(u.id);
          if (!old) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Crie novos usuários pela tela Usuários; não é permitido inserir contas pela restauração genérica.' }); }
          for (const cred of ['salt','hash','passwordHash']) { if (old[cred] !== undefined) u[cred] = old[cred]; else delete u[cred]; }
        }
        merged.users = incoming.users;
      } else if (key === 'audit' && !['admin','gestor'].includes(actor.role)) {
        merged.audit = mergeAudit(row.data.audit, incoming.audit);
      } else if (allowed.includes('*') || allowed.includes(key)) {
        merged[key] = incoming[key];
      }
    }
    if (!merged.users.some(u => u.id === actor.id && u.active !== false)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Não é permitido remover ou desativar o usuário da sessão atual.' }); }
    const update = await client.query('UPDATE pcm_state SET data=$1::jsonb, version=version+1, updated_at=NOW() WHERE id=1 AND version=$2 RETURNING version', [JSON.stringify(merged), row.version]);
    if (!update.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Conflito de gravação. Atualize a página.' }); }
    await client.query('COMMIT');
    res.json({ version: Number(update.rows[0].version), data: dataForRole(merged, actor.role, actor.id) });
  } catch (e) { await client.query('ROLLBACK').catch(()=>{}); console.error(e); res.status(500).json({ error: 'Falha ao salvar no banco de dados.' }); }
  finally { client.release(); }
});
app.post('/api/users', bearer, async (req,res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await getState(client); if (!row) { await client.query('ROLLBACK'); return res.status(503).json({ error: 'Banco não inicializado.' }); }
    const actor = await actorFor(req,row); if (!actor || actor.role !== 'admin') { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Somente administradores podem gerenciar usuários.' }); }
    if (Number(req.body?.version) !== Number(row.version)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Conflito de dados. Atualize a página antes de gerenciar usuários.' }); }
    const { id, name, username: rawUsername, role, active = true, password } = req.body || {};
    const username = String(rawUsername || '').trim().toLowerCase();
    if (!String(name || '').trim() || !username || !['admin','gestor','tecnico','operador'].includes(role)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nome, usuário e perfil são obrigatórios.' }); }
    const data = structuredClone(row.data);
    let user = id ? data.users.find(u => u.id === id) : null;
    if (id && !user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Usuário não encontrado.' }); }
    if (data.users.some(u => u.username === username && u.id !== id)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Nome de usuário já existe.' }); }
    if ((!id || password) && (typeof password !== 'string' || password.length < 8)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'A senha deve ter no mínimo 8 caracteres.' }); }
    if (id === actor.id && (role !== 'admin' || active === false)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Você não pode remover seu próprio acesso de administrador.' }); }
    if (!user) {
      data.seq = data.seq || {}; data.seq.U = (data.seq.U || 0) + 1;
      user = { id: 'U' + String(data.seq.U).padStart(3,'0'), name: String(name).trim(), username, role, active: active !== false, passwordHash: await bcrypt.hash(password,12) };
      data.users.push(user);
    } else {
      user.name = String(name).trim(); user.username = username; user.role = role; user.active = active !== false;
      if (password) user.passwordHash = await bcrypt.hash(password,12);
      delete user.hash; delete user.salt;
    }
    data.audit = data.audit || []; data.audit.unshift({ at: new Date().toISOString().slice(0,16), user: actor.username, action: 'gerenciar usuário', entity: 'usuário', id: user.id, detail: username });
    if (data.audit.length > 600) data.audit.length = 600;
    const update = await client.query('UPDATE pcm_state SET data=$1::jsonb, version=version+1, updated_at=NOW() WHERE id=1 AND version=$2 RETURNING version', [JSON.stringify(data), row.version]);
    if (!update.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Conflito de gravação. Atualize a página e tente novamente.' }); }
    await client.query('COMMIT');
    res.json({ version: Number(update.rows[0].version), data: dataForRole(data, actor.role, actor.id) });
  } catch (e) { await client.query('ROLLBACK').catch(()=>{}); console.error(e); res.status(500).json({ error: 'Falha ao gerenciar usuário.' }); }
  finally { client.release(); }
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (_req,res) => res.sendFile(path.join(__dirname,'public','PCM_Tornos_Cloud.html')));
app.use((err,_req,res,_next) => { console.error(err); res.status(500).json({ error: 'Erro interno do servidor.' }); });
init().catch(e => { console.error('Não foi possível iniciar o PCM:', e); process.exit(1); });
