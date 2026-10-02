import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCatalogCsv, generateStagingBaseline } from './pro00-baseline.mjs';

const source = await readFile(new URL('../../docs/plan-pro/pro00/source-catalog-2026-10-02.sanitized.csv', import.meta.url), 'utf8');
const staging = await readFile(new URL('../../docs/plan-pro/pro00/staging-catalog-2026-10-02.csv', import.meta.url), 'utf8');
const catalog = parseCatalogCsv(source);
const previous = parseCatalogCsv(staging);
const sql = () => generateStagingBaseline(catalog, previous);

test('CSV con BOM, comillas y cuerpos multilinea conserva 17 secciones', () => {
  assert.equal(Object.keys(catalog).length, 17);
  assert.equal(catalog['01_relations'].length, 21);
  assert.equal(catalog['02_columns'].length, 265);
  assert.match(catalog['08_functions'].find(f => f.name === 'reservar_ncf').definition, /FOR UPDATE/i);
});
test('rechaza capture truncada y count incompatible', () => {
  assert.throws(() => parseCatalogCsv('section,object_count,evidence\na,2,"[]"'), /count/i);
  assert.throws(() => parseCatalogCsv('section,evidence\na,"['), /CSV/i);
});
test('baseline exige ledger y exactamente los dos negocios QA antes de DDL', () => {
  const output = sql();
  assert.match(output, /inventario_operaciones_v2/);
  assert.match(output, /96000000-0000-4000-8000-000000000001/);
  assert.match(output, /PRO00 QA A - SINTETICO/);
  assert.ok(output.indexOf('$pro00_guard$') < output.indexOf('CREATE TABLE'));
  assert.match(output, /BEGIN;[\s\S]+COMMIT;/);
});
test('solo añade: sin DROP/TRUNCATE ni DML fuera de cuerpos de funciones', () => {
  const output = sql();
  assert.doesNotMatch(output, /\bDROP\s|\bTRUNCATE\s|CREATE OR REPLACE/i);
  assert.match(output, /CREATE TABLE IF NOT EXISTS/);
  assert.match(output, /ADD COLUMN IF NOT EXISTS/);
  assert.doesNotMatch(output, /ALTER COLUMN|DISABLE ROW LEVEL SECURITY/i);
});
test('preserva tipos text/uuid/numeric e inventario integer', () => {
  const output = sql();
  assert.match(output, /"cajas"[\s\S]+"id" text NOT NULL/);
  assert.match(output, /"stock_actual" integer/);
  assert.match(output, /"cantidad" numeric/);
  assert.doesNotMatch(output, /stock_actual.*decimal/i);
});
test('no recrea/reemplaza nucleo v2 ni RPC v1 existente', () => {
  const output = sql();
  assert.doesNotMatch(output, /CREATE (?:TABLE|FUNCTION).*inventario_(?:operaciones|secuencias)_v2|CREATE FUNCTION.*aplicar_movimiento_stock/);
});
test('sin copiar PIN redactado ni hardcodear PIN de usuarios', () => {
  const output = sql();
  assert.match(output, /"pin_admin" text/);
  assert.doesNotMatch(output, /"pin_admin"[^;\n]*DEFAULT|REDACTED_PIN/);
});
test('helpers nuevos con search_path fijo; rutinas globales sin grants cliente', () => {
  const output = sql();
  assert.match(output, /SET search_path TO pg_catalog, public, pg_temp/);
  assert.match(output, /REVOKE ALL ON FUNCTION public\."salud_negocios"\(\) FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(output, /GRANT EXECUTE ON FUNCTION public\."salud_negocios"\(\) TO authenticated/);
});
test('policies idempotentes y RLS habilitada; evita grants de truncate', () => {
  const output = sql();
  assert.match(output, /pg_catalog\.pg_policy/);
  assert.match(output, /ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(output, /GRANT .*TRUNCATE|GRANT .* TO anon/i);
});
test('FK capturadas no validan/falsifican historia existente automaticamente', () => {
  const output = sql();
  assert.match(output, /negocios_dueño_id_fkey[\s\S]*NOT VALID/);
  assert.doesNotMatch(output, /VALIDATE CONSTRAINT|UPDATE public\."negocios"/);
});
test('todas las PK/UNIQUE se crean antes de cualquier FK, sin depender del orden del catalogo', () => {
  const output = sql();
  const keys = catalog['03_constraints'].filter(c => ['p', 'u'].includes(c.type));
  const foreign = catalog['03_constraints'].filter(c => c.type === 'f');
  const position = c => output.indexOf(`ADD CONSTRAINT "${c.name}"`);
  assert.ok(Math.max(...keys.map(position)) < Math.min(...foreign.map(position)));
});
test('mismos catalogos => mismo SQL; cambios no incluidos de source ledger no se aceptan', () => {
  assert.equal(sql(), sql());
  const invalid = structuredClone(catalog);
  invalid['01_relations'].push({ relname: 'auth_users', relkind: 'r' });
  assert.throws(() => generateStagingBaseline(invalid, previous), /allowlist/i);
});
test('archivo versionado coincide con el generador offline revisado', async () => {
  const saved = await readFile(new URL('../../supabase/migrations/staging/20261002174025_pro00_staging_baseline.sql', import.meta.url), 'utf8');
  assert.equal(saved.replaceAll('\r\n', '\n'), sql().replaceAll('\r\n', '\n'));
});
test('SELECTs heredados no introducen whitespace final en el archivo SQL', () => {
  assert.equal(/[\t ]+\r?$/m.test(sql()), false);
});
