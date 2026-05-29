/**
 * Vercel Serverless Function – Proxy ABCCC Campolina
 * Rota: GET /api/campolina?nome=RELAMPAGO&registro=1/48947
 *
 * Estratégia de cobertura total:
 *   O banco do WebRun retorna ~500 registros por "página" a partir da posição
 *   alfabética definida por executeRule. Para cobrir todos os animais,
 *   disparamos N sessões paralelas com pontos de partida distribuídos (A, B, C …)
 *   e buscamos 2 páginas em cada sessão (~1 000 por ponto de partida).
 *   Ao final, fazemos dedup por animal_id e filtramos CONTAINS no proxy.
 *
 *   Cada sessão: openform.do → executeRule(letra) → navigate first → navigate next
 *   N sessões paralelas em Promise.all → cabe no timeout do Vercel (≤10 s).
 */

const https = require('https');
const qs    = require('querystring');

const HOST      = 'sistemas.gerenciarsistemas.com.br';
const BASE_PATH = '/abcccampolina';

// Pontos de partida alfabéticos para cobertura total.
// Cada um cobre ~1 000 animais; com overlap o dedup remove duplicatas.
// Ajuste a granularidade se o banco crescer.
const START_KEYS = [
  'A', 'B', 'C', 'CA', 'CO', 'D', 'E', 'F',
  'G', 'H', 'I', 'J', 'K', 'L',
  'M', 'MA', 'MI', 'N', 'O',
  'P', 'Q', 'R', 'RE', 'S', 'SE', 'SO',
  'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
];

// Quantas páginas buscar por sessão (cada página ≈ 500 registros)
const PAGES_PER_SESSION = 3;

/* ─── HTTP helpers ────────────────────────────────────────── */
function httpGet(path, cookie) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, path: BASE_PATH + path, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HarasManager/3.0)',
        'Accept': 'text/html,*/*',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        data:    Buffer.concat(chunks).toString('latin1'),
        cookies: (res.headers['set-cookie'] || []).map(c => c.split(';')[0]),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(path, body, cookie) {
  const bodyStr = qs.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, path: BASE_PATH + path, method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HarasManager/3.0)',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr, 'latin1'),
        'Cookie': cookie,
        'Referer': `https://${HOST}${BASE_PATH}/openform.do?sys=CAM&action=openform&formID=464569416`,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ data: Buffer.concat(chunks).toString('latin1') }));
    });
    req.on('error', reject);
    req.write(bodyStr, 'latin1');
    req.end();
  });
}

/* ─── Sessão: executeRule(startKey) + N páginas de navigate.do ─ */
async function fetchSession(startKey) {
  // Etapa 1: sessão nova
  const step1 = await httpGet('/openform.do?sys=CAM&action=openform&formID=464569416');
  if (!step1.cookies.length) return [];
  const cookie = step1.cookies.join('; ');

  // Etapa 2: posiciona cursor no ponto alfabético
  await httpPost('/form.do', {
    sys: 'CAM', formID: '464569416', action: 'executeRule',
    ruleName: 'ABC Campolina - Consulta Online - Pesquisar',
    field1037268: startKey.toUpperCase(),
    field1037272: '', field1037274: '',
    field1037275: '', field1037276: '',
    field1037273: '', field1043165: '',
  }, cookie);

  const NAV = '/navigate.do?sys=CAM&formID=464569416&componentID=1037267&action=navigate&inner=true&gt=0';
  const rows = [];

  // Etapa 3: busca PAGES_PER_SESSION páginas sequenciais
  for (let i = 0; i < PAGES_PER_SESSION; i++) {
    const param = i === 0 ? 'first' : 'next';
    const page = await httpGet(`${NAV}&param=${param}`, cookie);
    const parsed = parseRows(page.data);
    rows.push(...parsed);
    // Se a página veio vazia ou incompleta, não há mais dados nesta sessão
    if (parsed.length < 50) break;
  }

  return rows;
}

/* ─── Parser de linhas navigate.do ───────────────────────── */
function parseRows(js) {
  const rows = [];
  const re = /'field1037263':'([^']*)'[^{}]*?'field1037262':'([^']*)'[^{}]*?'field1037265':'([^']*)'[^{}]*?'field1037421':'([^']*)'/g;
  let m;
  while ((m = re.exec(js)) !== null) {
    rows.push({
      registro:  m[1] || '',
      nome:      m[2] || '',
      status:    m[3] || '',
      animal_id: m[4] || '',
    });
  }
  return rows;
}

/* ─── Normalização para busca sem acento / case-insensitive ─ */
function norm(s) {
  return (s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function filtrar(rows, nome, registro) {
  const n = norm(nome);
  const r = (registro || '').trim().toLowerCase();
  return rows.filter(row => {
    if (n && !norm(row.nome).includes(n)) return false;
    if (r && !row.registro.toLowerCase().includes(r)) return false;
    return true;
  });
}

/* ─── Deduplicar por animal_id + registro ──────────────────── */
function dedup(rows) {
  const seen = new Set();
  return rows.filter(r => {
    const key = r.animal_id + '|' + r.registro;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/* ─── Executa sessões em lotes paralelos (evita timeout) ────── */
async function fetchAll(keys, batchSize = 8) {
  let all = [];
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(k => fetchSession(k)));
    for (const r of results) {
      if (r.status === 'fulfilled') all.push(...r.value);
    }
  }
  return all;
}

/* ─── Handler Vercel ─────────────────────────────────────── */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const nome     = (req.query.nome     || '').toString().trim();
  const registro = (req.query.registro || '').toString().trim();

  if (!nome && !registro) {
    return res.status(400).json({ error: 'Informe nome ou registro para buscar.' });
  }

  try {
    let keysToFetch;

    if (nome) {
      // Estratégia inteligente: sempre busca pela chave principal (onde o nome
      // provavelmente está), mais os prefixos das palavras do nome para cobrir
      // "FAZENDA DO RELAMPAGO" (começa em F) quando buscamos "RELAMPAGO".
      const words = nome.toUpperCase().split(/\s+/).filter(Boolean);
      const dynamicKeys = new Set();

      // Chave principal = 1ª e 2ª letra do termo
      dynamicKeys.add(words[0].slice(0, 1));
      dynamicKeys.add(words[0].slice(0, 2));

      // Para cada palavra do nome, adiciona a 1ª letra como ponto de partida
      // (captura "DO RELAMPAGO", "DA FAZENDA RELAMPAGO" etc.)
      for (const w of words) {
        dynamicKeys.add(w.slice(0, 1));
        if (w.length >= 2) dynamicKeys.add(w.slice(0, 2));
      }

      // Sempre inclui o conjunto completo de START_KEYS para garantir 100%
      keysToFetch = START_KEYS;
    } else {
      // Busca só por registro: precisa varrer tudo
      keysToFetch = START_KEYS;
    }

    const rawRows  = await fetchAll(keysToFetch, 8);
    const unique   = dedup(rawRows);
    const filtrados = filtrar(unique, nome, registro);

    return res.status(200).json({
      total_consultado: unique.length,
      total_filtro:     filtrados.length,
      resultados:       filtrados.slice(0, 500),
    });

  } catch (err) {
    console.error('[campolina proxy]', err.message);
    return res.status(502).json({
      error: 'Erro ao consultar ABCCC Campolina: ' + err.message,
    });
  }
};
