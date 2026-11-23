import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRelatedContractNumber,
  parseBrazilianContractCode,
  parsePncpUrlFromQuery,
} from './pncpQueryParser';

test('parses municipal inexigibilidade code with fund suffix (IN012/2026FMS)', () => {
  const parsed = parseBrazilianContractCode('IN012/2026FMS');
  assert.ok(parsed);
  assert.equal(parsed.prefix, 'IN');
  assert.equal(parsed.modalityHint, 'Inexigibilidade');
  assert.equal(parsed.modalityCode, 9);
  assert.equal(parsed.numberCore, '012');
  assert.equal(parsed.numberNumeric, '12');
  assert.equal(parsed.year, '2026');
  assert.equal(parsed.unitSuffix, 'FMS');
  assert.equal(parsed.unitHint, 'Fundo Municipal de Saúde');
  assert.equal(parsed.normalizedNumber, '012/2026');
});

test('parses dispensation and plain contract numbers accurately', () => {
  const disp = parseBrazilianContractCode('DL-035/2026-SMS');
  assert.ok(disp);
  assert.equal(disp.modalityCode, 8);
  assert.equal(disp.unitSuffix, 'SMS');
  assert.equal(disp.normalizedNumber, '035/2026');

  const plain = parseBrazilianContractCode('123/2026');
  assert.ok(plain);
  assert.equal(plain.prefix, undefined);
  assert.equal(plain.numberNumeric, '123');
  assert.equal(plain.year, '2026');
});

test('identifies related numeric contract numbers across formats within same year', () => {
  const parsed = parseBrazilianContractCode('IN012/2026FMS')!;
  assert.equal(isRelatedContractNumber('012/2026', parsed, 2026), true);
  assert.equal(isRelatedContractNumber('012', parsed, 2026), true);
  assert.equal(isRelatedContractNumber('012/2025', parsed, 2025), false);
  assert.equal(isRelatedContractNumber('014/2026', parsed, 2026), false);
});

test('safely parses PNCP URLs and rejects non-.gov.br hosts', () => {
  const valid = parsePncpUrlFromQuery('https://pncp.gov.br/app/contratos/14043574000151/2026/123');
  assert.deepEqual(valid, {
    orgaoCnpj: '14043574000151',
    year: '2026',
    sequential: '123',
    sourceHost: 'pncp.gov.br',
  });

  const rejected = parsePncpUrlFromQuery('https://evil.example.com/14043574000151/2026/123');
  assert.equal(rejected, null);
});
