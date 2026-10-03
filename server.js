/* خادم المتجر الإلكتروني + مزامنة الكاشير
 *
 * المسارات العامة (لأي زائر):
 *   GET  /                        صفحة المتجر (store.html)
 *   GET  /api/store/:shop         قائمة المنتجات المعروضة
 *   POST /api/order/:shop         إرسال طلب من الزبون
 *
 * المسارات المحمية بمفتاح SYNC_KEY (ترسل في الترويسة x-sync-key):
 *   GET  /pos                     صفحة الكاشير (index.html) - الصفحة نفسها لا تحوي بيانات
 *   GET  /orders                  صفحة إدارة الطلبات
 *   GET  /api/ping
 *   GET  /api/state/:shop         بيانات الكاشير كاملة
 *   PUT  /api/state/:shop         رفع بيانات الكاشير (مع دمج التعديلات المتزامنة)
 *   GET  /api/orders/:shop
 *   PUT  /api/order-status/:shop/:orderId
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SYNC_KEY = process.env.SYNC_KEY || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

/* ---------------- CORS + ترويسات أمان ---------------- */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ---------------- التخزين (ذاكرة + ملف) ---------------- */
// shops[shopId] = { state, version }
let shops = {};
try {
  if (fs.existsSync(DATA_FILE)) shops = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
} catch (e) {
  console.error('تعذر قراءة ملف البيانات، سنبدأ فارغين:', e.message);
}
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(shops));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error('تعذر حفظ الملف:', e.message);
    }
  }, 500);
}
let lastVersion = 0;
function nextVersion(prev) {
  lastVersion = Math.max(lastVersion + 1, (prev || 0) + 1, Date.now());
  return lastVersion;
}

/* ---------------- أدوات ---------------- */
const SHOP_RE = /^[\w\u0600-\u06FF-]{1,40}$/;
function getShop(req, res) {
  const id = req.params.shop;
  if (!SHOP_RE.test(id)) { res.status(400).json({ ok: false, error: 'invalid shop id' }); return null; }
  return id;
}
function uid(prefix) { return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }
function cleanStr(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function requireKey(req, res, next) {
  if (!SYNC_KEY) return res.status(503).json({ ok: false, error: 'SYNC_KEY غير مضبوط على الخادم' });
  const given = String(req.get('x-sync-key') || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(SYNC_KEY).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: 'مفتاح الحماية غير صحيح' });
  next();
}

/* ---------------- دمج التعديلات المتزامنة ---------------- */
const COLL = ['products', 'customers', 'suppliers', 'sales', 'expenses', 'debtLedger', 'purchaseInvoices', 'onlineOrders'];
const DELTA = { products: ['quantity'], customers: ['debt'] };

function mergeItem(srv, cli, base, deltaFields) {
  const out = Object.assign({}, srv);
  const keys = new Set([...Object.keys(cli), ...Object.keys(base || {})]);
  for (const k of keys) {
    if (same(cli[k], base ? base[k] : undefined)) continue;
    if (deltaFields.includes(k) && typeof cli[k] === 'number' && base && typeof base[k] === 'number') {
      out[k] = (typeof srv[k] === 'number' ? srv[k] : 0) + (cli[k] - base[k]);
    } else if (k in cli) out[k] = cli[k];
    else delete out[k];
  }
  return out;
}

function mergeStates(server, client, base) {
  const out = Object.assign({}, server);
  out.settings = Object.assign({}, server.settings);
  const cs = client.settings || {}, bs = (base && base.settings) || {};
  for (const k of Object.keys(cs)) if (!same(cs[k], bs[k])) out.settings[k] = cs[k];

  for (const c of COLL) {
    const sArr = Array.isArray(server[c]) ? server[c] : [];
    const cArr = Array.isArray(client[c]) ? client[c] : [];
    const bArr = base && Array.isArray(base[c]) ? base[c] : [];
    const bMap = new Map(bArr.map(x => [x.id, x]));
    const cMap = new Map(cArr.map(x => [x.id, x]));
    const res = new Map(sArr.map(x => [x.id, x]));
    for (const id of bMap.keys()) if (!cMap.has(id)) res.delete(id);          // حذفها الكاشير
    for (const [id, ci] of cMap) {
      const bi = bMap.get(id);
      if (!bi) { if (!res.has(id)) res.set(id, ci); continue; }               // عنصر جديد
      if (same(ci, bi)) continue;                                              // لم يتغير عند الكاشير
      const si = res.get(id);
      if (si) res.set(id, mergeItem(si, ci, bi, DELTA[c] || []));
    }
    out[c] = [...res.values()];
  }
  for (const k of Object.keys(client)) {
    if (k === 'settings' || COLL.includes(k)) continue;
    if (!(k in out)) out[k] = client[k];
  }
  return out;
}

function validState(s) {
  return s && typeof s === 'object' && !Array.isArray(s) && Array.isArray(s.products) && s.settings && typeof s.settings === 'object';
}

/* ---------------- الصفحات ---------------- */
const page = f => (req, res) => res.sendFile(path.join(__dirname, f));
app.get('/', page('store.html'));
app.get('/store', page('store.html'));
app.get('/pos', page('index.html'));
app.get('/orders', page('orders.html'));
app.get('/api/health', (req, res) => res.json({ ok: true }));

/* ---------------- واجهات محمية بالمفتاح ---------------- */
app.get('/api/ping', requireKey, (req, res) => res.json({ ok: true }));

app.get('/api/state/:shop', requireKey, (req, res) => {
  const id = getShop(req, res); if (!id) return;
  const shop = shops[id];
  res.json({ ok: true, state: shop ? shop.state : null, version: shop ? shop.version : 0 });
});

app.put('/api/state/:shop', requireKey, (req, res) => {
  const id = getShop(req, res); if (!id) return;
  const { state: client, baseState, baseVersion } = req.body || {};
  if (!validState(client)) return res.status(400).json({ ok: false, error: 'بيانات غير صالحة' });
  const shop = shops[id];
  let merged;
  if (!shop || !shop.state) merged = client;                                   // الخادم فارغ: نعتمد بيانات الكاشير
  else if (Number(baseVersion) === shop.version) merged = client;              // الكاشير محدّث: نعتمد بياناته
  else if (validState(baseState)) merged = mergeStates(shop.state, client, baseState);
  else merged = shop.state;                                                    // لا أساس للدمج: نبقي نسخة الخادم
  shops[id] = { state: merged, version: nextVersion(shop && shop.version) };
  persist();
  res.json({ ok: true, state: merged, version: shops[id].version });
});

app.get('/api/orders/:shop', requireKey, (req, res) => {
  const id = getShop(req, res); if (!id) return;
  const st = shops[id] && shops[id].state;
  res.json({ ok: true, orders: (st && st.onlineOrders) || [] });
});

const STATUSES = ['قيد الانتظار', 'مؤكد', 'تم التسليم', 'ملغى'];
app.put('/api/order-status/:shop/:orderId', requireKey, (req, res) => {
  const id = getShop(req, res); if (!id) return;
  const shop = shops[id];
  const status = req.body && req.body.status;
  if (!STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'حالة غير معروفة' });
  const st = shop && shop.state;
  const order = st && (st.onlineOrders || []).find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ ok: false, error: 'الطلب غير موجود' });
  const prev = order.status;
  if (prev === status) return res.json({ ok: true, order });

  // إلغاء الطلب يعيد الكميات للمخزون، وإعادة تفعيله تخصمها من جديد
  if (status === 'ملغى' && prev !== 'ملغى') {
    order.items.forEach(it => { const p = st.products.find(x => x.id === it.productId); if (p) p.quantity = (p.quantity || 0) + it.qty; });
  } else if (prev === 'ملغى') {
    for (const it of order.items) {
      const p = st.products.find(x => x.id === it.productId);
      if (!p || p.quantity < it.qty) return res.status(409).json({ ok: false, error: 'المخزون غير كافٍ لإعادة تفعيل الطلب' });
    }
    order.items.forEach(it => { st.products.find(x => x.id === it.productId).quantity -= it.qty; });
  }

  // عند التسليم يُسجَّل الطلب كعملية بيع نقدية في الكاشير، ويُزال التسجيل لو تراجعت الحالة
  st.sales = st.sales || [];
  if (status === 'تم التسليم') {
    if (!st.sales.some(s => s.onlineOrderId === order.id)) {
      st.sales.push({
        id: uid('sale'), date: new Date().toISOString(),
        items: order.items.map(it => {
          const p = st.products.find(x => x.id === it.productId);
          return { productId: it.productId, name: it.name, qty: it.qty, price: it.price, cost: p ? p.purchasePrice || 0 : 0 };
        }),
        subtotal: order.total, discount: 0, total: order.total, mode: 'cash', received: order.total,
        customerId: null, downPayment: 0, remainingDebt: 0, onlineOrderId: order.id
      });
    }
  } else if (prev === 'تم التسليم') {
    st.sales = st.sales.filter(s => s.onlineOrderId !== order.id);
  }

  order.status = status;
  shop.version = nextVersion(shop.version);
  persist();
  res.json({ ok: true, order });
});

/* ---------------- واجهات عامة للمتجر ---------------- */
app.get('/api/store/:shop', (req, res) => {
  const id = getShop(req, res); if (!id) return;
  const st = shops[id] && shops[id].state;
  if (!st) return res.json({ ok: true, shopName: '', currency: 'دج', products: [] });
  res.json({
    ok: true,
    shopName: st.settings.shopName || '',
    currency: st.settings.currency || 'دج',
    products: st.products
      .filter(p => p.sellPrice > 0)
      .map(p => ({ id: p.id, name: p.name, category: p.category || '', sellPrice: p.sellPrice, quantity: p.quantity, unit: p.unit || '' }))
  });
});

const hits = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  if (arr.length >= 8) { hits.set(ip, arr); return true; }
  arr.push(now); hits.set(ip, arr); return false;
}
setInterval(() => { const now = Date.now(); for (const [ip, a] of hits) if (!a.some(t => now - t < 600000)) hits.delete(ip); }, 600000).unref();

app.post('/api/order/:shop', (req, res) => {
  const id = getShop(req, res); if (!id) return;
  if (rateLimited(req.ip)) return res.status(429).json({ ok: false, error: 'طلبات كثيرة، حاول لاحقًا' });
  const shop = shops[id];
  if (!shop || !shop.state) return res.status(404).json({ ok: false, error: 'المتجر غير جاهز بعد' });

  const b = req.body || {};
  const customerName = cleanStr(b.customerName, 80);
  const phone = cleanStr(b.phone, 25);
  if (!customerName || !/^[+\d][\d\s-]{5,24}$/.test(phone)) return res.status(400).json({ ok: false, error: 'الاسم أو رقم الهاتف غير صحيح' });
  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 60) return res.status(400).json({ ok: false, error: 'السلة غير صالحة' });

  const st = shop.state;
  const wanted = new Map();
  for (const it of b.items) {
    const qty = Number(it && it.qty);
    if (!it || typeof it.productId !== 'string' || !Number.isFinite(qty) || qty <= 0 || qty > 1000) return res.status(400).json({ ok: false, error: 'سلة غير صالحة' });
    wanted.set(it.productId, (wanted.get(it.productId) || 0) + qty);
  }
  const lines = [];
  for (const [pid, qty] of wanted) {
    const p = st.products.find(x => x.id === pid);
    if (!p || !(p.sellPrice > 0)) return res.status(400).json({ ok: false, error: 'منتج غير موجود' });
    if (p.quantity < qty) return res.status(409).json({ ok: false, error: 'الكمية غير متوفرة: ' + p.name });
    lines.push({ p, qty });
  }
  lines.forEach(({ p, qty }) => { p.quantity -= qty; });                       // السعر والكمية دائمًا من الخادم لا من الزبون
  const order = {
    id: uid('ord'), createdAt: Date.now(),
    customerName, phone, address: cleanStr(b.address, 200), notes: cleanStr(b.notes, 500),
    items: lines.map(({ p, qty }) => ({ productId: p.id, name: p.name, qty, price: p.sellPrice })),
    total: lines.reduce((s, { p, qty }) => s + p.sellPrice * qty, 0),
    status: 'قيد الانتظار', source: 'online'
  };
  st.onlineOrders = st.onlineOrders || [];
  st.onlineOrders.push(order);
  shop.version = nextVersion(shop.version);
  persist();
  res.json({ ok: true, order: { id: order.id } });
});

app.listen(PORT, () => {
  console.log('الخادم يعمل على المنفذ ' + PORT);
  if (!SYNC_KEY) console.warn('تنبيه: المتغير SYNC_KEY غير مضبوط — الكاشير وصفحة الطلبات لن يعملا حتى تضيفه.');
});
