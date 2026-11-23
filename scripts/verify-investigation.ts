#!/usr/bin/env npx tsx
/**
 * Independent Offline Verifier for NEXOFIS Forensic Investigation Export Packages.
 * Usage:
 *   npx tsx scripts/verify-investigation.ts <pacote.json> [diretorio-originais]
 *
 * Exit codes:
 *   0 = Valid within declared scope (schema, package digest, event chain, reproduction, and all originals match)
 *   1 = Invalid, tampered, malformed, hash mismatch, or deterministic reproduction divergence
 *   2 = Incomplete verification (missing originals directory/files or engine version mismatch)
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  verifyInvestigationPackage,
  INVESTIGATION_ENGINE_VERSION,
} from '../src/lib/forensicInvestigationEngine';
import type { PrivateEvidenceRecord } from '../src/types/investigation';

function printUsage(): void {
  console.error(
    'Uso: npx tsx scripts/verify-investigation.ts <pacote.json> [diretorio-originais]'
  );
}

function resolveOriginalInDir(
  originalsDir: string,
  ev: PrivateEvidenceRecord
): Buffer | null {
  const resolvedBase = path.resolve(originalsDir);
  // Candidate 1: <dir>/<exportFilename>  (i.e. <sha256>__<filename>)
  // Candidate 2: <dir>/<sha256[0..2]>/<sha256> (private_evidence layout)
  // Candidate 3: <dir>/<sha256>
  const cleanSha = ev.sha256.trim().toLowerCase();
  const candidates = [
    path.resolve(resolvedBase, path.basename(ev.exportFilename)),
    path.resolve(resolvedBase, cleanSha.slice(0, 2), cleanSha),
    path.resolve(resolvedBase, cleanSha),
  ];

  for (const candidate of candidates) {
    if (!candidate.startsWith(resolvedBase + path.sep)) {
      continue;
    }
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return fs.readFileSync(candidate);
    }
  }
  return null;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(1);
  }

  const packagePath = path.resolve(args[0]);
  const originalsDir = args[1] ? path.resolve(args[1]) : null;

  if (!fs.existsSync(packagePath)) {
    console.error(`ERRO: Pacote não encontrado em ${packagePath}`);
    process.exit(1);
  }

  let parsedPkg: unknown;
  try {
    const raw = fs.readFileSync(packagePath, 'utf8');
    parsedPkg = JSON.parse(raw);
  } catch (err) {
    console.error(
      `ERRO: Não foi possível ler/interpretar o pacote JSON: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  if (originalsDir && (!fs.existsSync(originalsDir) || !fs.statSync(originalsDir).isDirectory())) {
    console.error(`ERRO: Diretório de originais inválido: ${originalsDir}`);
    process.exit(1);
  }

  const result = verifyInvestigationPackage(parsedPkg, {
    readOriginalBytes: originalsDir
      ? (ev) => resolveOriginalInDir(originalsDir, ev)
      : undefined,
  });

  console.log('=== NEXOFIS — Verificador Independente Offline ===');
  console.log(`Motor verificador : ${INVESTIGATION_ENGINE_VERSION}`);
  console.log(`Pacote analisado  : ${packagePath}`);
  if (originalsDir) {
    console.log(`Originais         : ${originalsDir}`);
  }
  console.log(`Resultado         : ${result.status} (exit ${result.exitCode})`);
  console.log('Verificações      :');
  console.log(`  - Schema válido             : ${result.checks.schemaValid ? 'OK' : 'FALHA'}`);
  console.log(`  - Digest SHA-256 do pacote  : ${result.checks.packageDigestValid ? 'OK' : 'FALHA'}`);
  console.log(`  - Cadeia de eventos         : ${result.checks.eventChainValid ? 'OK' : 'FALHA'}`);
  console.log(`  - Versão do motor compatível: ${result.checks.engineVersionMatches ? 'OK' : 'DIVERGENTE'}`);
  console.log(`  - Reprodução determinística : ${result.checks.reproductionMatches ? 'OK' : 'FALHA'}`);
  console.log(
    `  - Originais privados        : ${result.checks.originalsChecked} conferido(s), ${result.checks.originalsMissing} ausente(s), ${result.checks.originalsMismatched} divergente(s)`
  );

  if (result.warnings.length > 0) {
    console.log('Avisos:');
    for (const w of result.warnings) {
      console.log(`  [AVISO] ${w}`);
    }
  }
  if (result.errors.length > 0) {
    console.error('Erros:');
    for (const e of result.errors) {
      console.error(`  [ERRO] ${e}`);
    }
  }

  process.exit(result.exitCode);
}

main();
