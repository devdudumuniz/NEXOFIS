import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAX_INVESTIGATION_PACKAGE_BYTES,
  VERIFICATION_DISCLAIMER,
  verifyInvestigationPackage,
  type VerificationResult,
} from "../src/server/investigationVerifier";

/** Bounded reads even if a file grows between stat and read. */
function readBounded(file: string, maxBytes: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("Arquivo ausente, não regular ou acima do limite.");
    const target = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let length = 0;
    while (length < target.length) {
      const received = fs.readSync(
        fd,
        target,
        length,
        target.length - length,
        null,
      );
      if (!received) break;
      length += received;
    }
    if (length > maxBytes || length > stat.size)
      throw new Error("Arquivo excedeu o limite ou mudou durante a leitura.");
    return target.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}

export function runInvestigationVerificationCli(
  args: string[],
): VerificationResult {
  try {
    if (args.length < 1 || args.length > 2)
      throw new Error(
        "Uso: npx tsx scripts/verify-investigation.ts pacote.json [diretorio-originais]",
      );
    const bytes = readBounded(
      path.resolve(args[0]),
      MAX_INVESTIGATION_PACKAGE_BYTES,
    );
    const pkg: unknown = JSON.parse(bytes.toString("utf8"));
    let readArtifact: ((sha: string) => Buffer | null) | undefined;
    if (args[1]) {
      const root = fs.realpathSync(path.resolve(args[1]));
      if (!fs.statSync(root).isDirectory())
        throw new Error("O diretório de originais informado não é válido.");
      readArtifact = (sha) => {
        if (!/^[a-f0-9]{64}$/.test(sha)) return null;
        for (const relative of [
          `${sha}.bin`,
          path.join(sha.slice(0, 2), `${sha}.bin`),
        ]) {
          const candidate = path.join(root, relative);
          if (!fs.existsSync(candidate)) continue;
          const actual = fs.realpathSync(candidate);
          const relativeActual = path.relative(root, actual);
          if (
            relativeActual.startsWith(`..${path.sep}`) ||
            relativeActual === ".." ||
            path.isAbsolute(relativeActual) ||
            fs.lstatSync(candidate).isSymbolicLink()
          )
            throw new Error(
              "Referência de arquivo fora do diretório autorizado.",
            );
          return readBounded(actual, 1024 * 1024);
        }
        return null;
      };
    }
    return verifyInvestigationPackage(pkg, readArtifact);
  } catch (err) {
    return {
      exitCode: 1,
      errors: [
        err instanceof SyntaxError
          ? "Arquivo não contém JSON válido."
          : err instanceof Error
            ? err.message.replace(
                /(?:[A-Za-z]:)?[\\/][^\n']+/g,
                "[caminho local]",
              )
            : "Falha de leitura do pacote.",
      ],
      warnings: [],
      checks: {
        packageHashVerified: false,
        eventChainVerified: false,
        reportReplayed: false,
        expectedOriginalCount: 0,
        verifiedOriginalCount: 0,
      },
      disclaimer: VERIFICATION_DISCLAIMER,
    };
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const result = runInvestigationVerificationCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.exitCode;
}
