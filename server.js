const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'trocaresta';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

const TABLE = 'hellen_quiz_events';

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      step TEXT,
      field TEXT,
      value TEXT,
      payload JSONB,
      origem TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_session ON ${TABLE}(session_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_event_type ON ${TABLE}(event_type);`);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/event', async (req, res) => {
  try {
    const { session_id, event_type, step, field, value, payload, origem } = req.body || {};
    if (!session_id || !event_type) {
      return res.status(400).json({ ok: false, error: 'session_id e event_type sao obrigatorios' });
    }
    await pool.query(
      `INSERT INTO ${TABLE} (session_id, event_type, step, field, value, payload, origem, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        session_id,
        event_type,
        step || null,
        field || null,
        value || null,
        payload ? JSON.stringify(payload) : null,
        origem || null,
        req.headers['user-agent'] || null
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('erro /api/event', err);
    res.status(500).json({ ok: false });
  }
});

// sendBeacon manda como text/plain; aceita o mesmo formato
app.post('/api/event-beacon', express.text({ type: '*/*' }), async (req, res) => {
  try {
    const body = JSON.parse(req.body || '{}');
    const { session_id, event_type, step, field, value, payload, origem } = body;
    if (!session_id || !event_type) return res.status(204).end();
    await pool.query(
      `INSERT INTO ${TABLE} (session_id, event_type, step, field, value, payload, origem, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        session_id,
        event_type,
        step || null,
        field || null,
        value || null,
        payload ? JSON.stringify(payload) : null,
        origem || null,
        req.headers['user-agent'] || null
      ]
    );
    res.status(204).end();
  } catch (err) {
    console.error('erro /api/event-beacon', err);
    res.status(204).end();
  }
});

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

app.get('/api/admin', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send('Acesso negado. Adicione ?key=SEU_ADMIN_KEY na URL.');
  }

  const STEP_ORDER = ['intro','1','2','3','4','5','6','7'];
  const STEP_LABELS = {
    intro: 'Abriu o quiz',
    '1': 'P1 - Gênero',
    '2': 'P2 - Idade',
    '3': 'P3 - Já leu',
    '4': 'P4 - Gênero literário',
    '5': 'P5 - Autora favorita',
    '6': 'P6 - Está na Bienal',
    '7': 'P7 - Dados de contato'
  };

  const totalSessions = await pool.query(
    `SELECT COUNT(DISTINCT session_id) AS n FROM ${TABLE}`
  );
  const totalLeads = await pool.query(
    `SELECT COUNT(*) AS n FROM ${TABLE} WHERE event_type = 'lead'`
  );

  const funnelRows = await pool.query(
    `SELECT step, COUNT(DISTINCT session_id) AS n
     FROM ${TABLE}
     WHERE event_type = 'step_view'
     GROUP BY step`
  );
  const funnelMap = {};
  funnelRows.rows.forEach(r => { funnelMap[r.step] = parseInt(r.n, 10); });

  const answerRows = await pool.query(
    `SELECT field, value, COUNT(*) AS n
     FROM ${TABLE}
     WHERE event_type = 'answer'
     GROUP BY field, value
     ORDER BY field, n DESC`
  );
  const answersByField = {};
  answerRows.rows.forEach(r => {
    if (!answersByField[r.field]) answersByField[r.field] = [];
    answersByField[r.field].push({ value: r.value, n: parseInt(r.n, 10) });
  });

  const leadsRows = await pool.query(
    `SELECT session_id, payload, origem, created_at
     FROM ${TABLE}
     WHERE event_type = 'lead'
     ORDER BY created_at DESC`
  );

  let html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>Admin - Quiz Azul Cobalto</title>
  <style>
    body{font-family:-apple-system,Arial,sans-serif;background:#f7f8fa;color:#141416;padding:32px;max-width:1100px;margin:0 auto;}
    h1{font-size:24px;margin-bottom:4px;}
    h2{font-size:18px;margin:32px 0 12px;border-bottom:1px solid #e5e7eb;padding-bottom:8px;}
    .cards{display:flex;gap:16px;margin:20px 0;}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;flex:1;}
    .card .num{font-size:28px;font-weight:800;}
    .card .label{font-size:13px;color:#6b7280;}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;font-size:13.5px;}
    th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #f0f1f3;}
    th{background:#f7f8fa;font-size:12px;text-transform:uppercase;color:#6b7280;}
    .bar-track{background:#eef1f5;border-radius:6px;height:10px;width:100%;overflow:hidden;}
    .bar-fill{background:linear-gradient(90deg,#2e8b57,#3a6ea5);height:100%;}
    .funnel-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;}
    .funnel-label{width:220px;font-size:13.5px;}
    .funnel-n{width:50px;text-align:right;font-weight:700;font-size:13.5px;}
    .pill{display:inline-block;background:#eef1f5;border-radius:99px;padding:2px 10px;font-size:12px;margin-right:6px;}
  </style></head><body>
  <h1>Quiz Azul Cobalto — Painel</h1>
  <div class="cards">
    <div class="card"><div class="num">${totalSessions.rows[0].n}</div><div class="label">Sessões (visitantes únicos)</div></div>
    <div class="card"><div class="num">${totalLeads.rows[0].n}</div><div class="label">Leads completos (código gerado)</div></div>
    <div class="card"><div class="num">${totalSessions.rows[0].n > 0 ? Math.round((totalLeads.rows[0].n / totalSessions.rows[0].n) * 100) : 0}%</div><div class="label">Taxa de conclusão</div></div>
  </div>

  <h2>Funil por pergunta (onde as pessoas desistem)</h2>`;

  const maxFunnel = Math.max(1, ...STEP_ORDER.map(s => funnelMap[s] || 0));
  STEP_ORDER.forEach(step => {
    const n = funnelMap[step] || 0;
    const pct = Math.round((n / maxFunnel) * 100);
    html += `<div class="funnel-row">
      <div class="funnel-label">${esc(STEP_LABELS[step] || step)}</div>
      <div class="bar-track" style="flex:1"><div class="bar-fill" style="width:${pct}%"></div></div>
      <div class="funnel-n">${n}</div>
    </div>`;
  });

  html += `<h2>Soma geral de respostas por pergunta</h2>`;
  Object.keys(answersByField).forEach(field => {
    html += `<h3 style="font-size:14px;margin:16px 0 6px;">${esc(field)}</h3><div>`;
    answersByField[field].forEach(a => {
      html += `<span class="pill">${esc(a.value)}: <strong>${a.n}</strong></span>`;
    });
    html += `</div>`;
  });

  html += `<h2>Lista de usuários (leads capturados)</h2>
  <table><thead><tr>
    <th>Data</th><th>Nome</th><th>WhatsApp</th><th>E-mail</th><th>Código</th>
    <th>Gênero</th><th>Idade</th><th>Na Bienal?</th><th>Autora fav.</th><th>Origem</th>
  </tr></thead><tbody>`;

  leadsRows.rows.forEach(r => {
    const p = r.payload || {};
    html += `<tr>
      <td>${esc(new Date(r.created_at).toLocaleString('pt-BR'))}</td>
      <td>${esc(p.nome)}</td>
      <td>${esc(p.whatsapp)}</td>
      <td>${esc(p.email)}</td>
      <td>${esc(p.codigo)}</td>
      <td>${esc(p.genero)}</td>
      <td>${esc(p.idade)}</td>
      <td>${esc(p.esta_na_bienal)}</td>
      <td>${esc(p.autora_favorita)}</td>
      <td>${esc(r.origem)}</td>
    </tr>`;
  });

  html += `</tbody></table>
  <p style="margin-top:24px;font-size:12px;color:#9aa0a8;">Atualiza a cada refresh da página. Dados vêm direto do Postgres.</p>
  </body></html>`;

  res.send(html);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log('hellen-quiz rodando na porta ' + PORT));
  })
  .catch(err => {
    console.error('falha ao criar schema', err);
    process.exit(1);
  });
