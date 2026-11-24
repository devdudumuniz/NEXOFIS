import type { AssertionState } from './temporalIdentityGraph.js';

export interface ForensicGraphPersonNode {
  personId: string;
  nome: string;
  /** Strictly masked CPF or external identifier; NEVER reconstruct masked CPFs */
  cpfMascarado: string | null;
  cargoPolitico?: string | null;
  escolaridadeDocumentada?: string | null;
  identityResolved: boolean;
}

export interface ForensicGraphCompanyNode {
  cnpj: string;
  razaoSocial: string;
  capitalSocial?: number | null;
}

export interface ForensicGraphPublicAgencyNode {
  orgaoId: string;
  nome: string;
  ibge?: string | null;
}

export interface ForensicGraphPublicOfficeNode {
  cargoId: string;
  titulo: string;
  tipo: 'Comissionado' | 'Efetivo' | 'Eletivo' | 'Temporario' | 'Desconhecido';
  salario?: number | null;
  orgaoId: string;
}

export interface ForensicGraphContractNode {
  contratoId: string;
  numero: string;
  objeto: string;
  valorTotal: number;
  valorMensal?: number | null;
  ano: number;
  cnpjFornecedor: string;
  orgaoId: string;
}

export interface ForensicGraphKinshipEdge {
  fromPersonId: string;
  toPersonId: string;
  relationType: 'PARENTESCO_COM' | 'CONJUGE_DE';
  grau: string;
  tipo?: string;
  assertionState: AssertionState;
  evidenceRef: string;
}

export interface ForensicGraphShareholderEdge {
  personId: string;
  cnpj: string;
  qualificacao: string;
  participacaoPct?: number | null;
  assertionState: AssertionState;
  evidenceRef: string;
}

export interface ForensicGraphOfficeHoldingEdge {
  personId: string;
  cargoId: string;
  atoNomeacaoRef?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  assertionState: AssertionState;
  evidenceRef: string;
}

export interface ForensicGraphSnapshot {
  people: ForensicGraphPersonNode[];
  companies: ForensicGraphCompanyNode[];
  agencies: ForensicGraphPublicAgencyNode[];
  offices: ForensicGraphPublicOfficeNode[];
  contracts: ForensicGraphContractNode[];
  kinshipEdges: ForensicGraphKinshipEdge[];
  shareholderEdges: ForensicGraphShareholderEdge[];
  officeHoldingEdges: ForensicGraphOfficeHoldingEdge[];
}

export interface KinshipOfficeContractMatch {
  politico: string;
  parenteContratado: string;
  grauParentesco: string;
  cargoOcupado: string;
  salario: number | null;
  empresaContratada: string;
  cnpjEmpresa: string;
  contratoNumero: string;
  valorContrato: number;
  valorMensal: number | null;
  entePublico: string;
  assertionStates: AssertionState[];
  evidenceRefs: string[];
  /** Safeguard: candidate/unresolved paths NEVER authorize automatic legal conclusions */
  includesUnresolvedOrCandidatePath: boolean;
  forensicNote: string;
}

export interface MultiHopCorporateNetworkMatch {
  socioComum: string;
  socioDocumentoMascarado: string | null;
  empresaInvestigadaCnpj: string;
  empresaInvestigadaRazaoSocial: string;
  empresaSateliteCnpj: string;
  empresaSateliteRazaoSocial: string;
  numeroContrato: string;
  valorContrato: number;
  valorMensal: number | null;
  orgaoContratante: string;
  assertionState: AssertionState;
  includesUnresolvedIdentity: boolean;
  forensicNote: string;
}

/**
 * Neo4j 5+ schema constraints & indexes matching the NEXOFIS investigative graph model.
 * Note: NEXOFIS persists natively in SQLite; Neo4j is an optional read/analysis projection
 * governed by ADR (see docs/EVOLUCAO_INVESTIGATIVA.md).
 */
export const FORENSIC_GRAPH_CYPHER_CONSTRAINTS = `// NEXOFIS Forensic Graph Schema (Neo4j 5+ Projection — Optional ADR)
CREATE CONSTRAINT pessoa_id_unique IF NOT EXISTS FOR (p:Pessoa) REQUIRE p.personId IS UNIQUE;
CREATE CONSTRAINT empresa_cnpj_unique IF NOT EXISTS FOR (e:Empresa) REQUIRE e.cnpj IS UNIQUE;
CREATE CONSTRAINT contrato_id_unique IF NOT EXISTS FOR (c:Contrato) REQUIRE c.contratoId IS UNIQUE;
CREATE CONSTRAINT orgao_id_unique IF NOT EXISTS FOR (o:OrgaoPublico) REQUIRE o.orgaoId IS UNIQUE;
CREATE CONSTRAINT cargo_id_unique IF NOT EXISTS FOR (g:CargoPublico) REQUIRE g.cargoId IS UNIQUE;
CREATE INDEX pessoa_nome_idx IF NOT EXISTS FOR (p:Pessoa) ON (p.nome);
CREATE INDEX empresa_razao_idx IF NOT EXISTS FOR (e:Empresa) ON (e.razao_social);`;

/**
 * Ready-to-run investigative Cypher queries incorporating NEXOFIS forensic safeguards
 * (filtering to documented assertions by default so candidate homonyms never drive conclusions).
 */
export const FORENSIC_GRAPH_CYPHER_QUERIES = {
  kinshipOfficeContractOverlap: `// Consulta 1: Rastrear Parentes de Políticos Ocupando Cargos e Ligados a Empresas Contratadas
// Parâmetro recomendado: { onlyDocumented: true } para exigir vínculos documentalmente sustentados
MATCH (politico:Pessoa)-[relPar:PARENTESCO_COM|CONJUGE_DE]-(parente:Pessoa),
      (parente)-[relCargo:OCUPA_CARGO]->(cargo:CargoPublico)-[:LOTADO_EM]->(orgao:OrgaoPublico),
      (parente)-[relSoc:SOCIO_DE]->(empresa:Empresa)-[:FORNECE_PARA]->(contrato:Contrato)-[:VINCULADO_A]->(orgao)
WHERE ($onlyDocumented = false OR (
  relPar.assertionState = 'documented' AND
  relCargo.assertionState = 'documented' AND
  relSoc.assertionState = 'documented' AND
  politico.identityResolved = true AND
  parente.identityResolved = true
))
RETURN politico.nome AS Politico,
       parente.nome AS Parente_Contratado,
       relPar.grau AS Grau_Parentesco,
       cargo.titulo AS Cargo_Ocupado,
       cargo.salario AS Salario,
       empresa.razao_social AS Empresa_Contratada,
       empresa.cnpj AS CNPJ_Empresa,
       contrato.numero AS Contrato,
       contrato.valor_total AS Valor_Total_Contrato,
       contrato.valor_mensal AS Valor_Mensal,
       orgao.nome AS Ente_Publico,
       [relPar.evidenceRef, relCargo.evidenceRef, relSoc.evidenceRef] AS Evidencias;`,

  hiddenMultiHopCorporateNetwork: `// Consulta 2: Rastrear Sociedades em Rede (Empresa 1 <- Sócio -> Empresa 2 -> Contratos)
// Parâmetros: { cnpj: '12345678000190', onlyDocumented: true }
MATCH (e1:Empresa {cnpj: $cnpj})<-[s1:SOCIO_DE]-(s:Pessoa)-[s2:SOCIO_DE]->(e2:Empresa)-[:FORNECE_PARA]->(c:Contrato)-[:VINCULADO_A]->(o:OrgaoPublico)
WHERE e1.cnpj <> e2.cnpj
  AND ($onlyDocumented = false OR (s1.assertionState = 'documented' AND s2.assertionState = 'documented' AND s.identityResolved = true))
RETURN s.nome AS Socio_Comum,
       s.cpf AS CPF_Mascarado,
       e1.razao_social AS Empresa_Investigada,
       e2.razao_social AS Empresa_Satelite,
       e2.cnpj AS CNPJ_Satelite,
       c.numero AS Numero_Contrato,
       c.valor_total AS Valor_Total_Contrato,
       c.valor_mensal AS Valor_Mensal,
       o.nome AS Orgao_Contratante;`,
} as const;

function escapeCypherString(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ');
}

function cypherNum(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'null';
}

/**
 * Generates an idempotent Neo4j Cypher projection script (MERGE-based) from any NEXOFIS
 * graph snapshot. Preserves masked CPFs without reconstruction, never maps QSA qualification
 * to schooling, and retains assertionState + evidenceRef on every relationship edge.
 */
export function generateForensicCypherScript(snapshot: ForensicGraphSnapshot): string {
  const lines: string[] = [
    '// NEXOFIS — Projeção Cypher (Neo4j) gerada a partir do armazenamento local SQLite',
    '// AVISO FORENSE: Não publique dados pessoais ou investigações reais em repositórios públicos.',
    '// Valores contratuais pertencem às pessoas jurídicas contratadas, sem equivalência com renda pessoal de sócios.',
    '',
    FORENSIC_GRAPH_CYPHER_CONSTRAINTS,
    '',
    '// 1. Nós (:Pessoa, :Empresa, :OrgaoPublico, :CargoPublico, :Contrato)',
  ];

  for (const p of snapshot.people) {
    lines.push(
      `MERGE (p:Pessoa {personId: "${escapeCypherString(p.personId)}"}) ` +
        `SET p.nome = "${escapeCypherString(p.nome)}", ` +
        `p.cpf = ${p.cpfMascarado ? `"${escapeCypherString(p.cpfMascarado)}"` : 'null'}, ` +
        `p.cargo = ${p.cargoPolitico ? `"${escapeCypherString(p.cargoPolitico)}"` : 'null'}, ` +
        `p.escolaridade_documentada = ${p.escolaridadeDocumentada ? `"${escapeCypherString(p.escolaridadeDocumentada)}"` : 'null'}, ` +
        `p.identityResolved = ${p.identityResolved ? 'true' : 'false'};`
    );
  }

  for (const e of snapshot.companies) {
    lines.push(
      `MERGE (e:Empresa {cnpj: "${escapeCypherString(e.cnpj)}"}) ` +
        `SET e.razao_social = "${escapeCypherString(e.razaoSocial)}", ` +
        `e.capital = ${cypherNum(e.capitalSocial)};`
    );
  }

  for (const o of snapshot.agencies) {
    lines.push(
      `MERGE (o:OrgaoPublico {orgaoId: "${escapeCypherString(o.orgaoId)}"}) ` +
        `SET o.nome = "${escapeCypherString(o.nome)}", ` +
        `o.ibge = ${o.ibge ? `"${escapeCypherString(o.ibge)}"` : 'null'};`
    );
  }

  for (const g of snapshot.offices) {
    lines.push(
      `MERGE (g:CargoPublico {cargoId: "${escapeCypherString(g.cargoId)}"}) ` +
        `SET g.titulo = "${escapeCypherString(g.titulo)}", ` +
        `g.tipo = "${escapeCypherString(g.tipo)}", ` +
        `g.salario = ${cypherNum(g.salario)};`
    );
    lines.push(
      `MATCH (g:CargoPublico {cargoId: "${escapeCypherString(g.cargoId)}"}), ` +
        `(o:OrgaoPublico {orgaoId: "${escapeCypherString(g.orgaoId)}"}) ` +
        `MERGE (g)-[:LOTADO_EM]->(o);`
    );
  }

  for (const c of snapshot.contracts) {
    lines.push(
      `MERGE (c:Contrato {contratoId: "${escapeCypherString(c.contratoId)}"}) ` +
        `SET c.numero = "${escapeCypherString(c.numero)}", ` +
        `c.objeto = "${escapeCypherString(c.objeto)}", ` +
        `c.valor_total = ${cypherNum(c.valorTotal)}, ` +
        `c.valor_mensal = ${cypherNum(c.valorMensal)}, ` +
        `c.ano = ${cypherNum(c.ano)};`
    );
    lines.push(
      `MATCH (e:Empresa {cnpj: "${escapeCypherString(c.cnpjFornecedor)}"}), ` +
        `(c:Contrato {contratoId: "${escapeCypherString(c.contratoId)}"}), ` +
        `(o:OrgaoPublico {orgaoId: "${escapeCypherString(c.orgaoId)}"}) ` +
        `MERGE (e)-[:FORNECE_PARA]->(c) MERGE (c)-[:VINCULADO_A]->(o);`
    );
  }

  lines.push('', '// 2. Arestas de Relacionamento com Proveniência e Estado da Afirmação');

  for (const k of snapshot.kinshipEdges) {
    const rel = k.relationType === 'CONJUGE_DE' ? 'CONJUGE_DE' : 'PARENTESCO_COM';
    lines.push(
      `MATCH (a:Pessoa {personId: "${escapeCypherString(k.fromPersonId)}"}), ` +
        `(b:Pessoa {personId: "${escapeCypherString(k.toPersonId)}"}) ` +
        `MERGE (a)-[r:${rel} {evidenceRef: "${escapeCypherString(k.evidenceRef)}"}]->(b) ` +
        `SET r.grau = "${escapeCypherString(k.grau)}", ` +
        `r.tipo = ${k.tipo ? `"${escapeCypherString(k.tipo)}"` : 'null'}, ` +
        `r.assertionState = "${k.assertionState}";`
    );
  }

  for (const s of snapshot.shareholderEdges) {
    lines.push(
      `MATCH (p:Pessoa {personId: "${escapeCypherString(s.personId)}"}), ` +
        `(e:Empresa {cnpj: "${escapeCypherString(s.cnpj)}"}) ` +
        `MERGE (p)-[r:SOCIO_DE {evidenceRef: "${escapeCypherString(s.evidenceRef)}"}]->(e) ` +
        `SET r.qualificacao = "${escapeCypherString(s.qualificacao)}", ` +
        `r.participacao_pct = ${cypherNum(s.participacaoPct)}, ` +
        `r.assertionState = "${s.assertionState}";`
    );
  }

  for (const h of snapshot.officeHoldingEdges) {
    lines.push(
      `MATCH (p:Pessoa {personId: "${escapeCypherString(h.personId)}"}), ` +
        `(g:CargoPublico {cargoId: "${escapeCypherString(h.cargoId)}"}) ` +
        `MERGE (p)-[r:OCUPA_CARGO {evidenceRef: "${escapeCypherString(h.evidenceRef)}"}]->(g) ` +
        `SET r.ato = ${h.atoNomeacaoRef ? `"${escapeCypherString(h.atoNomeacaoRef)}"` : 'null'}, ` +
        `r.startDate = ${h.startDate ? `"${escapeCypherString(h.startDate)}"` : 'null'}, ` +
        `r.endDate = ${h.endDate ? `"${escapeCypherString(h.endDate)}"` : 'null'}, ` +
        `r.assertionState = "${h.assertionState}";`
    );
  }

  return lines.join('\n');
}

/**
 * Exhaustive AssertionState composer (Defect 1.3a):
 * Precedence: dismissed > contested > candidate > documented.
 * Ensures a dismissed edge NEVER degrades/reappears as documented.
 */
export function composeAssertionStates(states: ReadonlyArray<AssertionState>): AssertionState {
  if (states.some((s) => s === 'dismissed')) return 'dismissed';
  if (states.some((s) => s === 'contested')) return 'contested';
  if (states.some((s) => s === 'candidate')) return 'candidate';
  return 'documented';
}

/**
 * In-process equivalent of Consulta 1 (Neo4j Cypher kinship + office + contract traversal),
 * running directly on NEXOFIS's SQLite/TypeScript data without requiring a Neo4j daemon.
 */
export function executeKinshipOfficeContractQuery(
  snapshot: ForensicGraphSnapshot,
  options?: { onlyDocumented?: boolean; includeDismissed?: boolean }
): KinshipOfficeContractMatch[] {
  const onlyDocumented = options?.onlyDocumented ?? true;
  const includeDismissed = options?.includeDismissed ?? false;
  const peopleById = new Map(snapshot.people.map((p) => [p.personId, p]));
  const companiesByCnpj = new Map(snapshot.companies.map((c) => [c.cnpj, c]));
  const agenciesById = new Map(snapshot.agencies.map((a) => [a.orgaoId, a]));
  const officesById = new Map(snapshot.offices.map((o) => [o.cargoId, o]));

  const matches: KinshipOfficeContractMatch[] = [];
  const seen = new Set<string>();

  for (const kin of snapshot.kinshipEdges) {
    // Undirected kinship traversal: evaluate both (from -> to) and (to -> from)
    const pairs: Array<[string, string]> = [
      [kin.fromPersonId, kin.toPersonId],
      [kin.toPersonId, kin.fromPersonId],
    ];

    for (const [politicoId, parenteId] of pairs) {
      const politico = peopleById.get(politicoId);
      const parente = peopleById.get(parenteId);
      if (!politico || !parente) continue;

      const parenteOffices = snapshot.officeHoldingEdges.filter((o) => o.personId === parenteId);
      const parenteShares = snapshot.shareholderEdges.filter((s) => s.personId === parenteId);

      for (const officeEdge of parenteOffices) {
        const cargo = officesById.get(officeEdge.cargoId);
        if (!cargo) continue;
        const orgao = agenciesById.get(cargo.orgaoId);
        if (!orgao) continue;

        for (const shareEdge of parenteShares) {
          const empresa = companiesByCnpj.get(shareEdge.cnpj);
          if (!empresa) continue;

          const matchingContracts = snapshot.contracts.filter(
            (c) => c.cnpjFornecedor === empresa.cnpj && c.orgaoId === orgao.orgaoId
          );

          for (const contrato of matchingContracts) {
            const assertionStates: AssertionState[] = [
              kin.assertionState,
              officeEdge.assertionState,
              shareEdge.assertionState,
            ];
            const composedState = composeAssertionStates(assertionStates);
            if (!includeDismissed && composedState === 'dismissed') {
              continue;
            }
            const includesUnresolvedOrCandidatePath =
              !politico.identityResolved ||
              !parente.identityResolved ||
              composedState !== 'documented';

            if (onlyDocumented && includesUnresolvedOrCandidatePath) {
              continue;
            }

            const dedupeKey = `${politico.personId}|${parente.personId}|${cargo.cargoId}|${empresa.cnpj}|${contrato.contratoId}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            matches.push({
              politico: politico.nome,
              parenteContratado: parente.nome,
              grauParentesco: kin.grau,
              cargoOcupado: cargo.titulo,
              salario: cargo.salario ?? null,
              empresaContratada: empresa.razaoSocial,
              cnpjEmpresa: empresa.cnpj,
              contratoNumero: contrato.numero,
              valorContrato: contrato.valorTotal,
              valorMensal: contrato.valorMensal ?? null,
              entePublico: orgao.nome,
              assertionStates,
              evidenceRefs: [kin.evidenceRef, officeEdge.evidenceRef, shareEdge.evidenceRef],
              includesUnresolvedOrCandidatePath,
              forensicNote: includesUnresolvedOrCandidatePath
                ? 'Caminho contém identidade não resolvida ou vínculo candidato/contestado — não sustenta conclusão jurídica automática.'
                : 'Vínculos documentados exigem revisão jurídica sob a legislação local e Lei nº 14.133/2021 (Art. 14) antes de qualquer conclusão.',
            });
          }
        }
      }
    }
  }

  return matches;
}

/**
 * In-process equivalent of Consulta 2 (Empresa 1 <-[:SOCIO_DE]- Sócio -[:SOCIO_DE]-> Empresa 2 -> Contrato),
 * running directly on NEXOFIS's SQLite/TypeScript data without requiring a Neo4j daemon.
 */
export function executeMultiHopCorporateNetworkQuery(
  snapshot: ForensicGraphSnapshot,
  targetCnpj: string,
  options?: { onlyDocumented?: boolean; includeDismissed?: boolean }
): MultiHopCorporateNetworkMatch[] {
  const cleanTarget = targetCnpj.replace(/\D/g, '');
  const onlyDocumented = options?.onlyDocumented ?? false;
  const includeDismissed = options?.includeDismissed ?? false;
  const peopleById = new Map(snapshot.people.map((p) => [p.personId, p]));
  const companiesByCnpj = new Map(
    snapshot.companies.map((c) => [c.cnpj.replace(/\D/g, ''), c])
  );
  const agenciesById = new Map(snapshot.agencies.map((a) => [a.orgaoId, a]));

  const e1 = companiesByCnpj.get(cleanTarget);
  if (!e1) return [];

  const e1ShareEdges = snapshot.shareholderEdges.filter(
    (s) => s.cnpj.replace(/\D/g, '') === cleanTarget
  );

  const results: MultiHopCorporateNetworkMatch[] = [];
  const seen = new Set<string>();

  for (const s1 of e1ShareEdges) {
    const person = peopleById.get(s1.personId);
    if (!person) continue;

    const otherCompanyEdges = snapshot.shareholderEdges.filter(
      (s2) => s2.personId === s1.personId && s2.cnpj.replace(/\D/g, '') !== cleanTarget
    );

    for (const s2 of otherCompanyEdges) {
      const e2Clean = s2.cnpj.replace(/\D/g, '');
      const e2 = companiesByCnpj.get(e2Clean);
      if (!e2) continue;

      const combinedState = composeAssertionStates([s1.assertionState, s2.assertionState]);

      if (!includeDismissed && combinedState === 'dismissed') {
        continue;
      }

      const includesUnresolvedIdentity = !person.identityResolved || combinedState !== 'documented';
      if (onlyDocumented && includesUnresolvedIdentity) {
        continue;
      }

      const e2Contracts = snapshot.contracts.filter(
        (c) => c.cnpjFornecedor.replace(/\D/g, '') === e2Clean
      );

      for (const c of e2Contracts) {
        const dedupeKey = `${person.personId}|${e2Clean}|${c.contratoId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const orgao = agenciesById.get(c.orgaoId);
        results.push({
          socioComum: person.nome,
          socioDocumentoMascarado: person.cpfMascarado,
          empresaInvestigadaCnpj: e1.cnpj,
          empresaInvestigadaRazaoSocial: e1.razaoSocial,
          empresaSateliteCnpj: e2.cnpj,
          empresaSateliteRazaoSocial: e2.razaoSocial,
          numeroContrato: c.numero,
          valorContrato: c.valorTotal,
          valorMensal: c.valorMensal ?? null,
          orgaoContratante: orgao?.nome ?? c.orgaoId,
          assertionState: combinedState,
          includesUnresolvedIdentity,
          forensicNote: includesUnresolvedIdentity
            ? 'Identidade do sócio não totalmente resolvida (CPF mascarado/homônimo candidato): valores pertencem às empresas satélites e não podem ser somados como renda pessoal.'
            : 'Conexão societária documentada via QSA; valores referem-se aos contratos da empresa satélite, sem equivalência com renda pessoal do sócio.',
        });
      }
    }
  }

  return results;
}
