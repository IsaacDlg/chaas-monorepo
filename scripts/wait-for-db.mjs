#!/usr/bin/env node
// =============================================================================
// WAIT-FOR-DB — Espera a que PostgreSQL acepte conexiones antes de arrancar
// el backend. Esto evita que Prisma falle por timeout al conectar a la DB.
// =============================================================================

import { execSync } from 'child_process';

const MAX_RETRIES = 30;
const RETRY_INTERVAL_MS = 2000;

const YELLOW = '\x1b[33m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPostgres() {
  console.log(`${YELLOW}${BOLD}  ⏳  Esperando a que PostgreSQL esté listo...${RESET}`);

  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      execSync(
        'docker exec chaas-db pg_isready -U chaas_user -d chaas_db',
        { stdio: 'pipe' }
      );
      console.log(`${GREEN}${BOLD}  ✅  PostgreSQL listo (intento ${i}/${MAX_RETRIES})${RESET}`);
      return;
    } catch {
      if (i < MAX_RETRIES) {
        process.stdout.write(`${YELLOW}  ⏳  Intento ${i}/${MAX_RETRIES} — reintentando en ${RETRY_INTERVAL_MS / 1000}s...\r${RESET}`);
        await sleep(RETRY_INTERVAL_MS);
      }
    }
  }

  console.error(`\n${RED}${BOLD}  ❌  PostgreSQL no respondió después de ${MAX_RETRIES} intentos.${RESET}`);
  console.error(`${RED}  Verifica que Docker Desktop esté corriendo y el contenedor chaas-db exista.${RESET}`);
  process.exit(1);
}

await waitForPostgres();
