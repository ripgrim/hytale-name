// worker.js - With rate limit evasion and HTTP batching

import { workerData, parentPort } from 'worker_threads';
import { Pool } from 'undici';

const { usernames, concurrency, verbose, workerId, sleepMs = 0, batchSize = 50, httpBatchSize = 1 } = workerData;

// Rotating user agents - mix of browsers
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
];

const ACCEPT_LANGS = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9',
  'en-US,en;q=0.9,es;q=0.8',
  'en,en-US;q=0.9',
];

let reqCount = 0;

function getHeaders() {
  reqCount++;
  // Rotate UA every 3 requests
  const ua = USER_AGENTS[(reqCount + workerId) % USER_AGENTS.length];
  const lang = ACCEPT_LANGS[reqCount % ACCEPT_LANGS.length];
  
  return {
    'accept': 'application/json, text/plain, */*',
    'accept-language': lang,
    'user-agent': ua,
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
  };
}

// Use multiple smaller pools to vary connections
const pool = new Pool('https://api.hytl.tools', {
  connections: Math.min(concurrency, 100), // Reduced from 256
  pipelining: 1, // Disable pipelining - looks more like real browser
  keepAliveTimeout: 10000,
  keepAliveMaxTimeout: 30000,
});

function pLimit(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, res, rej } = queue.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return fn => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
}

// Random delay to avoid pattern detection
function randomDelay(min = 10, max = 50) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

// Single username check
async function checkSingle(username) {
  // Custom sleep delay if specified, otherwise small random delay
  if (sleepMs > 0) {
    await new Promise(r => setTimeout(r, sleepMs));
  } else {
    await randomDelay(5, 30);
  }
  
  const { statusCode, body } = await pool.request({
    path: `/check/${encodeURIComponent(username)}`,
    method: 'GET',
    headers: getHeaders(),
    bodyTimeout: 20000,
    headersTimeout: 20000,
  });
  
  const text = await body.text();
  
  if (statusCode === 429) throw new Error('Rate limited');
  if (statusCode >= 500) throw new Error(`Server error (${statusCode})`);
  if (statusCode < 200 || statusCode >= 300) throw new Error(`HTTP ${statusCode}`);
  
  const json = JSON.parse(text);
  if (typeof json.available !== 'boolean') throw new Error('Invalid response');
  return json.available;
}

// Batch check - try POST endpoint first, fallback to parallel GET
async function checkBatch(usernameBatch) {
  if (usernameBatch.length === 1) {
    return [{ username: usernameBatch[0], available: await checkSingle(usernameBatch[0]) }];
  }

  // Try batch POST endpoint first
  try {
    if (sleepMs > 0) {
      await new Promise(r => setTimeout(r, sleepMs));
    } else {
      await randomDelay(5, 30);
    }

    const { statusCode, body } = await pool.request({
      path: '/check/batch',
      method: 'POST',
      headers: {
        ...getHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ usernames: usernameBatch }),
      bodyTimeout: 30000,
      headersTimeout: 20000,
    });

    const text = await body.text();
    
    if (statusCode === 200 || statusCode === 201) {
      const json = JSON.parse(text);
      // Expected format: { results: [{ username: "abc", available: true }, ...] }
      if (Array.isArray(json.results)) {
        return json.results;
      }
      // Alternative format: { "abc": true, "def": false, ... }
      if (typeof json === 'object' && !Array.isArray(json)) {
        return usernameBatch.map(u => ({
          username: u,
          available: json[u] === true || json[u] === false ? json[u] : null
        }));
      }
    }
  } catch (e) {
    // Batch endpoint doesn't exist or failed, fall through to parallel GET
  }

  // Fallback: parallel GET requests
  const results = await Promise.all(
    usernameBatch.map(async (username) => {
      try {
        const available = await checkSingle(username);
        return { username, available };
      } catch (e) {
        return { username, available: null, error: e.message };
      }
    })
  );

  return results;
}

async function withRetry(fn, retries = 5) {
  let err;
  for (let i = 0; i <= retries; i++) {
    try { 
      return { ok: true, val: await fn() }; 
    } catch (e) {
      err = e;
      const isRateLimit = /rate|429/i.test(e.message);
      const isRetryable = /rate|429|5\d\d|timeout|ECONN|ENOTFOUND|EAI_AGAIN|UND_ERR|ETIMEDOUT/i.test(e.message);
      
      if (!isRetryable || i === retries) {
        return { ok: false, err: e.message };
      }
      
      // Longer backoff for rate limits
      const baseDelay = isRateLimit ? 1000 : 300;
      const delay = baseDelay * Math.pow(2, i) + Math.random() * 500;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return { ok: false, err: err?.message || 'Max retries' };
}

const BATCH = verbose ? 1 : batchSize;
let batch = [];

function flush() {
  if (!batch.length) return;
  if (batch.length === 1) parentPort.postMessage({ type: 'result', ...batch[0] });
  else parentPort.postMessage({ type: 'batch', results: batch });
  batch = [];
}

function push(username, available, ttc, error = null) {
  batch.push({ username, available, ttc, error });
  if (batch.length >= BATCH) flush();
}

async function run() {
  const limit = pLimit(concurrency);
  
  // Group usernames into HTTP batches
  const httpBatches = [];
  for (let i = 0; i < usernames.length; i += httpBatchSize) {
    httpBatches.push(usernames.slice(i, i + httpBatchSize));
  }

  await Promise.all(httpBatches.map(batch => limit(async () => {
    const startTime = Date.now();
    const results = await withRetry(() => checkBatch(batch));
    const ttc = Date.now() - startTime;
    
    if (results.ok) {
      // Process batch results
      for (const r of results.val) {
        push(r.username, r.available, Math.floor(ttc / batch.length), r.error || null);
      }
    } else {
      // All failed - mark each username as error
      for (const username of batch) {
        push(username, null, ttc, results.err);
      }
    }
  })));
  
  flush();
  await pool.close();
  process.exit(0);
}

run().catch(() => { pool.close().finally(() => process.exit(1)); });

