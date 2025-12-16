#!/usr/bin/env node
// hytale-name - Hytale Username Checker
// Usage: hytale-name <list.txt> [options]
//        hytale-name --retry [options]

import fs from 'fs';
import path from 'path';
import os from 'os';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CWD = process.cwd();

// ANSI colors
const c = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

// Username constraints
const MIN_LEN = 3;
const MAX_LEN = 10;

function shardArray(arr, n) {
  const out = Array.from({ length: n }, () => []);
  arr.forEach((v, i) => out[i % n].push(v));
  return out;
}

function fmtRate(r) { return r >= 1000 ? `${(r/1000).toFixed(1)}k` : r.toFixed(0); }
function fmtTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms/1000).toFixed(1)}s`;
  return `${Math.floor(ms/60000)}m ${((ms%60000)/1000).toFixed(0)}s`;
}

function parseUsernames(input) {
  // Try to parse as JSON array first
  if (input.trim().startsWith('[') && input.trim().endsWith(']')) {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) {
        return parsed.map(u => String(u).trim()).filter(Boolean);
      }
    } catch (e) {
      // Not valid JSON, continue with other parsing methods
    }
  }
  
  // Check for comma-separated
  if (input.includes(',')) {
    return input.split(',').map(u => u.trim()).filter(Boolean);
  }
  
  // Check for space-separated (multiple spaces or tabs)
  if (input.includes(' ') || input.includes('\t')) {
    return input.split(/[\s\t]+/).map(u => u.trim()).filter(Boolean);
  }
  
  // Single username
  return [input.trim()].filter(Boolean);
}

function parseArgs(args) {
  const r = { list: null, workers: null, conc: null, verbose: null, append: false, retry: false, tag: null, from: null, start: null, sleep: null, local: false, batch: null };
  const nonFlagArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-v' || a === '--verbose') r.verbose = true;
    else if (a === '-a' || a === '--append') r.append = true;
    else if (a === '-r' || a === '--retry') r.retry = true;
    else if (a === '-l' || a === '--local') r.local = true;
    else if (a === '-t' || a === '--tag') r.tag = args[++i];
    else if (a === '-w' || a === '--workers') r.workers = Number(args[++i]);
    else if (a === '-c' || a === '--concurrency') r.conc = Number(args[++i]);
    else if (a === '-b' || a === '--batch') r.batch = Number(args[++i]);
    else if (a === '-f' || a === '--from') r.from = args[++i];
    else if (a === '--start') r.start = Number(args[++i]);
    else if (a === '-s' || a === '--sleep') r.sleep = Number(args[++i]);
    else if (!a.startsWith('-')) nonFlagArgs.push(a);
  }
  // Join all non-flag args (handles space-separated, comma-separated, or array format)
  if (nonFlagArgs.length > 0) {
    r.list = nonFlagArgs.join(' ');
  }
  return r;
}

function printHelp() {
  console.log(`
${c.bold}Hytale Username Checker${c.reset}

${c.bold}Usage:${c.reset}
  hytale-name <list.txt>                    Check usernames from file
  hytale-name <username>                     Check a single username
  hytale-name <user1,user2,...>             Check multiple usernames (comma-separated)
  hytale-name <user1 user2 ...>             Check multiple usernames (space-separated)
  hytale-name ["user1","user2",...]          Check multiple usernames (JSON array)
  hytale-name --retry                        Retry failed usernames from errors.txt
  hytale-name --retry --tag run2             Retry with custom output tag

${c.bold}Options:${c.reset}
  -w, --workers N      Number of workers (default: 8)
  -c, --concurrency N  Concurrent requests per worker (default: 200)
  -v, --verbose        Show detailed output (header, stats, etc.)
  -a, --append         Append to output files
  -r, --retry          Retry usernames from errors.txt (in same dir as wordlist or current dir)
  -l, --local          Output files in same directory as input wordlist
  -t, --tag NAME       Output file prefix (e.g., -t run2 → run2-available.txt)
  -b, --batch N        HTTP batch size - check N usernames per request (default: 1, try 5-10)
  -f, --from NAME      Start from username NAME (skips all before it)
  --start N            Start from line N (1-indexed)
  -s, --sleep SECONDS Delay between requests in seconds (default: 0)

${c.bold}Output:${c.reset}
  available.txt   Available usernames
  taken.txt       Taken usernames  
  errors.txt      Failed checks (username + reason)

${c.bold}Examples:${c.reset}
  hytale-name names.txt                    # Basic run (verbose by default)
  hytale-name coolname                     # Check single username (minimal output)
  hytale-name coolname -v                  # Check single username with verbose output
  hytale-name name,name1,name2           # Check multiple usernames (comma-separated)
  hytale-name name name1 name2            # Check multiple usernames (space-separated)
  hytale-name ["name","name1","name2"]   # Check multiple usernames (JSON array)
  hytale-name name,name1,name2 -v        # Check multiple usernames with verbose output
  hytale-name names.txt -w 4 -c 100        # Custom parallelism
  hytale-name --retry                      # Retry all errors
  hytale-name --retry -w 2 -c 30           # Gentle retry
  hytale-name list.txt -f grape -a         # Resume from "grape"
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  
  // Track resolved usernames in retry mode
  const resolvedUsers = new Set();
  const newErrors = new Map(); // username -> error reason

  // Handle --retry mode
  let inputPath;
  let isRetryMode = args.retry;
  let outputDir = CWD; // Default output directory
  let isSingleUsername = false; // Track if checking a single username
  
  if (isRetryMode) {
    // In retry mode, if a wordlist is provided, use its directory for errors.txt lookup
    if (args.list) {
      // Resolve input path first
      inputPath = path.resolve(args.list);
      
      if (fs.existsSync(inputPath)) {
        outputDir = path.dirname(inputPath);
      }
    }
    
    // Look for errors.txt in the output directory
    const errFilePath = path.join(outputDir, 'errors.txt');
    if (!fs.existsSync(errFilePath)) {
      // Fallback to current directory
      const cwdErrFile = path.join(CWD, 'errors.txt');
      if (fs.existsSync(cwdErrFile)) {
        outputDir = CWD;
      } else {
        console.error(`${c.red}No errors.txt found in ${outputDir} or ${CWD}${c.reset}`);
        process.exit(1);
      }
    }
    
    const errFilePathFinal = path.join(outputDir, 'errors.txt');
    // Extract usernames from errors file (tab-separated: username\treason)
    const errContent = fs.readFileSync(errFilePathFinal, 'utf8');
    const retryUsers = errContent.split(/\r?\n/).map(l => l.split('\t')[0].trim()).filter(Boolean);
    if (retryUsers.length === 0) {
      console.log(`${c.green}No errors to retry!${c.reset}`);
      process.exit(0);
    }
    // Write temp retry list
    inputPath = path.join(outputDir, '.retry-temp.txt');
    fs.writeFileSync(inputPath, retryUsers.join('\n') + '\n');
    console.log(`${c.cyan}Retrying ${retryUsers.length} failed usernames from ${outputDir}...${c.reset}\n`);
  } else if (args.list) {
    // Try to parse as usernames (handles comma, space, or JSON array format)
    const parsedUsernames = parseUsernames(args.list);
    
    // Check if we got multiple usernames or if it's a single username/file
    if (parsedUsernames.length > 1) {
      // Multiple usernames - filter to valid ones
      const validUsernames = parsedUsernames.filter(u => u.length >= MIN_LEN && u.length <= MAX_LEN);
      if (validUsernames.length > 0) {
        // Create a temp file with all usernames
        inputPath = path.join(CWD, '.multi-check-temp.txt');
        fs.writeFileSync(inputPath, validUsernames.join('\n') + '\n');
        outputDir = CWD;
        isSingleUsername = true; // Use minimal output for multiple usernames
      } else {
        console.error(`${c.red}No valid usernames (${MIN_LEN}-${MAX_LEN} chars) found${c.reset}`);
        process.exit(1);
      }
    } else if (parsedUsernames.length === 1) {
      // Single username - check if it's a file or username
      const potentialUsername = parsedUsernames[0];
      const isValidUsername = potentialUsername.length >= MIN_LEN && potentialUsername.length <= MAX_LEN;
      const looksLikeFile = args.list.includes(path.sep) || (args.list.includes('.') && !args.list.match(/^[a-zA-Z0-9_]+\./)) || args.list.length > MAX_LEN;
      
      // If it looks like a valid username and not a file path, treat as single username
      if (isValidUsername && !looksLikeFile && !fs.existsSync(path.resolve(args.list))) {
        // Create a temp file with just this username
        inputPath = path.join(CWD, '.single-check-temp.txt');
        fs.writeFileSync(inputPath, potentialUsername + '\n');
        outputDir = CWD;
        isSingleUsername = true;
      } else {
        // Resolve input path - check if file exists
        const resolvedPath = path.resolve(args.list);
        if (fs.existsSync(resolvedPath)) {
          inputPath = resolvedPath;
          // If --local flag, use input file's directory for output
          if (args.local) {
            outputDir = path.dirname(inputPath);
          }
        } else {
          // File doesn't exist - could be a username or invalid input
          console.error(`${c.red}File not found: ${resolvedPath}${c.reset}`);
          console.error(`${c.dim}Tip: If checking a username, make sure it's 3-10 characters${c.reset}`);
          process.exit(1);
        }
      }
    } else {
      // No usernames parsed - check if it's a file
      const resolvedPath = path.resolve(args.list);
      if (fs.existsSync(resolvedPath)) {
        inputPath = resolvedPath;
        if (args.local) {
          outputDir = path.dirname(inputPath);
        }
      } else {
        console.error(`${c.red}No valid usernames found and file not found: ${resolvedPath}${c.reset}`);
        process.exit(1);
      }
    }
  } else {
    printHelp();
    process.exit(1);
  }

  // inputPath should be set by now - verify it exists
  if (!inputPath || !fs.existsSync(inputPath)) {
    // This shouldn't happen if logic above is correct, but provide helpful error
    if (inputPath) {
      console.error(`${c.red}File not found: ${inputPath}${c.reset}`);
    } else {
      console.error(`${c.red}No input specified${c.reset}`);
    }
    process.exit(1);
  }

  // For single username, default to minimal output unless verbose flag is set
  // For file-based checks, default to verbose output
  const verbose = isSingleUsername ? (args.verbose || false) : (args.verbose !== false);
  const append = args.append || isRetryMode; // Always append on retry
  
  // Output files - use outputDir (either CWD or input file's directory)
  const tag = args.tag ? `${args.tag}-` : '';
  const availFile = path.join(outputDir, `${tag}available.txt`);
  const takenFile = path.join(outputDir, `${tag}taken.txt`);
  const errFile = path.join(outputDir, `${tag}errors.txt`);

  // Parallelism settings
  const cpus = os.cpus().length;
  const workers = args.workers || Math.min(8, cpus);
  const conc = args.conc || 200;

  // Read and filter usernames
  const content = fs.readFileSync(inputPath, 'utf8');
  const raw = [...new Set(content.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
  let usernames = raw.filter(u => u.length >= MIN_LEN && u.length <= MAX_LEN);
  const filtered = raw.length - usernames.length;
  
  // Sort alphabetically (case-insensitive)
  usernames.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  
  const totalBefore = usernames.length;
  let skipped = 0;

  // Handle --start (line number, 1-indexed)
  if (args.start && args.start > 1) {
    skipped = Math.min(args.start - 1, usernames.length);
    usernames = usernames.slice(skipped);
  }

  // Handle --from (username)
  if (args.from) {
    const idx = usernames.findIndex(u => u.toLowerCase() === args.from.toLowerCase());
    if (idx === -1) {
      console.error(`${c.red}Username "${args.from}" not found in list.${c.reset}`);
      process.exit(1);
    }
    skipped += idx;
    usernames = usernames.slice(idx);
  }

  if (usernames.length === 0) {
    console.error(`${c.red}No valid usernames (${MIN_LEN}-${MAX_LEN} chars).${c.reset}`);
    process.exit(1);
  }

  const total = usernames.length;
  
  // Only show header info if verbose mode
  if (verbose) {
    console.log(`${c.bold}${c.cyan}━━━ Hytale Username Checker ━━━${c.reset}`);
    console.log(`${c.dim}Total in file:${c.reset} ${c.bold}${totalBefore.toLocaleString()}${c.reset}${filtered ? ` ${c.dim}(${filtered} filtered)${c.reset}` : ''}`);
    if (skipped > 0) {
      console.log(`${c.dim}Resuming from:${c.reset} ${c.yellow}${args.from || `line ${args.start}`}${c.reset} ${c.dim}(skipped ${skipped.toLocaleString()})${c.reset}`);
    }
    console.log(`${c.dim}To check:${c.reset} ${c.bold}${total.toLocaleString()}${c.reset}`);
    console.log(`${c.dim}Parallel:${c.reset} ${c.bold}${workers}${c.reset} workers × ${conc} = ${c.yellow}~${workers * conc}${c.reset}`);
    if (args.sleep) {
      console.log(`${c.dim}Sleep:${c.reset} ${c.yellow}${args.sleep}s${c.reset} between requests`);
    }
    const outputPath = args.local ? path.relative(CWD, outputDir) : path.relative(CWD, outputDir) || '.';
    console.log(`${c.dim}Output:${c.reset} ${c.bold}${outputPath}/${tag}*.txt${c.reset}${append ? ` ${c.yellow}(append)${c.reset}` : ''}`);
    console.log();
  }

  const shards = shardArray(usernames, workers);
  let checked = 0, avail = 0, taken = 0, errs = 0, lastUser = '';

  const flag = append ? 'a' : 'w';
  const availStream = fs.createWriteStream(availFile, { flags: flag });
  const takenStream = fs.createWriteStream(takenFile, { flags: flag });
  
  // For retry mode, we collect errors in memory instead of streaming
  // For normal mode, stream to file
  let errStream = null;
  if (!isRetryMode) {
    errStream = fs.createWriteStream(errFile, { flags: flag });
  }

  const start = Date.now();

  function processResult(r) {
    checked++;
    lastUser = r.username;
    if (r.available === true) {
      avail++;
      availStream.write(r.username + '\n');
      resolvedUsers.add(r.username); // Track as resolved
      // Always show verbose output (default behavior)
      console.log(`${c.green}✔${c.reset} ${c.dim}|${c.reset} ${r.username.padEnd(MAX_LEN)} ${c.dim}|${c.reset} ${r.ttc}ms`);
    } else if (r.available === false) {
      taken++;
      takenStream.write(r.username + '\n');
      resolvedUsers.add(r.username); // Track as resolved
      // Always show verbose output (default behavior)
      console.log(`${c.red}✗${c.reset} ${c.dim}|${c.reset} ${r.username.padEnd(MAX_LEN)} ${c.dim}|${c.reset} ${r.ttc}ms`);
    } else {
      errs++;
      if (isRetryMode) {
        // Collect errors in memory for retry mode
        newErrors.set(r.username, r.error || 'Unknown');
      } else {
        // Stream to file for normal mode
        errStream.write(`${r.username}\t${r.error || 'Unknown'}\n`);
      }
      // Always show verbose output (default behavior)
      console.log(`${c.yellow}⚠${c.reset} ${c.dim}|${c.reset} ${r.username.padEnd(MAX_LEN)} ${c.dim}|${c.reset} ${r.ttc}ms ${c.dim}|${c.reset} ${c.yellow}${r.error}${c.reset}`);
    }
  }

  const sleepMs = args.sleep ? args.sleep * 1000 : 0;
  const httpBatchSize = args.batch || 1; // HTTP requests batch size
  const ipcBatchSize = 1; // Always 1 since we're always in verbose mode
  
  const workerPath = path.join(__dirname, 'worker.js');
  const promises = shards.map((shard, idx) => new Promise((resolve, reject) => {
    const w = new Worker(workerPath, { workerData: { usernames: shard, concurrency: conc, workerId: idx, verbose, sleepMs, batchSize: ipcBatchSize, httpBatchSize } });
    w.on('message', msg => {
      if (msg.type === 'result') { processResult(msg); }
      else if (msg.type === 'batch') { msg.results.forEach(processResult); }
    });
    w.on('error', reject);
    w.on('exit', code => code === 0 ? resolve() : reject(new Error(`Worker ${idx} exit ${code}`)));
  }));

  process.on('SIGINT', () => {
    availStream.end();
    takenStream.end();
    if (errStream) errStream.end();
    console.log(`\n\n${c.yellow}━━━ Interrupted ━━━${c.reset}`);
    console.log(`${c.dim}Progress:${c.reset} ${checked}/${total}`);
    console.log(`${c.dim}Last:${c.reset} ${lastUser}`);
    process.exit(0);
  });

  await Promise.all(promises);
  availStream.end();
  takenStream.end();
  if (errStream) errStream.end();

  // Clean up temp files
  try { fs.unlinkSync(path.join(outputDir, '.retry-temp.txt')); } catch {}
  try { fs.unlinkSync(path.join(CWD, '.single-check-temp.txt')); } catch {}
  try { fs.unlinkSync(path.join(CWD, '.multi-check-temp.txt')); } catch {}

  // In retry mode, rewrite errors.txt with only unresolved usernames
  if (isRetryMode) {
    // Read original errors, filter out resolved ones, keep only still-failing
    const originalErrFile = path.join(outputDir, 'errors.txt');
    const originalErrors = fs.existsSync(originalErrFile) 
      ? fs.readFileSync(originalErrFile, 'utf8').split(/\r?\n/).filter(Boolean)
      : [];
    
    // Build new error list: original errors minus resolved, plus new errors
    const finalErrors = [];
    
    for (const line of originalErrors) {
      const username = line.split('\t')[0].trim();
      if (!resolvedUsers.has(username) && !newErrors.has(username)) {
        // Keep original error if not resolved and not re-tried
        finalErrors.push(line);
      }
    }
    
    // Add new errors from this run
    for (const [username, reason] of newErrors) {
      finalErrors.push(`${username}\t${reason}`);
    }
    
    // Rewrite errors.txt in the same directory
    fs.writeFileSync(originalErrFile, finalErrors.join('\n') + (finalErrors.length ? '\n' : ''));
    
    const cleared = resolvedUsers.size;
    if (cleared > 0) {
      console.log(`\n${c.green}✓ Cleared ${cleared} resolved usernames from errors.txt${c.reset}`);
    }
  }

  const ms = Date.now() - start;

  // Only show summary if verbose mode
  if (verbose) {
    console.log(`\n\n${c.bold}${c.green}━━━ Complete ━━━${c.reset}`);
    console.log(`${c.dim}Time:${c.reset} ${c.bold}${fmtTime(ms)}${c.reset} (${fmtRate((total/ms)*1000)}/s)`);
    console.log(`${c.green}Available:${c.reset} ${c.bold}${avail}${c.reset}`);
    console.log(`${c.red}Taken:${c.reset} ${c.bold}${taken}${c.reset}`);
    
    // Show remaining errors
    if (isRetryMode) {
      const remaining = newErrors.size;
      if (remaining > 0) {
        console.log(`${c.yellow}Still failing:${c.reset} ${c.bold}${remaining}${c.reset} → run ${c.cyan}hytale-name --retry${c.reset} again`);
      } else {
        console.log(`${c.green}All errors resolved!${c.reset} 🎉`);
      }
    } else if (errs > 0) {
      console.log(`${c.yellow}Errors:${c.reset} ${c.bold}${errs}${c.reset} → run ${c.cyan}hytale-name --retry${c.reset}`);
    }
  }
}

main().catch(e => { console.error(`${c.red}Fatal: ${e.message}${c.reset}`); process.exit(1); });

