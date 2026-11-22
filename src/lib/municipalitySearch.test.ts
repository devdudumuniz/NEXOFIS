import test from 'node:test';
import assert from 'node:assert/strict';
import type { Municipality } from '../types/audit';
import {
  filterAndRankMunicipalities,
  parseMunicipalityQuery,
} from './municipalitySearch';

const SAMPLE_MUNICIPALITIES: Municipality[] = [
  { ibgeCode: '2902906', name: 'Barra do Choça', uf: 'BA', stateName: 'Bahia', source: 'IBGE API Oficial' },
  { ibgeCode: '2902708', name: 'Barra', uf: 'BA', stateName: 'Bahia', source: 'IBGE API Oficial' },
  { ibgeCode: '2904050', name: 'Bonito', uf: 'BA', stateName: 'Bahia', source: 'IBGE API Oficial' },
  { ibgeCode: '5002209', name: 'Bonito', uf: 'MS', stateName: 'Mato Grosso do Sul', source: 'IBGE API Oficial' },
  { ibgeCode: '2933307', name: 'Vitória da Conquista', uf: 'BA', stateName: 'Bahia', source: 'IBGE API Oficial' },
  { ibgeCode: '2919959', name: 'Maetinga', uf: 'BA', stateName: 'Bahia', source: 'IBGE API Oficial' },
];

test('municipalitySearch matches "Barra do Choça (BA)" and other Brazilian UF punctuation formats', () => {
  const variants = [
    'Barra do Choça (BA)',
    'Barra do Choça - BA',
    'Barra do Choça / BA',
    'Barra do Choça, BA',
    'Barra do Choca BA',
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
