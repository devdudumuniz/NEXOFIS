#!/usr/bin/env npx tsx
/**
 * Independent Offline Verifier for NEXOFIS Forensic Investigation Export Packages.
 * Usage:
 *   npx tsx scripts/verify-investigation.ts <pacote.json> [diretorio-originais]
 *
 * Exit codes:
 *   0 = Valid within declared scope (schema, package digest, event chain, ledger snapshot binding, reproduction, and all originals match)
 *   1 = Invalid, tampered, malformed, hash mismatch, symlink escape, or deterministic reproduction divergence
 *   2 = Incomplete verification (missing originals directory/files or engine version mismatch)
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  verifyInvestigationPackage,
  INVESTIGATION_ENGINE_VERSION,
  MAX_PRIVATE_EVIDENCE_BYTES,
} from '@nexofis/shared/lib/forensicInvestigationEngine';
import type { PrivateEvidenceRecord } from '@nexofis/shared/types/investigation';

const MAX_PACKAGE_JSON_BYTES = 25 * 1024 * 1024; // 25 MiB hard cap

function printUsage(): void {
  console.error(
    'Uso: npx tsx scripts/verify-investigation.ts <pacote.json> [diretorio-originais]'
  );
}

/**
 * Safely resolves an original private evidence binary inside `originalsDir`,
 * rejecting symlinks escaping the canonical root directory and files exceeding 1 MiB.
 */
export function resolveOriginalInDir(
  originalsDir: string,
  ev: PrivateEvidenceRecord
): Buffer | null {
  const realBase = fs.realpathSync(path.resolve(originalsDir));
  const cleanSha = ev.sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(cleanSha)) {
    throw new Error(`SHA-256 inválido na evidência ${ev.id}: "${ev.sha256}".`);
  }

  // Candidate 1: <dir>/<exportFilename>  (i.e. <sha256>__<filename>)
  // Candidate 2: <dir>/<sha256[0..2]>/<sha256> (private_evidence layout)
  // Candidate 3: <dir>/<sha256>
  const candidates = [
    path.resolve(realBase, path.basename(ev.exportFilename)),
    path.resolve(realBase, cleanSha.slice(0, 2), cleanSha),
    path.resolve(realBase, cleanSha),
  ];

  for (const candidate of candidates) {
    if (!candidate.startsWith(realBase + path.sep)) {
      continue;
    }
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const lstat = fs.lstatSync(candidate);
    const realCandidate = fs.realpathSync(candidate);
    if (!realCandidate.startsWith(realBase + path.sep)) {
      throw new Error(
        `Acesso negado: symlink ou caminho fora do diretório de originais confinado (${path.basename(candidate)}).`
      );
    }
    if (lstat.isSymbolicLink()) {
      throw new Error(
        `Symlink não permitido no diretório de originais: ${path.basename(candidate)}.`
      );
    }
    const stat = fs.statSync(realCandidate);
    if (!stat.isFile()) {
      continue;
    }
    if (stat.size > MAX_PRIVATE_EVIDENCE_BYTES) {
      throw new Error(
        `Original privado excede o limite de ${MAX_PRIVATE_EVIDENCE_BYTES} bytes (${stat.size} bytes): ${ev.exportFilename}.`
      );
    }
    return fs.readFileSync(realCandidate);
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
    const pkgStat = fs.statSync(packagePath);
    if (!pkgStat.isFile()) {
      throw new Error('O caminho informado não é um arquivo regular.');
    }
    if (pkgStat.size > MAX_PACKAGE_JSON_BYTES) {
      throw new Error(
        `Pacote JSON excede o limite seguro de ${Math.round(MAX_PACKAGE_JSON_BYTES / (1024 * 1024))} MiB (${pkgStat.size} bytes).`
      );
    }
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

  let result;
  try {
    result = verifyInvestigationPackage(parsedPkg, {
      readOriginalBytes: originalsDir
        ? (ev) => resolveOriginalInDir(originalsDir, ev)
        : undefined,
    });
  } catch (err) {
    console.error(
      `ERRO DE SEGURANÇA/INTEGRIDADE: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

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
  console.log(
    `  - Vínculo fatos↔livro-razão : ${result.checks.factsDigestMatchesLedger ? 'OK' : 'FALHA'}`
  );
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

// Run CLI only when invoked directly (allows unit testing resolveOriginalInDir safely)
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('verify-investigation.ts')) {
  main();
}
