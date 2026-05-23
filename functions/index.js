const functions = require('firebase-functions');
const admin     = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

exports.buscarCompetidores = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin',  '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const q = ((req.query.q || req.body?.q) || '').trim();
  if (!q) { res.status(400).json({ error: 'El parámetro q es requerido.' }); return; }

  const apiKey = process.env.SERPER_API_KEY || '';
  if (!apiKey) {
    res.json({ resultados: [], total: 0, aviso: 'Serper API key no configurada.' });
    return;
  }

  // Leer sitios activos de Firestore
  let sitios = [];
  try {
    const snap = await db.collection('sitiosBusqueda').where('activo', '==', true).get();
    sitios = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error('Firestore error:', e.message);
  }

  // Preparar keywords para matching por nombre de fuente
  // Serper devuelve links de google.com, no links directos de tienda,
  // así que el matching se hace contra el campo "source" (ej. "Walmart México", "Amazon MX")
  const sitiosConKeyword = sitios
    .map(s => ({ ...s, keyword: s.dominio ? s.dominio.split('.')[0].toLowerCase() : '' }))
    .filter(s => s.keyword);

  const _matchSitio = (itemSource) =>
    sitiosConKeyword.find(s => itemSource.toLowerCase().includes(s.keyword)) || null;

  const resultados = [];

  try {
    const r = await fetch('https://google.serper.dev/shopping', {
      method:  'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ q, gl: 'mx', hl: 'es', num: 20 }),
    });

    if (!r.ok) throw new Error(`Serper ${r.status}`);
    const data = await r.json();

    for (const item of (data.shopping || [])) {
      const itemSource = item.source || '';
      const itemLink   = item.link   || '';

      const sitioMatch = _matchSitio(itemSource);

      // Si hay sitios configurados, solo mostrar los que coincidan con alguno
      if (sitiosConKeyword.length && !sitioMatch) continue;

      const rawPrice = item.price || '';
      const price    = rawPrice
        ? parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || null
        : null;

      resultados.push({
        title:     item.title  || '',
        link:      itemLink,
        image:     item.imageUrl || null,
        price,
        store:     sitioMatch?.nombre || itemSource || 'Tienda',
        storeIcon: sitioMatch?.icono  || _iconPorSource(itemSource),
      });
    }
  } catch (e) {
    console.error('Serper error:', e.message);
    res.status(500).json({ error: 'Error al buscar en Serper: ' + e.message });
    return;
  }

  res.json({ resultados, total: resultados.length });
});

function _iconPorSource(source) {
  const s = (source || '').toLowerCase();
  if (s.includes('liverpool'))   return '🔴';
  if (s.includes('walmart'))     return '🔵';
  if (s.includes('amazon'))      return '📦';
  if (s.includes('mercado'))     return '🏪';
  if (s.includes('coppel'))      return '🟡';
  if (s.includes('elektra'))     return '⚡';
  if (s.includes('costco'))      return '🏭';
  if (s.includes('aurrera'))     return '🟢';
  return '🛒';
}
