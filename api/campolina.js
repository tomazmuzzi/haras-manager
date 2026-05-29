/**
 * Vercel Serverless Function – Proxy ABCCC Campolina
 * Rota: GET /api/campolina?nome=CAPAO&registro=1/48947&sexo=MACHO
 *
 * Fluxo de 3 etapas:
 *  1. GET  openform.do  → obtém JSESSIONID
 *  2. POST form.do      → executeRule (define filtros na sessão)
 *  3. GET  navigate.do  → retorna linhas da grade com os dados
 */

const https = require('https');

const HOST     = 'sistemas.gerenciarsistemas.com.br';
const BASE_PATH = '/abcccampolina';

/* ─── HTTP helper ───────────────────────────────────────── */
function httpRequest(options, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const rawBuf = Buffer.concat(chunks);
        // Decodifica como latin-1 para preservar caracteres acentuados
        const data = rawBuf.toString('latin1');
        const cookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]);
        resolve({ data, cookies, status: res.statusCode });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr, 'latin1');
    req.end();
  });
}

/* ─── Extrair cookies de Set-Cookie ────────────────────── */
function joinCookies(arr) {
  return arr.join('; ');
}

/* ─── Parsear linhas do navigate.do ────────────────────── */
function parseRows(js) {
  const rows = [];
  // Cada linha do grid tem 'field1037263':'REG','field1037262':'NOME','field1037265':'STATUS','field1037421':'ID'
  const re = /'field1037263':'([^']*)'[^,{]*(?:,[^,{]*)*?'field1037262':'([^']*)'[^,{]*(?:,[^,{]*)*?'field1037265':'([^']*)'[^,{]*(?:,[^,{]*)*?'field1037421':'([^']*)'/g;
  let m;
  while ((m = re.exec(js)) !== null) {
    rows.push({
      registro:  fixEncoding(m[1]),
      nome:      fixEncoding(m[2]),
      status:    fixEncoding(m[3]),
      animal_id: m[4],
    });
  }
  return rows;
}

/* ─── Corrigir encoding latin-1 → UTF-8 ─────────────────── */
function fixEncoding(s) {
  try {
    // Converte string latin-1 raw para Buffer e reinterpreta como latin1→UTF-8
    return Buffer.from(s, 'latin1').toString('latin1')
      .replace(/�/g, '');
  } catch {
    return s;
  }
}

/* ─── Handler principal ──────────────────────────────────── */
module.exports = async function handler(req, res) {
  // CORS – libera para qualquer origem
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { nome = '', registro = '', sexo = '' } = req.query || {};

  if (!nome.trim() && !registro.trim()) {
    return res.status(400).json({ error: 'Informe nome ou registro para buscar.' });
  }

  try {
    /* ── ETAPA 1: abrir formulário → obter JSESSIONID ── */
    const step1 = await httpRequest({
      hostname: HOST,
      path: `${BASE_PATH}/openform.do?sys=CAM&action=openform&formID=464569416`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HarasManager/1.0)',
        'Accept': 'text/html',
      },
    });

    if (!step1.cookies.length) {
      throw new Error('ABCCC não retornou sessão. Tente novamente em instantes.');
    }

    const cookie = joinCookies(step1.cookies);

    /* ── ETAPA 2: executeRule – aplicar filtros ── */
    const params = new URLSearchParams({
      sys: 'CAM',
      formID: '464569416',
      action: 'executeRule',
      ruleName: 'ABC Campolina - Consulta Online - Pesquisar',
      field1037268: nome.toUpperCase().trim(),   // nome do animal
      field1037272: registro.trim(),              // registro
      field1037274: sexo.toUpperCase().trim(),    // sexo
      field1037275: '',  // mãe
      field1037276: '',  // pai
      field1037273: '',  // criador
      field1043165: '',  // chip
    });
    const body = params.toString();

    await httpRequest({
      hostname: HOST,
      path: `${BASE_PATH}/form.do`,
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HarasManager/1.0)',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body, 'latin1'),
        'Cookie': cookie,
        'Referer': `https://${HOST}${BASE_PATH}/openform.do?sys=CAM&action=openform&formID=464569416`,
      },
    }, body);

    /* ── ETAPA 3: navigate.do – buscar linhas da grade ── */
    const step3 = await httpRequest({
      hostname: HOST,
      path: `${BASE_PATH}/navigate.do?sys=CAM&formID=464569416&componentID=1037267&action=navigate&param=first&inner=true&gt=0`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HarasManager/1.0)',
        'Cookie': cookie,
        'Referer': `https://${HOST}${BASE_PATH}/form.do`,
      },
    });

    const rows = parseRows(step3.data);

    return res.status(200).json({
      total: rows.length,
      resultados: rows.slice(0, 300),
    });

  } catch (err) {
    console.error('[campolina]', err);
    return res.status(502).json({
      error: 'Falha ao consultar ABCCC Campolina: ' + err.message,
    });
  }
};
