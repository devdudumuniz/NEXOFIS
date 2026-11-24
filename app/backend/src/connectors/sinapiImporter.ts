import crypto from 'node:crypto';
import { parseBrazilianNumber, parseCsvTable } from '@nexofis/shared/lib/csvParser';
import { validateCompetencia } from '@nexofis/shared/lib/competenciaValidator';

export type SinapiItemKind = 'insumo' | 'composicao';
export type SinapiTaxRegime = 'desonerado' | 'nao_desonerado';

export interface SinapiReferenceItem {
  code: string;
  description: string;
  unit: string;
  unitPrice: number;
  kind: SinapiItemKind;
  uf: string;
  competencia: string;
  edition: string;
  taxRegime: SinapiTaxRegime;
  isRectification: boolean;
  rectificationNote?: string;
}

export interface SinapiImportPackage {
  sourceSystem: 'SINAPI/CAIXA — Importação de Arquivo Oficial (CSV/TSV/XLSX exportado)';
  filename: string;
  originalFileSha256: string;
  sizeBytes: number;
  uf: string;
  competencia: string;
  edition: string;
  taxRegime: SinapiTaxRegime;
  isRectification: boolean;
  rectificationNote?: string;
  importedAt: string;
  itemCount: number;
  skippedRows: number;
  items: SinapiReferenceItem[];
  limitations: string[];
}

/**
 * Imports official SINAPI reference files (CSV/TSV exported from Caixa official tables).
 * Preserves original raw file SHA-256, validated competência, UF, edition, tax regime
 * (desonerado/não desonerado), item kind (insumo vs composição), and rectification flags.
 * Uses RFC 4180 CSV parsing to avoid truncating quoted Brazilian decimals (e.g. "75,50").
 * Does NOT invent an external SINAPI API.
 */
export function importSinapiOfficialFile(params: {
  rawBuffer: Buffer | string;
  filename: string;
  uf: string;
  competencia: string;
  edition: string;
  taxRegime: SinapiTaxRegime;
  defaultKind: SinapiItemKind;
  isRectification?: boolean;
  rectificationNote?: string;
  importedAt?: string;
}): SinapiImportPackage {
  const compCheck = validateCompetencia(params.competencia);
  if (!compCheck.valid || !compCheck.normalized) {
    throw new Error(compCheck.reason ?? `Competência SINAPI inválida ("${params.competencia}").`);
  }

  const buf = Buffer.isBuffer(params.rawBuffer)
    ? params.rawBuffer
    : Buffer.from(params.rawBuffer, 'utf8');
  const originalFileSha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const text = buf.toString('utf8');
  const parsedTable = parseCsvTable(text);

  const ufClean = params.uf.trim().toUpperCase().slice(0, 2);
  const normalizedCompetencia = compCheck.normalized;
  const importedAt = params.importedAt ?? new Date().toISOString();

  if (parsedTable.headers.length === 0 || parsedTable.rows.length === 0) {
    return {
      sourceSystem: 'SINAPI/CAIXA — Importação de Arquivo Oficial (CSV/TSV/XLSX exportado)',
      filename: params.filename,
      originalFileSha256,
      sizeBytes: buf.length,
      uf: ufClean,
      competencia: normalizedCompetencia,
      edition: params.edition,
      taxRegime: params.taxRegime,
      isRectification: Boolean(params.isRectification),
      rectificationNote: params.rectificationNote,
      importedAt,
      itemCount: 0,
      skippedRows: 0,
      items: [],
      limitations: [
        'Arquivo SINAPI sem registros válidos para importação.',
        'Referência SINAPI deve ser confrontada respeitando UF, competência, regime tributário e separação insumo vs composição.',
      ],
    };
  }

  const headers = parsedTable.headers.map((h) => h.trim().toLowerCase());
  const findCol = (patterns: string[]) =>
    headers.findIndex((h) => patterns.some((p) => h.includes(p)));

  const idxCode = findCol(['codigo', 'código', 'cod']);
  const idxDesc = findCol(['descricao', 'descrição', 'insumo', 'composicao', 'composição']);
  const idxUnit = findCol(['unidade', 'unid', 'und']);
  const idxPrice = findCol(['preco', 'preço', 'custo', 'mediano', 'valor']);
  const idxKind = findCol(['tipo', 'classificacao', 'categoria']);

  const items: SinapiReferenceItem[] = [];
  let skippedRows = 0;

  for (const cols of parsedTable.rows) {
    const code = (idxCode >= 0 ? cols[idxCode] : cols[0])?.trim() ?? '';
    const description = (idxDesc >= 0 ? cols[idxDesc] : cols[1])?.trim() ?? '';
    const unit = (idxUnit >= 0 ? cols[idxUnit] : cols[2])?.trim() ?? '';
    const priceRaw = (idxPrice >= 0 ? cols[idxPrice] : cols[3])?.trim() ?? '';
    const parsedNum = parseBrazilianNumber(priceRaw);
    const unitPrice = parsedNum !== null && parsedNum > 0 ? parsedNum : null;

    if (!code || !description || !unit || unitPrice === null) {
      skippedRows += 1;
      continue;
    }

    const rawKind = (idxKind >= 0 ? cols[idxKind] : '')?.toLowerCase() ?? '';
    const kind: SinapiItemKind = rawKind.includes('comp')
      ? 'composicao'
      : rawKind.includes('insum')
        ? 'insumo'
        : params.defaultKind;

    items.push({
      code,
      description,
      unit: unit.toUpperCase(),
      unitPrice: Number(unitPrice.toFixed(2)),
      kind,
      uf: ufClean,
      competencia: normalizedCompetencia,
      edition: params.edition,
      taxRegime: params.taxRegime,
      isRectification: Boolean(params.isRectification),
      rectificationNote: params.rectificationNote,
    });
  }

  return {
    sourceSystem: 'SINAPI/CAIXA — Importação de Arquivo Oficial (CSV/TSV/XLSX exportado)',
    filename: params.filename,
    originalFileSha256,
    sizeBytes: buf.length,
    uf: ufClean,
    competencia: normalizedCompetencia,
    edition: params.edition,
    taxRegime: params.taxRegime,
    isRectification: Boolean(params.isRectification),
    rectificationNote: params.rectificationNote,
    importedAt,
    itemCount: items.length,
    skippedRows,
    items,
    limitations: [
      `Tabela SINAPI importada de arquivo oficial (${params.filename}, SHA-256 ${originalFileSha256.slice(0, 12)}…), UF=${ufClean}, competência=${normalizedCompetencia}, edição=${params.edition}, regime=${params.taxRegime}.`,
      'Insumos e composições não devem ser comparados entre si sem ajuste de encargos, BDI, frete e condições de entrega.',
    ],
  };
}
