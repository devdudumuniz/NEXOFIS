import crypto from 'node:crypto';

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

function parsePtBrNumber(raw: string): number | null {
  const cleaned = raw.replace(/^"|"$/g, '').replace(/^R\$\s*/i, '').trim();
  if (!cleaned) return null;
  const normalized =
    cleaned.includes(',') && cleaned.includes('.')
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Imports official SINAPI reference files (CSV/TSV exported from Caixa official tables).
 * Preserves original raw file SHA-256, competência, UF, edition, tax regime (desonerado/não desonerado),
 * item kind (insumo vs composição), and rectification flags. Does NOT invent an external SINAPI API.
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
  const buf = Buffer.isBuffer(params.rawBuffer)
    ? params.rawBuffer
    : Buffer.from(params.rawBuffer, 'utf8');
  const originalFileSha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const ufClean = params.uf.trim().toUpperCase().slice(0, 2);
  const importedAt = params.importedAt ?? new Date().toISOString();

  if (lines.length < 2) {
    return {
      sourceSystem: 'SINAPI/CAIXA — Importação de Arquivo Oficial (CSV/TSV/XLSX exportado)',
      filename: params.filename,
      originalFileSha256,
      sizeBytes: buf.length,
      uf: ufClean,
      competencia: params.competencia,
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

  const delimiter = lines[0].includes(';') ? ';' : lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0]
    .split(delimiter)
    .map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());

  const findCol = (patterns: string[]) =>
    headers.findIndex((h) => patterns.some((p) => h.includes(p)));

  const idxCode = findCol(['codigo', 'código', 'cod']);
  const idxDesc = findCol(['descricao', 'descrição', 'insumo', 'composicao', 'composição']);
  const idxUnit = findCol(['unidade', 'unid', 'und']);
  const idxPrice = findCol(['preco', 'preço', 'custo', 'mediano', 'valor']);
  const idxKind = findCol(['tipo', 'classificacao', 'categoria']);

  const items: SinapiReferenceItem[] = [];
  let skippedRows = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delimiter).map((c) => c.replace(/^"|"$/g, '').trim());
    const code = (idxCode >= 0 ? cols[idxCode] : cols[0]) ?? '';
    const description = (idxDesc >= 0 ? cols[idxDesc] : cols[1]) ?? '';
    const unit = (idxUnit >= 0 ? cols[idxUnit] : cols[2]) ?? '';
    const priceRaw = (idxPrice >= 0 ? cols[idxPrice] : cols[3]) ?? '';
    const unitPrice = parsePtBrNumber(priceRaw);

    if (!code || !description || !unit || unitPrice === null) {
      skippedRows += 1;
      continue;
    }

    const rawKind = (idxKind >= 0 ? cols[idxKind] : '').toLowerCase();
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
      competencia: params.competencia,
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
    competencia: params.competencia,
    edition: params.edition,
    taxRegime: params.taxRegime,
    isRectification: Boolean(params.isRectification),
    rectificationNote: params.rectificationNote,
    importedAt,
    itemCount: items.length,
    skippedRows,
    items,
    limitations: [
      `Tabela SINAPI importada de arquivo oficial (${params.filename}, SHA-256 ${originalFileSha256.slice(0, 12)}…), UF=${ufClean}, competência=${params.competencia}, edição=${params.edition}, regime=${params.taxRegime}.`,
      'Insumos e composições não devem ser comparados entre si sem ajuste de encargos, BDI, frete e condições de entrega.',
    ],
  };
}
