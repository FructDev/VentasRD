# Baseline exclusivo de Staging

Destino autorizado: **VentaRD Staging `blzzinivvzadqjbnpsre`**.
Estos archivos NO forman parte de un release ni bootstrap productivo.
No mover al directorio padre ni ejecutar `db push` de todo el repositorio
para reproducir PRO-00. Idempotencia no demuestra compatibilidad de entornos.

`20261002174025_pro00_staging_baseline.sql` fue creado con el CLI oficial
`npx supabase@2.119.0 migration new pro00_staging_baseline` y aislado aquí para
separarlo del conjunto productivo. Se aplicó el archivo completo por SQL Editor
en el proyecto verificado, no ALTERs sueltos. Aplicación manual NO significa
registro en `supabase_migrations.schema_migrations`: no se ejecutó repair/link/push
ni se modificó ese catálogo. Antes de una futura automatización hay que reconciliar
su historial explícitamente, sin inferir que Supabase CLI conoce esta aplicación.

Fuente: metadata public sanitizada autorizada; no dump de datos ni de todo
Auth/Storage. Generador offline `scripts/qa/pro00-baseline.mjs`, pruebas junto a él.
Conserva tablas/funciones v2 y datos anteriores; no corrige riesgos legacy.
Guardias exigen ledger v2 y exactamente los dos negocios sintéticos propios.
**Además siempre comprobar URL/proyecto**: una guardia de contenido no autentica
por sí sola el entorno.

Diferencias intencionales: PIN default omitido, nuevas funciones con search_path
fijo y grants acotados, policies nuevas para authenticated, dos FK previas NOT VALID.
Ver `docs/plan-pro/pro00/staging-baseline-verification.md` para hashes, ejecución,
errores, límites y pruebas de uso. No aplicar de nuevo seed/asignación Auth a ciegas.
