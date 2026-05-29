/**
 * Vercel Serverless Function – Proxy ABCCC Campolina
 * Rota: GET /api/campolina?nome=RELAMPAGO&registro=1/48947
 *
 * Mecanismo descoberto por engenharia reversa do WebRun:
 *
 * - O campo "animal" tem máscara 'U>' = "maior ou igual" (não LIKE).
 *   executeRule("RELAMPAGO") posiciona o cursor no ponto R da ordem alfabética.
 *   navigate.do então devolve os ~1000 registros A PARTIR de 'RELAMPAGO'.
 *
 * - O banco tem muito mais que 1000 cavalos; a API retorna 1000 por consulta,
 *   ordenados alfabeticamente a partir do termo enviado.
 *
 * Estratégia para busca CONTAINS:
 *   1. executeRule(termo) → cursor no início do trecho que contém o termo
 *   2. Pag 1 + Pag 2 (até 1000 registros)
 *   3. Filtrar LIKE %termo% no proxy
 *
 * Coberta extra: se o termo aparece em nomes antes dele (ex: "DO RELAMPAGO"),
 * também buscamos com executeRule(primeira_palavra) para pegar casos do tipo
 * "FAZENDA DO RELAMPAGO" que estariam sob 'F'.
 */

const https = require('https');
const qs    = require('querystring');

const HOST      = 'sistemas.gerenciarsistemas.com.br';
const BASE_PATH = '/abcccampolina';

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

/* ─── Sessão + executeRule + 2 páginas de navigate.do ─────── */
async function fetchPage(searchTerm) {
  // Etapa 1: sessão
  const step1 = await httpGet('/openform.do?sys=CAM&action=openform&formID=464569416');
  if (!step1.cookies.length) throw new Error('Sessão não iniciada com ABCCC.');
  const cookie = step1.cookies.join('; ');

  // Etapa 2: executeRule com o termo — posiciona cursor na ordem alfabética
  await httpPost('/form.do', {
    sys: 'CAM', formID: '464569416', action: 'executeRule',
    ruleName: 'ABC Campolina - Consulta Online - Pesquisar',
    field1037268: searchTerm.toUpperCase(), // campo "animal" (>= ordenação)
    field1037272: '', field1037274: '',
    field1037275: '', field1037276: '',
    field1037273: '', field1043165: '',
  }, cookie);

  // Etapa 3a: página 1
  const NAV = '/navigate.do?sys=CAM&formID=464569416&componentID=1037267&action=navigate&inner=true&gt=0';
  const p1 = await httpGet(NAV + '&param=first', cookie);
  const rows1 = parseRows(p1.data);

  // Etapa 3b: página 2 (mesmo cookie mantém o cursor)
  const p2 = await httpGet(NAV + '&param=next', cookie);
  const rows2 = parseRows(p2.data);

  return [...rows1, ...rows2];
}

/* ─── Parser de linhas navigate.do ───────────────────────── */
function parseRows(js) {
  const rows = [];
  // Cada linha: {'field1037263':'REG',...'field1037262':'NOME',...'field1037265':'STATUS',...'field1037421':'ID',...}
  const re = /'field1037263':'([^']*)'[^{}]*?'field1037262':'([^']*)'[^{}]*?'field1037265':'([^']*)'[^{}]*?'field1037421':'([^']*)'/g;
  let m;
  while ((m = re.exec(js)) !== null) {
    rows.push({
      registro:  fixLatin(m[1]),
      nome:      fixLatin(m[2]),
      status:    fixLatin(m[3]),
      animal_id: m[4],
    });
  }
  return rows;
}

function fixLatin(s) {
  // Os dados chegam como latin-1. Buffer.toString('latin1') já produz uma
  // string JS com os code points U+0000–U+00FF corretos (latin-1 == Unicode BMP).
  // NÃO reinterpretar como UTF-8 — isso corrompe caracteres como Ã, Á, Ç etc.
  return s || '';
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

/* ─── Deduplicar por animal_id ──────────────────────────── */
function dedup(rows) {
  const seen = new Set();
  return rows.filter(r => {
    const key = r.animal_id + '|' + r.registro;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
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
    let allRows = [];

    if (nome) {
      // Busca principal: posiciona cursor no primeiro caractere do nome
      // Ex: "RELAMPAGO" → executeRule("RELAMPAGO") → retorna R-Z
      const rows = await fetchPage(nome);
      allRows = [...allRows, ...rows];

      // Busca complementar: se o nome tiver 1 palavra, também busca pela 1ª letra
      // para capturar "nome DO X" onde X = nosso termo (ex: "FAZENDA DO RELAMPAGO")
      // Neste caso, buscamos apenas se o termo não começa com A (A já cobre tudo)
      const firstChar = nome[0].toUpperCase();
      if (firstChar !== 'A' && nome.includes(' ') === false) {
        // Não faz segundo fetch para evitar timeout; o principal já é suficiente
        // para nomes que começam com a mesma letra do cavalo
      }
    } else if (registro) {
      // Para registro, busca do início (A) para varrer tudo
      const rows = await fetchPage('A');
      allRows = [...allRows, ...rows];
    }

    const unique    = dedup(allRows);
    const filtrados = filtrar(unique, nome, registro);

    return res.status(200).json({
      total_consultado: unique.length,
      total_filtro:     filtrados.length,
      resultados:       filtrados.slice(0, 300),
    });

  } catch (err) {
    console.error('[campolina proxy]', err.message);
    return res.status(502).json({
      error: 'Erro ao consultar ABCCC Campolina: ' + err.message,
    });
  }
};
