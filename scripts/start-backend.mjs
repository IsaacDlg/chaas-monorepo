#!/usr/bin/env node
// =============================================================================
// START-BACKEND — Espera DB, genera Prisma Client, y arranca el backend.
// Se ejecuta siempre desde la raíz del proyecto.
// =============================================================================

import { execSync, spawn } from 'child_process';
import { resolve } from 'path';

const BACKEND_DIR = resolve(process.cwd(), 'chaas-backend');

const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';

function log(color, icon, msg) {
  console.log(`${color}${BOLD}  ${icon}  ${msg}${RESET}`);
}

// ─── 1. Wait for PostgreSQL ─────────────────────────────────────────────────
const MAX_RETRIES = 30;
const RETRY_MS = 2000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForDB() {
  log(YELLOW, '⏳', 'Esperando a que PostgreSQL esté listo...');
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      execSync('docker exec chaas-db pg_isready -U chaas_user -d chaas_db', { stdio: 'pipe' });
      log(GREEN, '✅', `PostgreSQL listo (intento ${i}/${MAX_RETRIES})`);
      return;
    } catch {
      process.stdout.write(`\r${YELLOW}  ⏳  Intento ${i}/${MAX_RETRIES}...${RESET}   `);
      await sleep(RETRY_MS);
    }
  }
  log(RED, '❌', 'PostgreSQL no respondió. Verifica Docker.');
  process.exit(1);
}

// ─── 2. Prisma Generate ─────────────────────────────────────────────────────
function prismaGenerate() {
  log(YELLOW, '🔧', 'Generando Prisma Client...');
  try {
    execSync('npx prisma generate', { cwd: BACKEND_DIR, stdio: 'inherit' });
    log(GREEN, '✅', 'Prisma Client generado');
  } catch {
    log(RED, '❌', 'Prisma generate falló');
    process.exit(1);
  }
}

// ─── 3. Start Backend ───────────────────────────────────────────────────────
function startBackend() {
  log(GREEN, '🚀', 'Arrancando backend (npm run dev)...');
  const child = spawn('npm', ['run', 'dev'], {
    cwd: BACKEND_DIR,
    stdio: 'inherit',
    shell: true,
  });

  child.on('exit', (code) => {
    process.exit(code ?? 1);
  });

  // Forward SIGINT/SIGTERM to child
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

// ─── Run ─────────────────────────────────────────────────────────────────────
await waitForDB();
prismaGenerate();
startBackend();
