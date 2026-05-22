const functions = require('firebase-functions');
const admin     = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

// Cache de token ML en memoria (válido entre invocaciones calientes)
let _mlToken       = null;
let _mlTokenExpiry = 0;

/**
 * buscarCompetidores
 * GET ?q=<query>
 * Lee sitiosBusqueda activos de Firestore y devuelve tarjetas de producto.
 * - tipo "mercadolibre": ML Search API con OAuth app-level (client_credentials)
 * - tipo "google": Google Custom Search JSON API (requiere gsearch config)
 */
exports.buscarCompetidores = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin',  '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const q = ((req.query.q || req.body?.q) || '').trim();
  if (!q) { res.status(400).json({ error: 'El parámetro q es requerido.' }); return; }

  let sitios = [];
  try {
    const snap = await db.collection('sitiosBusqueda').where('activo', '==', true).get();
    sitios = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error('Firestore error:', e.message);
    res.status(500).json({ error: 'Error al leer configuración de sitios.' });
    return;
  }

  if (!sitios.length) {
    res.json({ resultados: [], total: 0, aviso: 'No hay sitios activos configurados.' });
    return;
  }

  // Pre-fetch token de ML si hay credenciales configuradas
  const mlToken = await _getMLToken();

  const resultados = [];
  await Promise.all(sitios.map(async (sitio) => {
    try {
      if (sitio.tipo === 'mercadolibre') {
        await _buscarML(q, sitio, resultados, mlToken);
      } else if (sitio.tipo === 'google') {
        await _buscarGoogle(q, sitio, resultados);
      }
    } catch (e) {
      console.warn(`[${sitio.nombre}] ${e.message}`);
    }
  }));

  res.json({ resultados, total: resultados.length });
});

// ── ML OAuth app-level token (client_credentials) ────────────────────────────
async function _getMLToken() {
  if (_mlToken && Date.now() < _mlTokenExpiry) return _mlToken;

  const cfg          = functions.config().ml || {};
  const clientId     = cfg.client_id     || '';
  const clientSecret = cfg.client_secret || '';
  if (!clientId || !clientSecret) {
    console.warn('ml.client_id / ml.client_secret no configurados. Intentando búsqueda sin auth.');
    return null;
  }

  try {
    const r = await fetch('https://api.mercadolibre.com/oauth/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body:    `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
    });
    if (!r.ok) { console.warn('ML OAuth error:', r.status); return null; }
    const data      = await r.json();
    _mlToken        = data.access_token || null;
    _mlTokenExpiry  = Date.now() + ((data.expires_in || 21600) * 1000) - 60000;
    console.log('ML token obtenido, expira en', data.expires_in, 's');
    return _mlToken;
  } catch (e) {
    console.warn('ML OAuth fetch error:', e.message);
    return null;
  }
}

// ── Búsqueda en Mercado Libre ─────────────────────────────────────────────────
async function _buscarML(q, sitio, out, token) {
  const url     = `https://api.mercadolibre.com/sites/MLM/search?q=${encodeURIComponent(q)}&limit=10&sort=relevance`;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const r       = await fetch(url, { headers });
  if (!r.ok) throw new Error(`ML API ${r.status}${token ? ' (con token)' : ' (sin token)'}`);
  const data = await r.json();
  for (const item of (data.results || [])) {
    out.push({
      title:     item.title,
      link:      item.permalink,
      image:     (item.thumbnail || '').replace(/^http:/, 'https:') || null,
      price:     item.price,
      currency:  item.currency_id || 'MXN',
      store:     sitio.nombre,
      storeIcon: sitio.icono || '🏪',
    });
  }
}

// ── Búsqueda vía Google Custom Search JSON API ────────────────────────────────
async function _buscarGoogle(q, sitio, out) {
  const cfg    = functions.config().gsearch || {};
  const apiKey = cfg.api_key || '';
  const cx     = cfg.cx     || '';
  if (!apiKey || !cx) {
    console.warn(`gsearch no configurado — omitiendo ${sitio.nombre}`);
    return;
  }
  const qFull = sitio.dominio ? `${q} site:${sitio.dominio}` : q;
  const url   = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(qFull)}&num=6`;
  const r     = await fetch(url);
  if (!r.ok) throw new Error(`Google CSE ${r.status}`);
  const data  = await r.json();
  for (const item of (data.items || [])) {
    const image    = item.pagemap?.cse_image?.[0]?.src
                   || item.pagemap?.metatags?.[0]?.['og:image']
                   || null;
    const rawPrice = item.pagemap?.offer?.[0]?.price
                   || item.pagemap?.product?.[0]?.price
                   || null;
    const price    = rawPrice ? parseFloat(String(rawPrice).replace(/[^0-9.]/g, '')) || null : null;
    out.push({
      title:     item.title,
      link:      item.link,
      image,
      price,
      currency:  'MXN',
      store:     sitio.nombre,
      storeIcon: sitio.icono || '🔍',
    });
  }
}
