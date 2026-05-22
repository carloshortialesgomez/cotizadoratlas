const functions = require('firebase-functions');
const admin     = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

/**
 * buscarCompetidores
 * GET  ?q=<query>
 * Lee sitiosBusqueda activos de Firestore y devuelve tarjetas de producto.
 * Soporta tipo "mercadolibre" (ML Search API) y "google" (Custom Search JSON API).
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

  const resultados = [];
  await Promise.all(sitios.map(async (sitio) => {
    try {
      if (sitio.tipo === 'mercadolibre') {
        await _buscarML(q, sitio, resultados);
      } else if (sitio.tipo === 'google') {
        await _buscarGoogle(q, sitio, resultados);
      }
    } catch (e) {
      console.warn(`[${sitio.nombre}] ${e.message}`);
    }
  }));

  res.json({ resultados, total: resultados.length });
});

async function _buscarML(q, sitio, out) {
  const url = `https://api.mercadolibre.com/sites/MLM/search?q=${encodeURIComponent(q)}&limit=8&sort=relevance`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ML API ${r.status}`);
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

async function _buscarGoogle(q, sitio, out) {
  const cfg    = functions.config().gsearch || {};
  const apiKey = cfg.api_key || '';
  const cx     = cfg.cx     || '';
  if (!apiKey || !cx) {
    console.warn('gsearch.api_key / gsearch.cx no configurados. Omitiendo búsqueda Google para', sitio.nombre);
    return;
  }
  const qFull = sitio.dominio ? `${q} site:${sitio.dominio}` : q;
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(qFull)}&num=6`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Google CSE ${r.status}`);
  const data = await r.json();
  for (const item of (data.items || [])) {
    const image = item.pagemap?.cse_image?.[0]?.src
                || item.pagemap?.metatags?.[0]?.['og:image']
                || null;
    const rawPrice = item.pagemap?.offer?.[0]?.price
                   || item.pagemap?.product?.[0]?.price
                   || null;
    const price = rawPrice
      ? parseFloat(String(rawPrice).replace(/[^0-9.]/g, '')) || null
      : null;
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
