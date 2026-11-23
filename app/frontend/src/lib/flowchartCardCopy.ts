import { formatCurrencyBRL, formatDateBR } from '@nexofis/shared/lib/formatters';
import type {
  PartnerNetworkCompanySummary,
  PartnerNetworkContractSummary,
  PartnerNetworkNode,
  PartnerNetworkPartnerSummary,
} from '@nexofis/shared/lib/partnerNetworkGraph';

export interface FlowchartCardCopyContext {
  node: PartnerNetworkNode;
  partner?: PartnerNetworkPartnerSummary | null;
  company?: PartnerNetworkCompanySummary | null;
  contract?: PartnerNetworkContractSummary | null;
}

/**
 * Formats any node card in the Partner Network flowchart into clean, structured Portuguese text
 * suitable for pasting into audit reports, spreadsheets, or briefings.
 */
export function formatFlowchartCardCopyText(ctx: FlowchartCardCopyContext): string {
  const { node, partner, company, contract } = ctx;
  const lines: string[] = [];

  if (node.type === 'partner') {
    const displayName = partner?.displayName || String(node.metadata.fullName || node.label);
    lines.push('Tipo: Sócio / Empresário (PF)');
    lines.push(`Nome: ${displayName}`);
    if (partner?.maskedDocument || node.metadata.maskedDocument) {
      lines.push(
        `Documento (QSA): ${partner?.maskedDocument || String(node.metadata.maskedDocument)}`
      );
    }
    if (partner) {
      lines.push(`Empresas vinculadas: ${partner.companyCount}`);
      lines.push(`Contratos na rede: ${partner.contractCount}`);
      lines.push(`Valor contratual agregado: ${formatCurrencyBRL(partner.totalContractValue)}`);
      if (partner.roles.length > 0) {
        lines.push('Participações societárias:');
        for (const r of partner.roles) {
          const entry = r.entryDate ? ` (entrada ${formatDateBR(r.entryDate)})` : '';
          lines.push(`- ${r.companyName} — ${r.role}${entry}`);
        }
      }
    } else if (node.subtitle) {
      lines.push(`Resumo: ${node.subtitle}`);
    }
    return lines.join('\n');
  }

  if (node.type === 'company') {
    const legalName = company?.legalName || String(node.metadata.legalName || node.label);
    const formattedCnpj =
      company?.formattedCnpj || String(node.metadata.formattedCnpj || node.cnpj || '');
    const isHolding = company?.isCorporateShareholder ?? Boolean(node.isCorporateShareholder);
    lines.push(
      `Tipo: ${isHolding ? 'Holding / Sócio Pessoa Jurídica (PJ)' : 'Empresa (Pessoa Jurídica)'}`
    );
    lines.push(`Razão Social: ${legalName}`);
    if (formattedCnpj) {
      lines.push(`CNPJ: ${formattedCnpj}`);
    }
    if (company) {
      lines.push(`Situação cadastral: ${company.registrationStatus}`);
      if (company.openingDate) {
        lines.push(`Abertura: ${formatDateBR(company.openingDate)}`);
      }
      if (company.municipality || company.uf) {
        lines.push(
          `Localidade: ${[company.municipality, company.uf].filter(Boolean).join('/')}`
        );
      }
      lines.push(`Contratos observados: ${company.contractCount}`);
      lines.push(`Valor total contratado: ${formatCurrencyBRL(company.totalContractValue)}`);
      if (company.primaryCnaeCode || company.primaryCnaeDescription) {
        lines.push(
          `CNAE Principal: ${[company.primaryCnaeCode, company.primaryCnaeDescription]
            .filter(Boolean)
            .join(' — ')}`
        );
      }
      if (company.corporateShareholderOf.length > 0) {
        lines.push(
          `Sócia PJ de: ${company.corporateShareholderOf
            .map((l) => `${l.legalName} (${l.formattedCnpj})`)
            .join('; ')}`
        );
      }
      if (company.corporateShareholders.length > 0) {
        lines.push(
          `Sócios PJ (Holdings): ${company.corporateShareholders
            .map((l) => `${l.legalName} (${l.formattedCnpj})`)
            .join('; ')}`
        );
      }
      if (company.viaPartners.length > 0) {
        lines.push(`Vinculada via sócios: ${company.viaPartners.join(', ')}`);
      }
    } else if (node.subtitle) {
      lines.push(`Resumo: ${node.subtitle}`);
    }
    return lines.join('\n');
  }

  if (node.type === 'contract') {
    const number = contract?.contractNumber || String(node.metadata.contractNumber || node.label);
    lines.push('Tipo: Contrato Público');
    lines.push(`Contrato: ${number}`);
    if (contract?.pncpControlNumber) {
      lines.push(`Controle PNCP: ${contract.pncpControlNumber}`);
    }
    if (contract) {
      lines.push(`Órgão contratante: ${contract.entityName}`);
      if (contract.municipalityName) {
        lines.push(`Município: ${contract.municipalityName}`);
      }
      lines.push(`Fornecedor: ${contract.companyName} (${contract.formattedCompanyCnpj})`);
      lines.push(`Valor atualizado: ${formatCurrencyBRL(contract.updatedValue)}`);
      if (contract.signatureDate) {
        lines.push(`Assinatura: ${formatDateBR(contract.signatureDate)}`);
      }
      lines.push(
        `Score de risco: ${
          contract.riskScore !== null ? `${contract.riskScore}/100` : 'Cobertura insuficiente'
        }`
      );
      if (contract.objectSummary) {
        lines.push(`Objeto: ${contract.objectSummary}`);
      }
    } else if (node.subtitle) {
      lines.push(`Resumo: ${node.subtitle}`);
    }
    return lines.join('\n');
  }

  // Organ node
  const organName = String(node.metadata.organName || node.label);
  lines.push('Tipo: Órgão Contratante');
  lines.push(`Órgão: ${organName}`);
  if (node.metadata.municipalityName) {
    lines.push(`Município: ${String(node.metadata.municipalityName)}`);
  }
  lines.push(`Empresas da rede contratadas: ${node.companyCount ?? 1}`);
  lines.push(`Contratos na rede: ${node.contractCount ?? 0}`);
  lines.push(`Volume contratado: ${formatCurrencyBRL(node.value ?? 0)}`);
  if (node.isSharedOrgan) {
    lines.push('Alerta: Órgão contratou mais de uma empresa vinculada nesta rede.');
  }
  return lines.join('\n');
}

/**
 * Copies text to clipboard safely inside both standard browsers and sandboxed iframes.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback (common inside restricted iframes)
  }

  if (typeof document === 'undefined') return false;
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
