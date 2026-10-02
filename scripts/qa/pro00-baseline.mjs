// Generacion OFFLINE de SQL para Staging. No red, credenciales ni ejecucion SQL.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TABLES = new Set('apartados cajas clientes composiciones cortes_caja detalles_ventas devoluciones gastos inventario_sucursales movimientos_stock ncf_secuencias negocios pagos_log productos reparaciones seriales sucursales transacciones_fiado usuarios_negocio venta_detalles ventas'.split(' '));
const FUNCTIONS = new Set('aplicar_movimiento_stock configurar_ncf es_admin_del_negocio es_miembro_del_negocio get_negocio_id handle_new_user mis_negocio_ids normalizar_fecha_actualizacion reservar_ncf salud_negocios total_ventas_negocio'.split(' '));
const CLIENT_FUNCTIONS = new Set(['get_negocio_id','mis_negocio_ids','reservar_ncf','configurar_ncf']);
const ident = s => `"${String(s).replaceAll('"','""')}"`;
const literal = s => `'${String(s).replaceAll("'","''")}'`;
const table = s => `public.${ident(s)}`;
const argumentTypes = f => f.arguments ? f.arguments.split(',').map(p => p.trim().split(/\s+/).slice(1).join(' ')).join(', ') : '';

export function parseCatalogCsv(input) {
  const rows = []; let row = [], value = '', quoted = false;
  const text = input.replace(/^\uFEFF/,'');
  for (let i=0;i<text.length;i++) {
    const char=text[i];
    if (char==='"') {
      if (quoted && text[i+1]==='"') { value+='"';i++; }
      else quoted=!quoted;
    } else if (char===',' && !quoted) { row.push(value);value=''; }
    else if (char==='\n' && !quoted) { row.push(value.replace(/\r$/,''));rows.push(row);row=[];value=''; }
    else value+=char;
  }
  if (quoted) throw new Error('CSV truncado');
  if (value || row.length) { row.push(value.replace(/\r$/,''));rows.push(row); }
  const headers=rows.shift();
  if (!headers?.includes('section') || !headers.includes('evidence')) throw new Error('CSV sin encabezados');
  const result={};
  for (const cells of rows) {
    if (cells.length!==headers.length) throw new Error('CSV fila incompatible');
    const record=Object.fromEntries(headers.map((h,i)=>[h,cells[i]]));
    if (Object.hasOwn(result,record.section)) throw new Error('CSV seccion duplicada');
    const evidence=JSON.parse(record.evidence);
    if (!Array.isArray(evidence)) throw new Error('CSV evidencia no es array');
    if (record.object_count!==undefined && Number(record.object_count)!==evidence.length) throw new Error('CSV count incompatible');
    result[record.section]=evidence;
  }
  return result;
}

export function generateStagingBaseline(source, staging) {
  const relations=source['01_relations'];
  if (!Array.isArray(relations) || relations.length!==TABLES.size || relations.some(r=>!TABLES.has(r.relname)||r.relkind!=='r')) throw new Error('Schema fuera de allowlist');
  if (source['10_sequences']?.length || source['11_views']?.length || source['12_types']?.length || source['16_partitions']?.length) throw new Error('Objetos no soportados; revisar diseno');
  if (source['08_functions'].some(f=>!FUNCTIONS.has(f.name))) throw new Error('Funcion fuera de allowlist');
  const existing=new Set(staging['01_relations'].map(r=>r.relname));
  const oldFunctions=new Set(staging['08_functions'].map(f=>`${f.name}(${f.arguments})`));
  const output=[`-- PRO-00 STAGING-ONLY: blzzinivvzadqjbnpsre. NO incluir en release productivo.
-- Fuente: captura public sanitizada 2026-10-02; no contiene datos comerciales.
-- Repetible/aditiva. FK a tablas preexistentes NOT VALID: validar por separado.
-- PIN default omitido por redaccion; no se fabrica historia ni se ajusta stock.
BEGIN;
DO $pro00_guard$
BEGIN
  IF pg_catalog.to_regclass('public.inventario_operaciones_v2') IS NULL
    OR (SELECT count(*) FROM public.negocios
      WHERE (id='96000000-0000-4000-8000-000000000001'::uuid AND nombre='PRO00 QA A - SINTETICO')
         OR (id='96000000-0000-4000-8000-000000000002'::uuid AND nombre='PRO00 QA B - SINTETICO'))<>2
  THEN RAISE EXCEPTION 'PRO00_STAGING_GUARD_FAILED'; END IF;
END;
$pro00_guard$;`];
  for (const relation of relations) {
    const cols=source['02_columns'].filter(c=>c.table_name===relation.relname).sort((a,b)=>a.ordinal_position-b.ordinal_position);
    if (!cols.length || cols.some(c=>c.identity_kind||c.generated_kind||c.type_schema!=='pg_catalog')) throw new Error('Columnas requieren adaptacion explicita');
    const declaration=c=>`${ident(c.column_name)} ${c.formatted_type}${c.default_expression && !c.default_expression_redacted ? ` DEFAULT ${c.default_expression}`:''}${c.not_null?' NOT NULL':''}`;
    output.push(`CREATE TABLE IF NOT EXISTS ${table(relation.relname)} (\n  ${cols.map(declaration).join(',\n  ')}\n);`);
    if (existing.has(relation.relname)) {
      for (const col of cols) {
        const previous=staging['02_columns'].find(c=>c.table_name===col.table_name&&c.column_name===col.column_name);
        if (!previous) output.push(`ALTER TABLE ${table(col.table_name)} ADD COLUMN IF NOT EXISTS ${declaration(col)};`);
        // Tipos/nullability de columnas existentes nunca se convierten en silencio.
      }
    }
  }
  // Las claves referenciadas deben existir en TODAS las tablas antes de las FK.
  const constraints = [...source['03_constraints']].sort((a,b) =>
    Number(a.type === 'f') - Number(b.type === 'f'));
  for (const constraint of constraints) {
    let definition=constraint.definition.replace(/REFERENCES (?!public\.|auth\.)([a-z_]+)(?=\()/g,'REFERENCES public.$1');
    if (constraint.type==='f' && existing.has(constraint.table_name)) definition+=' NOT VALID';
    output.push(`DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid=${literal(table(constraint.table_name))}::pg_catalog.regclass AND conname=${literal(constraint.name)}) THEN
    ALTER TABLE ${table(constraint.table_name)} ADD CONSTRAINT ${ident(constraint.name)} ${definition};
  END IF;
END; $pro00_constraint$;`);
  }
  for (const index of source['04_indexes']) {
    if (source['03_constraints'].some(c=>c.table_name===index.table_name&&c.name===index.name&&['p','u'].includes(c.type))) continue;
    output.push(`${index.definition.replace(/CREATE (UNIQUE )?INDEX /,'CREATE $1INDEX IF NOT EXISTS ')};`);
  }
  for (const fn of source['08_functions']) {
    if (oldFunctions.has(`${fn.name}(${fn.arguments})`)) continue;
    if (fn.definition.includes('$pro00_function$')) throw new Error('Delimitador incompatible');
    const signature=`public.${ident(fn.name)}(${argumentTypes(fn)})`;
    const definition=fn.definition.replace(`CREATE OR REPLACE FUNCTION public.${fn.name}`,`CREATE FUNCTION public.${ident(fn.name)}`)
      .replace(/^ SET search_path[^\n]*\n/gm,'')
      .replace(/AS \$function\$/, 'SET search_path TO pg_catalog, public, pg_temp\nAS $function$')
      // Solo dos SELECT del helper capturado; no tocar literales SQL multilinea.
      .replace(/^([ \t]+SELECT (?:id|negocio_id)::text FROM public\.(?:negocios|usuarios_negocio))[ \t]+(?=\r?$)/gm, '$1');
    output.push(`DO $pro00_function$ BEGIN
  IF pg_catalog.to_regprocedure(${literal(signature)}) IS NULL THEN
    EXECUTE $pro00_definition$${definition}$pro00_definition$;
    REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION ${signature} TO service_role;${CLIENT_FUNCTIONS.has(fn.name)?`\n    GRANT EXECUTE ON FUNCTION ${signature} TO authenticated;`:''}
  END IF;
END; $pro00_function$;`);
  }
  for (const trigger of source['05_triggers']) {
    const target=`${trigger.schema}.${ident(trigger.table_name)}`;
    const definition=trigger.definition.replace(` ON ${trigger.table_name} `,` ON ${target} `)
      .replace(`EXECUTE FUNCTION ${trigger.function_name}(`,`EXECUTE FUNCTION public.${ident(trigger.function_name)}(`);
    output.push(`DO $pro00_trigger$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=${literal(target)}::pg_catalog.regclass AND tgname=${literal(trigger.name)}) THEN
    ${definition};
  END IF;
END; $pro00_trigger$;`);
  }
  for (const relation of relations) {
    output.push(`ALTER TABLE ${table(relation.relname)} ENABLE ROW LEVEL SECURITY;`);
    if (!existing.has(relation.relname)) {
      output.push(`REVOKE ALL ON TABLE ${table(relation.relname)} FROM anon, authenticated;\nGRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table(relation.relname)} TO authenticated, service_role;`);
    }
  }
  for (const policy of source['06_policies']) {
    const sql=`CREATE POLICY ${ident(policy.policyname)} ON ${table(policy.tablename)} AS ${policy.permissive} FOR ${policy.cmd} TO authenticated${policy.qual?` USING (${policy.qual})`:''}${policy.with_check?` WITH CHECK (${policy.with_check})`:''};`;
    output.push(`DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=${literal(table(policy.tablename))}::pg_catalog.regclass AND polname=${literal(policy.policyname)}) THEN
    ${sql}
  END IF;
END; $pro00_policy$;`);
  }
  output.push('COMMIT;');
  return `${output.join('\n\n')}\n`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const source=parseCatalogCsv(await readFile('docs/plan-pro/pro00/source-catalog-2026-10-02.sanitized.csv','utf8'));
  const staging=parseCatalogCsv(await readFile('docs/plan-pro/pro00/staging-catalog-2026-10-02.csv','utf8'));
  process.stdout.write(generateStagingBaseline(source,staging));
}
