// Kelajak testlari: backend (Cloudflare Worker + D1)
//  /api/info       GET   narx (ochiq)
//  /api/login      POST  Google ID token -> sessiya tokeni
//  /api/me         GET   foydalanuvchi + to'langanmi
//  /api/order      POST  to'lov buyurtmasi + Payme checkout havolasi
//  /api/questions  GET   400 ta savol (faqat to'lagan foydalanuvchiga)
//  /api/payme      POST  Payme Merchant API (JSON-RPC), Payme serveri chaqiradi
import QUESTIONS from './questions.js';

const TX_TIMEOUT = 12 * 60 * 60 * 1000; // Payme: tranzaksiya 12 soat
const SESSION_DAYS = 30;
const te = new TextEncoder();

/* ---------------- yordamchilar ---------------- */
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signSession(payload, secret) {
  const body = b64u(te.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), te.encode(body));
  return body + '.' + b64u(sig);
}
async function verifySession(token, secret) {
  try {
    const [body, sig] = token.split('.');
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64u(sig), te.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (env, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(env) } });

async function authUser(request, env) {
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Bearer ')) return null;
  return verifySession(h.slice(7), env.SESSION_SECRET);
}
async function isPaid(env, email) {
  const r = await env.DB.prepare('SELECT 1 AS ok FROM orders WHERE email=? AND state=1 LIMIT 1').bind(email).first();
  return !!r;
}
const priceTiyin = (env) => Math.round(Number(env.PRICE_UZS) * 100);

/* ---------------- ochiq API ---------------- */
async function login(request, env) {
  const { credential } = await request.json().catch(() => ({}));
  if (!credential) return json(env, { error: 'credential kerak' }, 400);
  // Google ID tokenni Google'ning o'zi tekshiradi
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!r.ok) return json(env, { error: 'Google tokeni yaroqsiz' }, 401);
  const g = await r.json();
  if (g.aud !== env.GOOGLE_CLIENT_ID || String(g.email_verified) !== 'true' || !g.email)
    return json(env, { error: 'Google hisobi tasdiqlanmadi' }, 401);
  const email = g.email.toLowerCase();
  const name = g.name || email.split('@')[0];
  await env.DB.prepare('INSERT INTO users(email,name,created_at) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name')
    .bind(email, name, Date.now()).run();
  const token = await signSession({ email, name, exp: Date.now() + SESSION_DAYS * 864e5 }, env.SESSION_SECRET);
  return json(env, { token, user: { email, name, paid: await isPaid(env, email) } });
}

async function createOrder(user, env) {
  if (await isPaid(env, user.email)) return json(env, { error: 'Allaqachon to\'langan' }, 409);
  let o = await env.DB.prepare('SELECT * FROM orders WHERE email=? AND state=0 ORDER BY id DESC LIMIT 1').bind(user.email).first();
  const amount = priceTiyin(env);
  if (!o || o.amount !== amount) {
    const res = await env.DB.prepare('INSERT INTO orders(email,amount,state,created_at) VALUES(?,?,0,?)').bind(user.email, amount, Date.now()).run();
    o = { id: res.meta.last_row_id, amount };
  }
  // Payme checkout: base64("m=...;ac.order_id=...;a=...;l=uz;c=...")
  const params = `m=${env.PAYME_MERCHANT_ID};ac.order_id=${o.id};a=${o.amount};l=uz;c=${env.SITE_URL}?payme=return`;
  const url = env.PAYME_CHECKOUT_URL.replace(/\/$/, '') + '/' + btoa(params);
  return json(env, { orderId: o.id, url });
}

/* ---------------- Payme Merchant API ---------------- */
const MSG = {
  [-31001]: { ru: 'Неверная сумма', uz: 'Noto‘g‘ri summa', en: 'Wrong amount' },
  [-31003]: { ru: 'Транзакция не найдена', uz: 'Tranzaksiya topilmadi', en: 'Transaction not found' },
  [-31007]: { ru: 'Невозможно отменить транзакцию', uz: 'Tranzaksiyani bekor qilib bo‘lmaydi', en: 'Cannot cancel transaction' },
  [-31008]: { ru: 'Невозможно выполнить операцию', uz: 'Amalni bajarib bo‘lmaydi', en: 'Cannot perform operation' },
  [-31050]: { ru: 'Заказ не найден', uz: 'Buyurtma topilmadi', en: 'Order not found' },
  [-31051]: { ru: 'Заказ не доступен для оплаты', uz: 'Buyurtma to‘lov uchun mavjud emas', en: 'Order is not payable' },
  [-31099]: { ru: 'Заказ уже оплачивается', uz: 'Buyurtma allaqachon to‘lanmoqda', en: 'Order is already being paid' },
  [-32300]: { ru: 'Неверный метод HTTP', uz: 'HTTP usuli noto‘g‘ri', en: 'Invalid HTTP method' },
  [-32504]: { ru: 'Недостаточно привилегий', uz: 'Ruxsat yo‘q', en: 'Insufficient privileges' },
  [-32700]: { ru: 'Ошибка разбора JSON', uz: 'JSON xatosi', en: 'Parse error' },
  [-32601]: { ru: 'Метод не найден', uz: 'Metod topilmadi', en: 'Method not found' },
  [-32600]: { ru: 'Неверный запрос', uz: 'So‘rov noto‘g‘ri', en: 'Invalid request' },
};
const pmJson = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const pmErr = (id, code, data) => pmJson({ id, error: { code, message: MSG[code], ...(data ? { data } : {}) } });
const pmOk = (id, result) => pmJson({ id, result });
class PmError extends Error { constructor(code, data) { super(String(code)); this.code = code; this.data = data; } }

async function pmCheckOrder(env, params) {
  const oid = Number(params?.account?.order_id);
  if (!Number.isInteger(oid) || oid <= 0) throw new PmError(-31050, 'order_id');
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(oid).first();
  if (!o) throw new PmError(-31050, 'order_id');
  if (o.state !== 0) throw new PmError(-31051, 'order_id');
  if (params.amount !== o.amount) throw new PmError(-31001, 'amount');
  return o;
}
const getTx = (env, id) => env.DB.prepare('SELECT * FROM transactions WHERE payme_id=?').bind(String(id)).first();
const txView = (t) => ({
  create_time: t.create_time, perform_time: t.perform_time, cancel_time: t.cancel_time,
  transaction: t.payme_id, state: t.state, reason: t.reason ?? null,
});

async function cancelPending(env, tx, reason) {
  const now = Date.now();
  await env.DB.prepare('UPDATE transactions SET state=-1, cancel_time=?, reason=? WHERE payme_id=?').bind(now, reason, tx.payme_id).run();
  return { ...tx, state: -1, cancel_time: now, reason };
}

const PM = {
  async CheckPerformTransaction(env, p) {
    await pmCheckOrder(env, p);
    return { allow: true };
  },

  async CreateTransaction(env, p) {
    const tx = await getTx(env, p.id);
    if (tx) {
      if (tx.state !== 1) throw new PmError(-31008);
      if (Date.now() - tx.create_time > TX_TIMEOUT) { await cancelPending(env, tx, 4); throw new PmError(-31008); }
      return { create_time: tx.create_time, transaction: tx.payme_id, state: 1 };
    }
    const o = await pmCheckOrder(env, p);
    const other = await env.DB.prepare('SELECT 1 AS x FROM transactions WHERE order_id=? AND state=1 LIMIT 1').bind(o.id).first();
    if (other) throw new PmError(-31099, 'order_id');
    const now = Date.now();
    await env.DB.prepare('INSERT INTO transactions(payme_id,order_id,time,amount,create_time,state) VALUES(?,?,?,?,?,1)')
      .bind(String(p.id), o.id, p.time, p.amount, now).run();
    return { create_time: now, transaction: String(p.id), state: 1 };
  },

  async PerformTransaction(env, p) {
    const tx = await getTx(env, p.id);
    if (!tx) throw new PmError(-31003);
    if (tx.state === 2) return { transaction: tx.payme_id, perform_time: tx.perform_time, state: 2 };
    if (tx.state !== 1) throw new PmError(-31008);
    if (Date.now() - tx.create_time > TX_TIMEOUT) { await cancelPending(env, tx, 4); throw new PmError(-31008); }
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('UPDATE transactions SET state=2, perform_time=? WHERE payme_id=?').bind(now, tx.payme_id),
      env.DB.prepare('UPDATE orders SET state=1 WHERE id=?').bind(tx.order_id),
    ]);
    return { transaction: tx.payme_id, perform_time: now, state: 2 };
  },

  async CancelTransaction(env, p) {
    const tx = await getTx(env, p.id);
    if (!tx) throw new PmError(-31003);
    if (tx.state === 1) {
      const t = await cancelPending(env, tx, p.reason ?? null);
      return { transaction: t.payme_id, cancel_time: t.cancel_time, state: -1 };
    }
    if (tx.state === 2) {
      // To'lov qaytariladi: kirish huquqi olinadi
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare('UPDATE transactions SET state=-2, cancel_time=?, reason=? WHERE payme_id=?').bind(now, p.reason ?? null, tx.payme_id),
        env.DB.prepare('UPDATE orders SET state=-1 WHERE id=?').bind(tx.order_id),
      ]);
      return { transaction: tx.payme_id, cancel_time: now, state: -2 };
    }
    return { transaction: tx.payme_id, cancel_time: tx.cancel_time, state: tx.state };
  },

  async CheckTransaction(env, p) {
    const tx = await getTx(env, p.id);
    if (!tx) throw new PmError(-31003);
    return txView(tx);
  },

  async GetStatement(env, p) {
    const { results } = await env.DB.prepare('SELECT * FROM transactions WHERE time>=? AND time<=? ORDER BY time').bind(p.from, p.to).all();
    return {
      transactions: results.map((t) => ({
        id: t.payme_id, time: t.time, amount: t.amount, account: { order_id: String(t.order_id) },
        create_time: t.create_time, perform_time: t.perform_time, cancel_time: t.cancel_time,
        transaction: t.payme_id, state: t.state, reason: t.reason ?? null,
      })),
    };
  },
};

async function payme(request, env) {
  if (request.method !== 'POST') return pmErr(null, -32300);
  let body;
  try { body = await request.json(); } catch { return pmErr(null, -32700); }
  const id = body?.id ?? null;
  const expected = 'Basic ' + btoa('Paycom:' + env.PAYME_KEY);
  const got = request.headers.get('Authorization') || '';
  if (!env.PAYME_KEY || !safeEqual(got, expected)) return pmErr(id, -32504);
  const fn = PM[body.method];
  if (!fn) return pmErr(id, -32601, body.method);
  try {
    return pmOk(id, await fn(env, body.params || {}));
  } catch (e) {
    if (e instanceof PmError) return pmErr(id, e.code, e.data);
    console.error(e);
    return pmErr(id, -32600);
  }
}

/* ---------------- yo'naltirish ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    try {
      if (url.pathname === '/api/payme') return payme(request, env);
      if (url.pathname === '/api/info') return json(env, { price_uzs: Number(env.PRICE_UZS) });
      if (url.pathname === '/api/login' && request.method === 'POST') return login(request, env);

      const user = await authUser(request, env);
      if (!user) return json(env, { error: 'Kirish talab qilinadi' }, 401);

      if (url.pathname === '/api/me') return json(env, { user: { email: user.email, name: user.name, paid: await isPaid(env, user.email) }, price_uzs: Number(env.PRICE_UZS) });
      if (url.pathname === '/api/order' && request.method === 'POST') return createOrder(user, env);
      if (url.pathname === '/api/questions') {
        if (!(await isPaid(env, user.email))) return json(env, { error: 'To\'lov talab qilinadi' }, 402);
        return json(env, { rows: QUESTIONS });
      }
      return json(env, { error: 'Topilmadi' }, 404);
    } catch (e) {
      console.error(e);
      return json(env, { error: 'Server xatosi' }, 500);
    }
  },
};
