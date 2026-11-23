import test from 'node:test';
import assert from 'node:assert/strict';
import type { Municipality } from '../types/audit';
import {
  damerauLevenshtein,
  filterAndRankMunicipalities,
  parseMunicipalityQuery,
  validateMunicipalityInput,
} from './municipalitySearch';

const SAMPLE_MUNICIPALITIES: Municipality[] = [
  { ibgeCode: '2902906', name: 'Barra do Choça', uf: 'BA', stateName: 'Bahia', source: 'IBGE API Oficial' },
  { ibgeCode: '2902708', name: 'Barra', uf: 'BA', stateName: 'Bahia', source: 'IBGE API Oficial' },
  { ibgeCode: '2904050', name: 'Bonito', uf: 'BA', stateName: 'Bahia', source: 'IBGE API Oficial' },
  { ibgeCode: '5002209', name: 'Bonito', uf: 'MS', stateName: 'Mato Grosso do Sul', source: 'IBGE API Oficial' },
  { ibgeCode: '2933307', name: 'Vitória da Conquista', uf: 'BA', stateName: 'Bahia', source: 'IBGE API Oficial' },
  { ibgeCode: '2919959', name: 'Maetinga', uf: 'BA', stateName: 'Bahia', source: 'IBGE API Oficial' },
  { ibgeCode: '2916401', name: 'Itapetinga', uf: 'BA', stateName: 'Bahia', source: 'IBGE API Oficial' },
];

test('municipalitySearch matches "Barra do Choça (BA)" and all Brazilian punctuation/state/prefix formats', () => {
  const variants = [
    'Barra do Choça (BA)',
    'Barra do Choça - BA',
    'Barra do Choça — BA',
    'Barra do Choça / BA',
    'Barra do Choça, BA',
    'Barra do Choca BA',
    'BA - Barra do Choça',
    'Barra do Choça (Bahia)',
    'Prefeitura Municipal de Barra do Choça (BA)',
    'Município de Barra do Choça - BA',
    'barra do choca',
    '2902906',
    'IBGE 2902906',
  ];

  for (const q of variants) {
    const res = filterAndRankMunicipalities(SAMPLE_MUNICIPALITIES, q);
    assert.ok(res.length >= 1, `Expected at least 1 match for "${q}"`);
    assert.equal(res[0].ibgeCode, '2902906', `Expected Barra do Choça (2902906) first for "${q}"`);
  }
});

test('municipalitySearch fuzzy-matching recovers typos and phonetic variations', () => {
  const typoCases: Array<[string, string]> = [
    ['Bara do Choca (BA)', '2902906'],
    ['Barra do Cossa', '2902906'],
    ['Vitoria da Conqista', '2933307'],
    ['Maetiga', '2919959'],
    ['Itapetiga', '2916401'],
  ];

  for (const [query, expectedIbge] of typoCases) {
    const res = filterAndRankMunicipalities(SAMPLE_MUNICIPALITIES, query);
    assert.ok(res.length >= 1, `Expected fuzzy match for "${query}"`);
    assert.equal(res[0].ibgeCode, expectedIbge, `Expected ${expectedIbge} for fuzzy query "${query}"`);
  }

  assert.equal(damerauLevenshtein('choca', 'choca'), 0);
  assert.equal(damerauLevenshtein('chcoa', 'choca'), 1); // adjacent transposition
});

test('municipalitySearch disambiguates homonymous cities using trailing UF in parentheses or dash', () => {
  const ba = filterAndRankMunicipalities(SAMPLE_MUNICIPALITIES, 'Bonito (BA)');
  assert.equal(ba.length, 1);
  assert.equal(ba[0].ibgeCode, '2904050');

  const ms = filterAndRankMunicipalities(SAMPLE_MUNICIPALITIES, 'Bonito - MS');
  assert.equal(ms.length, 1);
  assert.equal(ms[0].ibgeCode, '5002209');
});

test('municipalitySearch ranks exact name match above prefix matches', () => {
  const res = filterAndRankMunicipalities(SAMPLE_MUNICIPALITIES, 'Barra');
  assert.equal(res[0].ibgeCode, '2902708'); // Exact "Barra" before "Barra do Choça"
  assert.equal(res[1].ibgeCode, '2902906');
});

test('parseMunicipalityQuery extracts UF filter and 7-digit IBGE codes cleanly', () => {
  const parsedUf = parseMunicipalityQuery('Vitória da Conquista (BA)');
  assert.equal(parsedUf.nameQuery, 'vitoria da conquista');
  assert.equal(parsedUf.ufFilter, 'BA');
  assert.equal(parsedUf.ibgeDigits, null);

  const parsedCode = parseMunicipalityQuery('IBGE 2933307');
  assert.equal(parsedCode.ibgeDigits, '2933307');
});

test('validateMunicipalityInput validates 7-digit IBGE codes in real time without flagging city names', () => {
  assert.equal(validateMunicipalityInput('').status, 'empty');
  assert.equal(validateMunicipalityInput('Barra do Choça (BA)').status, 'name_search');

  const short = validateMunicipalityInput('29029');
  assert.equal(short.status, 'invalid_ibge');
  assert.equal(short.digitCount, 5);
  assert.match(short.message ?? '', /7 dígitos/i);

  const tooLong = validateMunicipalityInput('29029061');
  assert.equal(tooLong.status, 'invalid_ibge');
  assert.equal(tooLong.digitCount, 8);

  const mixed = validateMunicipalityInput('29029A6');
  assert.equal(mixed.status, 'invalid_ibge');

  const badUf = validateMunicipalityInput('9900001');
  assert.equal(badUf.status, 'invalid_ibge');
  assert.match(badUf.message ?? '', /prefixo "99"/i);

  const valid = validateMunicipalityInput('2902906');
  assert.equal(valid.status, 'valid_ibge');
  assert.equal(valid.ibgeCode, '2902906');

  const validWithPrefix = validateMunicipalityInput('IBGE 2902906');
  assert.equal(validWithPrefix.status, 'valid_ibge');
  assert.equal(validWithPrefix.ibgeCode, '2902906');
});
