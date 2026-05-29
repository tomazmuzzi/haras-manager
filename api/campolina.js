/**
 * Vercel Serverless Function – Proxy para ABCCC Campolina
 * Endpoint: GET /api/campolina?nome=CAPAO&registro=1/48947&sexo=MACHO
 *
 * Fluxo:
 *  1. GET openform.do  → obtém JSESSIONID
 *  2. POST form.do     → executeRule (aplica filtros)
 *  3. GET navigate.do  → retorna linhas da grade
 */

const https = require('https');
const querystring = require('querystring');

const BASE = 'sistemas.gerenciarsistemas.com.br';
const PATH_BASE = '/abcccampolina';

function request(options, postBody) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      // collect Set-Cookie
      const cookies = res.headers['set-cookie'] || [];
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ data, cookies, headers: res.headers }));
    });
    req.on('error', reject);
    if (postBody) req.write(postBody);
    req.end();
  });
}

function parseCookies(cookieArr) {
  return cookieArr.map(c => c.split(';')[0]).join('; ');
}

function parseRows(js) {
  // Extract rows: 'field1037263':'REGISTRO','field1037262':'NOME','field1037265':'STATUS','field1037421':'ID'
  const rows = [];
  // Match individual row objects in data_1037267 = [...]
  const rowRegex = /'field1037263':'([^']*)'[^}]*'field1037262':'([^']*)'[^}]*'field1037265':'([^']*)'[^}]*'field1037421':'([^']*)'/g;
  let m;
  while ((m = rowRegex.exec(js)) !== null) {
    rows.push({
      registro:    decodeWinLatin(m[1]),
      nome:        decodeWinLatin(m[2]),
      status:      decodeWinLatin(m[3]),
      animal_id:   m[4],
    });
  }
  return rows;
}

// Fix Windows-1252 / ISO-8859-1 mojibake that survives charset conversion
function decodeWinLatin(s) {
  return s
    .replace(/Ã©/g, 'é').replace(/Ã£/g, 'ã')
    .replace(/Ãµ/g, 'õ').replace(/Ã /g, 'à')
    .replace(/Ã¢/g, 'â').replace(/Ãª/g, 'ê')
    .replace(/Ã´/g, 'ô').replace(/Ãº/g, 'ú')
    .replace(/Ã­/g, 'í').replace(/Ã§/g, 'ç')
    .replace(/�/g, '')
    || s;
}

module.exports = async (req, res) => {
  // CORS – permite chamadas do GitHub Pages e do Vercel
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const nome     = (req.query.nome     || '').toString().toUpperCase().trim();
  const registro = (req.query.registro || '').toString().trim();
  const sexo     = (req.query.sexo     || '').toString().toUpperCase().trim();

  if (!nome && !registro) {
    return res.status(400).json({ error: 'Informe pelo menos nome ou registro.' });
  }

  try {
    // ── 1. Abrir formulário → obter JSESSIONID ──────────────────
    const step1 = await request({
      hostname: BASE,
      path: `${PATH_BASE}/openform.do?sys=CAM&action=openform&formID=464569416`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const sessionCookie = parseCookies(step1.cookies);
    if (!sessionCookie) throw new Error('Não foi possível obter sessão do ABCCC.');

    // ── 2. ExecuteRule – aplicar filtros de busca ───────────────
    const body = querystring.stringify({
      sys: 'CAM', formID: '464569416',
      action: 'executeRule',
      ruleName: 'ABC Campolina - Consulta Online - Pesquisar',
      field1037268: nome,
      field1037272: registro,
      field1037274: sexo,
      field1037275: '', field1037276: '', field1037273: '', field1043165: '',
    });

    await request({
      hostname: BASE,
      path: `${PATH_BASE}/form.do`,
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Cookie': sessionCookie,
      },
    }, body);

    // ── 3. navigate.do – buscar linhas da grade ─────────────────
    const step3 = await request({
      hostname: BASE,
      path: `${PATH_BASE}/navigate.do?sys=CAM&formID=464569416&componentID=1037267&action=navigate&param=first&inner=true&gt=0`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Cookie': sessionCookie,
      },
    });

    const rows = parseRows(step3.data);

    return res.status(200).json({
      total: rows.length,
      resultados: rows.slice(0, 200), // máx 200 por chamada
    });

  } catch (err) {
    console.error('[campolina proxy]', err.message);
    return res.status(502).json({ error: 'Erro ao consultar ABCCC: ' + err.message });
  }
};
