# Piloto Windows de producción — preparación local

Estado 2026-10-17: **instalador piloto 0.1.9 generado, firma/tamaño/SHA256 verificados y descarga local comprobada; no publicado ni instalado**. Producción conserva únicamente las dos consultas de lectura autorizadas; no se desplegó esquema, emisor ni claves. NCF permanece fuera. Esto no declara aceptados los datos comerciales reales de Pica Chicken.

Artefacto: `scratch/windows-production-distribution/0.1.9/VentaRD_0.1.9_x64-setup.exe`, **8.889.314 bytes**, SHA256 `2da2029abb2d643242de408a89ef64d419414a4d0201c1105d8981443223e1e1`. Binario release: SHA256 `c62d8d3c8910627c455dc21c53a28192813c66183fd4b15b35c7afe8997703af`. Evidencia vigente de entrega: `docs/native/evidence/production-release-local.json`; el paquete SQL inmutable anterior conserva su fotografía de preparación previa a la compilación.

## Destino y límites

- Web oficial: `https://ventard.vercel.app`; descarga prevista: `/descargar`.
- Supabase: `oxbekqoecunsbjheqgqg`; negocio piloto: Pica Chicken, `864d08e5-2975-4b2d-a1e2-ba5a14f3d677`.
- La auditoría autorizada encontró licencia **Básico** y ningún objeto nativo. No se cambió el plan. El emisor lee `plan_activo`, `plan_tier`, `acceso_hasta` y `trial_hasta` reales.
- La aplicación de producción usa `com.ventard.pos`, bóveda `production-access-v1`, sesión protegida y confianza firmada propias. QA conserva `com.ventard.pos.qa`, perfiles, catálogo y sesiones anteriores. No copiar perfiles de QA para representar el negocio real.
- La entrega sigue limitada al piloto. No habilita automáticamente otros negocios ni usuarios nuevos. Durante este piloto web/app no emitirán nuevos NCF; se conservan los comprobantes históricos.

## Esquema preparado

Sólo estas migraciones nuevas, creadas con CLI y versionadas junto a sus consumidores:

1. `20261017125853_native_production_access_v1.sql`: cohorte vacía, instalaciones/permisos y vista de licencia real. No siembra usuarios, licencias ni negocios.
2. `20261017130229_native_production_operations_v1.sql`: protocolo operativo y diario común, reconciliación/historia/servicios, protección de escritores anteriores y denegación fiscal. La activación directa de QA está revocada; la entrada operativa requiere el corte revisado y recuperable.

`node scripts/native/prepare-production-release.mjs` produce `scratch/production-release-review/<hash>/review.json` y copia únicamente esas dos migraciones. No conecta a Supabase ni ejecuta cambios. `prepare-production-operations.mjs --check` comprueba las fuentes exactas del SQL consolidado.

**No ejecutar `db push` desde la raíz ni promover el historial completo de Staging.** Antes de un despliegue autorizado hay que comparar el historial remoto y revisar que el plan enumere exclusivamente esas dos versiones. No reparar versiones ausentes ni incorporar semillas QA implícitamente. El paquete de revisión no trae credenciales ni un enlace activo a producción.

Aplicar esquema no habilita la cohorte, registra equipos, publica el instalador ni corta el negocio. Cualquiera de esas operaciones remotas requiere autorización específica.

## Entrega y actualización

Las plantillas públicas están en `scripts/native/production-public-config.example.json` y `production-updates.example.json`. Los marcadores son deliberadamente inválidos: no acreditan una clave ni una licencia. La preparación local genera claves Ed25519 y Tauri nuevas, distintas de QA, y las conserva bajo DPAPI CurrentUser en `scratch/production-signing/`, excluido de Git. La llave Tauri sólo pasa por una carpeta temporal del sistema durante su generación; nunca se escribe en claro en OneDrive ni se imprime. Reabrir la custodia conserva la misma confianza; archivos incompletos o alterados se rechazan. No se subieron claves. DPAPI depende del usuario/perfil de Windows: antes de publicar hay que conservar una custodia recuperable independiente; copiar únicamente los archivos DPAPI a otro PC no demuestra recuperación. La rotación de confianza necesita un procedimiento separado.

El emisor preparado es `supabase/functions/native-provision/index.ts`. Requiere configuración del proyecto exacto, clave pública de Supabase y clave privada Ed25519 del emisor **sólo como secreto del servidor**. Verifica Auth y registra usando el JWT del mismo usuario; no usa `service_role`. Un proyecto, entorno o clave incompletos lo dejan deshabilitado. No se desplegó ni trasladó ninguna clave de producción.

La preparación y compilación local selecciona únicamente la URL/clave pública del proyecto exacto en `.env.local`; no utiliza su clave de servicio. Escribe la configuración pública real, recupera la llave del actualizador sólo en memoria y construye una entrega release, con IPC sin comandos QA/fiscal y protección contra downgrade:

```powershell
node scripts/native/build-production-local.mjs --prepare-only
node scripts/native/build-production-local.mjs
```

El segundo comando genera y verifica `scratch/windows-production-distribution/0.1.9/` y `scratch/production-release.json`. Si existe un paquete con la misma configuración, vuelve a verificar sus bytes/firma y conserva el manifiesto; no recompila ni rota claves silenciosamente. El empaquetador separado sigue disponible para compilación con configuración explícita:

```powershell
node scripts/native/package-windows-production.mjs --version 0.1.9 --public-config scratch/production-public-config.json --updates scratch/production-updates.json
```

La firma del actualizador usa `TAURI_SIGNING_PRIVATE_KEY` y, cuando corresponda, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` en el entorno privado de compilación. No guardar secretos en las plantillas públicas ni en `NEXT_PUBLIC_*`. La firma de Windows se configura aparte; no se afirma que exista un certificado comercial.

Después de compilar, `desktop-release.mjs` verifica con Minisign los bytes y la versión firmada, compara SHA256/tamaño con el manifiesto y prepara el JSON público:

```powershell
cargo build --release -p ventard-pos --bin ventard-release-verify --features release-tools --locked
node scripts/native/desktop-release.mjs --manifest scratch/windows-production-distribution/0.1.9/package.json --installer RUTA_INSTALADOR --signature RUTA_INSTALADOR.sig --updates scratch/production-updates.json --url https://ventard.vercel.app/downloads/windows-x86_64/0.1.9/VentaRD.exe --output scratch/production-release.json
```

La URL del artefacto es configurable y debe existir realmente antes de publicar. Puede servirse como archivo estático del dominio oficial; el empaquetador no lo sube. Configuración del servidor web al publicar: `VENTARD_DESKTOP_RELEASE_CHANNEL=production`, `VENTARD_DESKTOP_DOWNLOAD_ORIGIN` y `VENTARD_DESKTOP_RELEASE_JSON` verificado. Sin una publicación válida, la página informa que no hay descarga, el endpoint de versiones devuelve 204 y la descarga 503.

Para revisar la misma página definitiva en este PC, sin desplegarla:

```powershell
node scripts/native/open-desktop-preview.mjs --serve
node --test scripts/native/download-local-preview.test.mjs
```

Abrir `http://127.0.0.1:3023/descargar`. El servidor se mantiene en la terminal, sólo escucha en loopback y usa la configuración pública Staging ya existente; no necesita iniciar sesión. Reutiliza el caché local de fuentes de las pruebas previas. La descarga local exige `VENTARD_DESKTOP_LOCAL_PREVIEW=1`, manifiesto/archivo fijos, tamaño y SHA256 coincidentes; rechaza otro origen, rutas variables o archivos alterados. Sin esa bandera, las rutas conservan el comportamiento publicado normal. La página muestra explícitamente que la revisión es local y que Pica Chicken todavía no está habilitado; no presenta enlaces de acceso para confundir esa revisión con una sesión del negocio real.

El usuario descarga e instala una vez, entra con su cuenta existente, selecciona el negocio/sucursal y crea su PIN. Tras la preparación inicial, conserva catálogo e historia local y vuelve a entrar con el PIN. Las siguientes actualizaciones mantienen identidad y datos; no desinstalar antes. En Ajustes se comprueba la versión, el usuario confirma y el broker verifica la firma; rechaza instalar con carrito/intento/operaciones pendientes. Windows cierra la app para instalar.

## Entrada real al piloto, todavía pendiente

1. Obtener autorización específica para esquema, emisor/claves, publicación y habilitación de **este único negocio**; comprobar historial y respaldo recuperable antes del despliegue.
2. Instalar la entrega verificada y habilitar únicamente la cohorte aprobada para registrar la cuenta/equipo reales. Capturar y revisar nube completa: catálogo, historia, deudas, caja y servicios. La auditoría ejecutada fue de estructura/licencia, no leyó esos datos ni demuestra sus saldos.
3. Cerrar escritores/cajas anteriores, conservar cualquier pendiente y verificar el respaldo cifrado ligado a la revisión. Confirmar el corte desde Ajustes; no repetir ventas antiguas para incorporarlas.
4. Publicar/activar el canal web compartido sólo para el piloto (`NEXT_PUBLIC_VENTARD_SHARED_JOURNAL=production-pilot`), preparar el navegador y comprobar ventas/recepción/reintentos reales con el mismo diario. Los demás negocios conservan su flujo anterior.

Un negocio ya cortado no debe volver a los escritores anteriores ni perder su diario. Ante un problema, detener nuevas escrituras, conservar respaldos/pendientes y corregir hacia delante o ejecutar una recuperación revisada; no borrar tablas, reparar historia a ciegas ni reinstalar una versión anterior.

## Verificación local

PostgreSQL aislado reproduce las **18 tablas, 247 columnas y 31 restricciones** inspeccionadas, con registros exclusivamente sintéticos. Comprueba DDL repetido, licencia Básico sin modificar, aislamiento, corte revisado, bloqueo ante tabla ausente, ventas web/app, recibos estables, replay, recepción de historia/stock y denegación fiscal. No equivale a aceptación del negocio real.

Además: permisos firmados cruzados Staging/producción, bootstrap y recepción locales; regresión del broker y custodia Windows; firma Tauri real con claves efímeras y verificación del instalador candidato con la confianza nueva; contratos de empaquetado; pantallas definitivas en Chromium y `/descargar` en Next con sesión vacía.

Aceptación local de entrega: **7 contratos de empaquetado/actualización**, **4 tests de custodia, configuración pública y firma real**, **6 contratos de catálogo/descarga** y **1 recorrido de descarga real en Chromium PASS**. El navegador descargó los 8.889.314 bytes con el mismo SHA256, sin sesión ni solicitudes remotas; escritorio/móvil sin desbordamiento. Next normaliza internamente la URL a localhost: se valida también el Host loopback real y se rechazan hosts ajenos. El verificador de firmas usa la feature separada `release-tools` y no se incluye en el instalador del usuario. Reanudar la preparación conserva paquete, claves y fecha del manifiesto y vuelve a verificar la firma, sin recompilar. La inspección en memoria no encontró los bytes crudos de las dos claves privadas propias en ejecutable/instalador. Typecheck web/nativo, Vite y lint del alcance PASS. No se instaló una actualización real de producción, no hay certificado comercial de firma de Windows ni enlace público desplegado.
