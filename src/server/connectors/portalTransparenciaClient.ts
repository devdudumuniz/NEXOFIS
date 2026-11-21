export interface CguSanctionItem {
  registry: 'CEIS' | 'CNEP' | 'CEPIM';
  cnpj: string;
  sanctionType: string;
  organName: string;
  startDate: string | null;
  endDate: string | null;
  legalBasis: string | null;
  sourceUrl: string;
}

export interface CguSanctionsQueryResult {
  cnpj: string;
  status: 'ok' | 'api_key_required' | 'source_unavailable' | 'invalid_cnpj';
  sanctions: CguSanctionItem[];
  checkedRegistries: Array<'CEIS' | 'CNEP' | 'CEPIM'>;
  retrievedAt: string;
  message: string;
}

export interface SiconfiRreoSummary {
  ibgeCode: string;
  year: number;
  bimester: number;
  status: 'ok' | 'source_unavailable' | 'invalid_params';
  rowCount: number;
  sampleAccounts: Array<{
    conta: string;
    coluna: string;
    valor: number;
  }>;
  aggregateOnlyNotice: string;
  retrievedAt: string;
  message: string;
}

const PORTAL_TRANSPARENCIA_BASE = 'https://api.portaldatransparencia.gov.br/api-de-dados';
const SICONFI_BASE = 'https://apidatalake.tesouro.gov.br/ords/siconfi/tt/rreo';

function cleanDigits(value: string): string {
  return value.replace(/\D/g, '');
}

async function fetchPortalRegistry(
  registry: 'CEIS' | 'CNEP' | 'CEPIM',
  cnpj: string,
  apiKey: string,
  timeoutMs: number
): Promise<{ ok: boolean; items: CguSanctionItem[]; error?: string }> {
  const endpointPath =
    registry === 'CEIS' ? 'ceis' : registry === 'CNEP' ? 'cnep' : 'cepim';
  const paramName = registry === 'CEPIM' ? 'cnpjSancionado' : 'codigoSancionado';
  const url = `${PORTAL_TRANSPARENCIA_BASE}/${endpointPath}?${paramName}=${encodeURIComponent(cnpj)}&pagina=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'chave-api-dados': apiKey,
        'User-Agent': 'Nexofis-Audit/1.0',
      },
    });

    if (!res.ok) {
      return { ok: false, items: [], error: `HTTP ${res.status}` };
    }

    const raw = (await res.json()) as Array<{
      tipoSancao?: { descricaoResumida?: string; descricaoPortal?: string };
      orgaoSancionador?: { nome?: string };
      dataInicioSancao?: string;
      dataFimSancao?: string;
      fundamentacao?: Array<{ descricao?: string }>;
      motivo?: string;
    }>;

    const items: CguSanctionItem[] = (Array.isArray(raw) ? raw : []).map((row) => ({
      registry,
      cnpj,
      sanctionType:
        row.tipoSancao?.descricaoResumida ??
        row.tipoSancao?.descricaoPortal ??
        row.motivo ??
        `Registro em ${registry}`,
      organName: row.orgaoSancionador?.nome ?? 'Órgão sancionador não informado',
      startDate: row.dataInicioSancao ?? null,
      endDate: row.dataFimSancao ?? null,
      legalBasis: row.fundamentacao?.[0]?.descricao ?? null,
      sourceUrl: `https://portaldatransparencia.gov.br/sancoes/${endpointPath}?ordenarPor=nome&direcao=asc`,
    }));

    return { ok: true, items };
  } catch (err) {
    return {
      ok: false,
      items: [],
      error: err instanceof Error ? err.message : 'Erro de rede',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function queryCguSanctionsByCnpj(
  rawCnpj: string,
  options?: { apiKey?: string; timeoutMs?: number }
): Promise<CguSanctionsQueryResult> {
  const retrievedAt = new Date().toISOString();
  const cnpj = cleanDigits(rawCnpj);
  if (!/^\d{14}$/.test(cnpj)) {
    return {
      cnpj,
      status: 'invalid_cnpj',
      sanctions: [],
      checkedRegistries: [],
      retrievedAt,
      message: 'CNPJ inválido. Informe exatamente 14 dígitos numéricos.',
    };
  }

  const apiKey = (options?.apiKey ?? process.env.PORTAL_TRANSPARENCIA_API_KEY ?? '').trim();
  if (!apiKey) {
    return {
      cnpj,
      status: 'api_key_required',
      sanctions: [],
      checkedRegistries: [],
      retrievedAt,
      message:
        'Chave PORTAL_TRANSPARENCIA_API_KEY não configurada no servidor. Configure a chave oficial da CGU no arquivo .env para consultar CEIS, CNEP e CEPIM ao vivo (ausência de chave nunca equivale a certidão negativa).',
    };
  }

  const timeoutMs = options?.timeoutMs ?? 8000;
  const registries: Array<'CEIS' | 'CNEP' | 'CEPIM'> = ['CEIS', 'CNEP', 'CEPIM'];
  const results = await Promise.all(
    registries.map((reg) => fetchPortalRegistry(reg, cnpj, apiKey, timeoutMs))
  );

  const succeeded = results.filter((r) => r.ok);
  const sanctions = results.flatMap((r) => r.items);
  const checkedRegistries = registries.filter((_, idx) => results[idx].ok);

  if (succeeded.length === 0) {
    return {
      cnpj,
      status: 'source_unavailable',
      sanctions: [],
      checkedRegistries: [],
      retrievedAt,
      message:
        'API do Portal da Transparência (CGU) indisponível ou recusou a consulta. Não é possível concluir regularidade sancionatória sem resposta válida.',
    };
  }

  return {
    cnpj,
    status: 'ok',
    sanctions,
    checkedRegistries,
    retrievedAt,
    message:
      sanctions.length > 0
        ? `${sanctions.length} registro(s) sancionatório(s) encontrado(s) em ${checkedRegistries.join(', ')}.`
        : `Nenhum registro ativo encontrado nos cadastros consultados (${checkedRegistries.join(', ')}).`,
  };
}

export async function querySiconfiRreo(
  ibgeCode: string,
  year: number,
  bimester = 6,
  options?: { timeoutMs?: number }
): Promise<SiconfiRreoSummary> {
  const retrievedAt = new Date().toISOString();
  const aggregateOnlyNotice =
    'SICONFI/Tesouro Nacional fornece apenas demonstrativos fiscais agregados do ente (RREO/RGF/DCA), servindo como contexto macrofiscal e nunca como prova individual de sobrepreço ou irregularidade contratual.';

  if (!/^\d{7}$/.test(ibgeCode) || !Number.isInteger(year) || year < 2015 || year > 2030 || bimester < 1 || bimester > 6) {
    return {
      ibgeCode,
      year,
      bimester,
      status: 'invalid_params',
      rowCount: 0,
      sampleAccounts: [],
      aggregateOnlyNotice,
      retrievedAt,
      message: 'Parâmetros inválidos para SICONFI RREO (informe código IBGE de 7 dígitos, exercício e bimestre 1–6).',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 8000);
  try {
    const url = new URL(SICONFI_BASE);
    url.searchParams.set('an_exercicio', String(year));
    url.searchParams.set('nr_periodo', String(bimester));
    url.searchParams.set('co_tipo_demonstrativo', 'RREO');
    url.searchParams.set('no_anexo', 'RREO-Anexo 01');
    url.searchParams.set('id_ente', ibgeCode);

    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Nexofis-Audit/1.0',
      },
    });

    if (!res.ok) {
      return {
        ibgeCode,
        year,
        bimester,
        status: 'source_unavailable',
        rowCount: 0,
        sampleAccounts: [],
        aggregateOnlyNotice,
        retrievedAt,
        message: `SICONFI retornou HTTP ${res.status}.`,
      };
    }

    const payload = (await res.json()) as {
      items?: Array<{ conta?: string; coluna?: string; valor?: number }>;
    };
    const items = Array.isArray(payload.items) ? payload.items : [];
    return {
      ibgeCode,
      year,
      bimester,
      status: 'ok',
      rowCount: items.length,
      sampleAccounts: items.slice(0, 12).map((row) => ({
        conta: String(row.conta ?? ''),
        coluna: String(row.coluna ?? ''),
        valor: Number(row.valor ?? 0),
      })),
      aggregateOnlyNotice,
      retrievedAt,
      message: `${items.length} linhas fiscais agregadas obtidas no SICONFI (RREO ${year}/${bimester}º bimestre).`,
    };
  } catch (err) {
    return {
      ibgeCode,
      year,
      bimester,
      status: 'source_unavailable',
      rowCount: 0,
      sampleAccounts: [],
      aggregateOnlyNotice,
      retrievedAt,
      message: `Falha ao consultar SICONFI: ${err instanceof Error ? err.message : 'erro de rede'}.`,
    };
  } finally {
    clearTimeout(timer);
  }
}
