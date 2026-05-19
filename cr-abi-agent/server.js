'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const PORT = Number(process.env.PORT) || 3100;
const DB_PATH = path.join(__dirname, 'data', 'corpus.db');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let searchStmt = null;
let countStmt = null;
if (fs.existsSync(DB_PATH)) {
  const db = new Database(DB_PATH, { readonly: true });
  searchStmt = db.prepare(`
    SELECT a.url, a.title, a.content
    FROM articles_fts
    JOIN articles a ON a.id = articles_fts.rowid
    WHERE articles_fts MATCH ?
    ORDER BY rank
    LIMIT 8
  `);
  countStmt = db.prepare('SELECT COUNT(*) AS n FROM articles');
  console.log(`→ Loaded corpus: ${countStmt.get().n} articles`);
} else {
  console.warn('⚠  No corpus.db yet — run `npm run ingest` first. Chatbot will answer from general knowledge only.');
}

const SYSTEM_PROMPT = `You are a CentralReach ABI (Analytics Business Intelligence) reporting expert. You know every trick and technique for building, customizing, scheduling, and troubleshooting ABI reports inside CentralReach. You answer questions for BCBAs, analysts, and clinical leaders who use CR ABI day-to-day.

When relevant articles from the CentralReach Institute knowledge base are provided in <kb> tags, ground your answer in them and cite the article titles. If the knowledge base doesn't cover a question, say so plainly and offer your best general guidance.

Be specific: name menu paths, filter syntax, parameter types, scheduling steps, dashboard/widget mechanics, and common pitfalls. When you mention a "trick" or shortcut, explain when to use it and when not to.`;

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => c.text || '').join('\n');
  return '';
}

function buildFtsQuery(text) {
  return text
    .replace(/["'()*]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3)
    .slice(0, 12)
    .join(' OR ');
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    corpus: countStmt ? countStmt.get().n : 0,
  });
});

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const query = lastUser ? extractText(lastUser.content) : '';

  let kbBlock = '';
  if (searchStmt && query) {
    const fts = buildFtsQuery(query);
    if (fts) {
      try {
        const rows = searchStmt.all(fts);
        if (rows.length) {
          kbBlock = '\n\n<kb>\n' + rows.map(r =>
            `## ${r.title}\nSource: ${r.url}\n\n${r.content.slice(0, 4000)}`
          ).join('\n\n---\n\n') + '\n</kb>';
        }
      } catch (err) {
        console.warn('FTS search failed:', err.message);
      }
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT + kbBlock,
      messages: messages.map(m => ({ role: m.role, content: extractText(m.content) })),
    });

    stream.on('text', (delta) => {
      res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    });

    await stream.finalMessage();
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('chat error:', err);
    try {
      res.write(`data: ${JSON.stringify({ error: err.message || 'unknown error' })}\n\n`);
      res.end();
    } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`CR-ABI Agent listening on http://localhost:${PORT}`);
});
