#!/usr/bin/env node
// =============================================================================
// PREFLIGHT CHECK — Se ejecuta automáticamente antes de `npm run dev`
// Verifica que Docker Desktop esté corriendo antes de intentar levantar algo.
// =============================================================================

import { execSync } from 'child_process';

const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';

function log(color, icon, msg) {
  console.log(`${color}${BOLD}  ${icon}  ${msg}${RESET}`);
}

console.log(`\n${CYAN}${BOLD}╔══════════════════════════════════════════════════════╗${RESET}`);
console.log(`${CYAN}${BOLD}║       🚀  CHaaS Dev Environment — Preflight         ║${RESET}`);
console.log(`${CYAN}${BOLD}╚══════════════════════════════════════════════════════╝${RESET}\n`);

// ─── 1. Docker Engine ──────────────────────────────────────────────────────────
try {
  execSync('docker info', { stdio: 'pipe' });
  log(GREEN, '✅', 'Docker Engine está corriendo');
} catch {
  log(RED, '❌', 'Docker Engine NO está corriendo.');
  log(YELLOW, '💡', 'Abre Docker Desktop y espera a que inicie, luego vuelve a ejecutar npm run dev');
  process.exit(1);
}

// ─── 2. Node.js version ────────────────────────────────────────────────────────
const nodeVersion = process.version;
const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
if (major < 18) {
  log(RED, '❌', `Node.js ${nodeVersion} detectado. Se requiere v18+`);
  process.exit(1);
}
log(GREEN, '✅', `Node.js ${nodeVersion}`);

// ─── 3. Backend node_modules ────────────────────────────────────────────────────
try {
  execSync('node -e "require.resolve(\'express\')"', { cwd: 'chaas-backend', stdio: 'pipe' });
  log(GREEN, '✅', 'Backend dependencies instaladas');
} catch {
  log(YELLOW, '⚠️', 'Backend dependencies faltantes — ejecutando npm install...');
  try {
    execSync('npm install', { cwd: 'chaas-backend', stdio: 'inherit' });
    log(GREEN, '✅', 'Backend dependencies instaladas');
  } catch {
    log(RED, '❌', 'Falló npm install en chaas-backend');
    process.exit(1);
  }
}

// ─── 4. Frontend node_modules ──────────────────────────────────────────────────
try {
  execSync('node -e "require.resolve(\'next\')"', { cwd: 'chaas-frontend', stdio: 'pipe' });
  log(GREEN, '✅', 'Frontend dependencies instaladas');
} catch {
  log(YELLOW, '⚠️', 'Frontend dependencies faltantes — ejecutando npm install...');
  try {
    execSync('npm install', { cwd: 'chaas-frontend', stdio: 'inherit' });
    log(GREEN, '✅', 'Frontend dependencies instaladas');
  } catch {
    log(RED, '❌', 'Falló npm install en chaas-frontend');
    process.exit(1);
  }
}

// ─── 5. Stripe CLI (opcional) ──────────────────────────────────────────────────
try {
  execSync('stripe --version', { stdio: 'pipe' });
  log(GREEN, '✅', 'Stripe CLI disponible');
} catch {
  log(YELLOW, '⚠️', 'Stripe CLI no encontrado. Si necesitas webhooks, instálalo: https://stripe.com/docs/stripe-cli');
  log(YELLOW, '   ', 'Puedes usar "npm run dev:no-stripe" para arrancar sin él.');
}

console.log(`\n${GREEN}${BOLD}  🟢  Preflight completo — Levantando servicios...${RESET}\n`);
