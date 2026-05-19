'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const TurndownService = require('turndown');
require('dotenv').config();

const LOGIN_URL = process.env.CR_LOGIN_URL || 'https://community.centralreach.com/';
const LIBRARY_URL = process.env.CR_LIBRARY_URL || 'https://community.centralreach.com/';
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'corpus.db');
const ARTICLES_DIR = path.join(DATA_DIR, 'articles');

const USERNAME = process.env.CR_USERNAME;
const PASSWORD = process.env.CR_PASSWORD;
const HEADLESS = process.env.HEADLESS !== 'false';

if (!USERNAME || !PASSWORD) {
  console.error('Missing CR_USERNAME or CR_PASSWORD in .env');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ARTICLES_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE NOT NULL,
    title TEXT,
    content TEXT,
    fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
    title, content, content='articles', content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
    INSERT INTO articles_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
    INSERT INTO articles_fts(articles_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
    INSERT INTO articles_fts(articles_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
    INSERT INTO articles_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
  END;
`);

const upsertArticle = db.prepare(`
  INSERT INTO articles (url, title, content) VALUES (?, ?, ?)
  ON CONFLICT(url) DO UPDATE SET title=excluded.title, content=excluded.content, fetched_at=CURRENT_TIMESTAMP
`);

async function firstExisting(page, selectors) {
  for (const sel of selectors) {
    if (await page.locator(sel).count() > 0) return sel;
  }
  return null;
}

async function login(page) {
  console.log('→ Navigating to login...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  const emailSel = await firstExisting(page, [
    'input[name="email"]',
    'input[name="user[email]"]',
    'input[type="email"]',
    '#email',
    'input[name="login"]',
  ]);
  const passSel = await firstExisting(page, [
    'input[name="password"]',
    'input[name="user[password]"]',
    'input[type="password"]',
    '#password',
  ]);

  if (!emailSel || !passSel) {
    throw new Error('Could not locate email/password fields. Re-run with HEADLESS=false and inspect the DOM, then update selectors in ingest.js.');
  }

  await page.fill(emailSel, USERNAME);
  await page.fill(passSel, PASSWORD);

  const submitSel = await firstExisting(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
  ]);
  if (!submitSel) throw new Error('Could not find submit button.');

  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.click(submitSel),
  ]);

  if (/sign_in/i.test(page.url())) {
    throw new Error(`Still on sign-in page after submit (URL: ${page.url()}). Check credentials or selectors.`);
  }
  console.log(`→ Logged in. Landed on ${page.url()}`);
}

async function discoverLinks(page) {
  console.log('→ Discovering article links...');
  await page.goto(LIBRARY_URL, { waitUntil: 'networkidle' });

  const collected = new Set();

  const harvest = async () => {
    const urls = await page.evaluate((origin) => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors
        .map(a => a.href)
        .filter(href =>
          href.startsWith(origin) &&
          !/sign_in|sign_out|logout|password/i.test(href)
        );
    }, new URL(LIBRARY_URL).origin);
    urls.forEach(u => collected.add(u));
  };

  await harvest();

  const seenPages = new Set([page.url()]);
  const queue = Array.from(collected).filter(u =>
    /\/(community|topic|discussion|kb|knowledge|article|forum|category|library|courses|modules|lessons|catalog)/i.test(u)
  );

  while (queue.length && seenPages.size < 200) {
    const next = queue.shift();
    if (seenPages.has(next)) continue;
    seenPages.add(next);
    try {
      await page.goto(next, { waitUntil: 'networkidle', timeout: 30000 });
      await harvest();
    } catch (err) {
      console.log(`  ! could not crawl ${next}: ${err.message}`);
    }
  }

  return Array.from(collected);
}

function slugify(url) {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .slice(0, 180);
}

async function extractArticle(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  const title = (await page.title()).trim();
  const html = await page.evaluate(() => {
    const candidates = [
      document.querySelector('main'),
      document.querySelector('article'),
      document.querySelector('[role="main"]'),
      document.querySelector('.lesson-content, .course-content, .article-body, .content'),
      document.body,
    ];
    const el = candidates.find(c => c && c.innerText && c.innerText.trim().length > 200) || document.body;
    return el ? el.innerHTML : '';
  });
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const markdown = turndown.turndown(html).trim();
  return { title, markdown };
}

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await login(page);
    const urls = await discoverLinks(page);
    console.log(`→ Found ${urls.length} candidate URLs`);

    let ok = 0, skip = 0, fail = 0;
    for (const url of urls) {
      try {
        const { title, markdown } = await extractArticle(page, url);
        if (!markdown || markdown.length < 200) {
          skip++;
          continue;
        }
        upsertArticle.run(url, title, markdown);
        const slug = slugify(url);
        fs.writeFileSync(path.join(ARTICLES_DIR, `${slug}.md`), `# ${title}\n\n<${url}>\n\n${markdown}\n`);
        ok++;
        console.log(`  ✓ ${title.slice(0, 70)}`);
      } catch (err) {
        fail++;
        console.log(`  ✗ ${url}: ${err.message}`);
      }
    }
    console.log(`\nDone. ok=${ok} skipped=${skip} failed=${fail}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
