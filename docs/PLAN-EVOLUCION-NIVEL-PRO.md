# Plan de evolución VentaRD nivel Pro

Estado: propuesta de arquitectura y ejecución. Este documento no autoriza cambios directos en producción.

## 1. Objetivo

Evolucionar VentaRD desde una PWA offline-first funcional hacia un POS local-first observable, recuperable y preparado para 50–100 dispositivos concurrentes, sin interrumpir a los negocios actuales ni romper la comunicación entre módulos.

El resultado esperado no es solo que “se sienta rápido”. Debe poder demostrarse que:

- una operación aceptada localmente no desaparece;
- la caja puede seguir trabajando durante una interrupción;
- los dispositivos conectados convergen al mismo estado;
- un reintento nunca duplica una venta, un cobro o un movimiento de stock;
- un error aislado no bloquea el resto de la sincronización;
- el usuario puede ver qué está local, pendiente, confirmado o en conflicto;
- una versión antigua de la PWA no rompe una migración nueva;
- se puede revertir cada despliegue sin perder operaciones.

## 2. Principios no negociables

1. **Local primero:** el camino crítico de venta nunca espera a la red.
2. **Una operación de negocio, una identidad:** venta, devolución, apartado, reparación o ajuste tendrá un `operation_id` estable e idempotente.
3. **Atomicidad funcional:** los efectos relacionados se confirman juntos localmente y, cuando aplique, juntos en el servidor.
4. **Realtime acelera, no garantiza:** los eventos en vivo despiertan el sync; un cursor durable recupera cualquier evento perdido.
5. **Compatibilidad expand/contract:** primero se agregan capacidades, luego se migra tráfico y solo al final se retira lo antiguo.
6. **Nada destructivo durante la transición:** no borrar columnas, tablas ni datos mientras exista una versión antigua activa.
7. **Observabilidad antes de optimizar:** cada mejora tendrá métricas de antes y después.
8. **Despliegue por negocio/dispositivo:** activar con feature flags y poder retroceder sin publicar una emergencia.
9. **Supabase versionado:** todo cambio de esquema irá en `supabase/migrations/`, idempotente y junto al código compatible.
10. **Sin reescritura total:** aprovechar Dexie, Zustand, Supabase, PWA y los modelos actuales; sustituir componentes por etapas.

## 3. Mapa funcional que debe conservarse

| Dominio | Datos principales | Módulos consumidores | Invariantes que no se pueden romper |
|---|---|---|---|
| Ventas | `ventas`, `venta_detalles` | POS, historial, dashboard, reportes, asistente, tickets, caja | Una venta no se duplica; total = suma de detalles; ticket único por terminal |
| Inventario | `productos`, `composiciones`, `movimientos_stock`, `inventario_sucursales` | POS, inventario, reparaciones, apartados, devoluciones, catálogo | Cada salida/entrada tiene movimiento auditable; reintentos no alteran dos veces |
| Seriales/IMEI | `seriales` | POS, inventario, garantías, reparaciones, apartados | Un serial solo puede estar en un estado operativo; no puede venderse dos veces sin conflicto visible |
| Clientes y fiado | `clientes`, `transacciones_fiado` | clientes, POS, dashboard, historial, apartados, reparaciones | Saldo = cargos − abonos; cada cargo/abono conserva referencia y autor |
| Caja | `cajas`, `cortes_caja`, ventas, gastos, pagos Pro | apertura/cierre, cortes X/Z, dashboard, reportes | Efectivo esperado se deriva de movimientos del turno; cerrar no borra trazabilidad |
| Gastos | `gastos` | caja, dashboard, historial, reportes | Un gasto en efectivo afecta caja exactamente una vez |
| Reparaciones | `reparaciones`, movimientos, clientes, seriales | reparaciones, garantías, dashboard, historial, caja, reportes | Estados y bitácora preservados; repuestos y pagos impactan una sola vez |
| Apartados | `apartados`, movimientos, clientes, seriales | apartados, dashboard, historial, caja, reportes | Reserva/liberación de stock y abonos son idempotentes y auditables |
| Devoluciones | `devoluciones`, movimientos, fiado, seriales | historial, inventario, caja, reportes | No devolver más de lo vendido; stock y fiado se revierten una vez |
| Sucursales/equipos | `sucursales`, `usuarios_negocio`, dispositivo local | autenticación, permisos, inventario, caja, numeración | Aislamiento por negocio y sucursal; identidad estable por terminal |
| NCF y tickets | `ncf_secuencias`, bloques locales, contador de ticket | POS, impresión, reportes | Sin duplicados; cada terminal trabaja con un rango seguro offline |
| Planes y acceso | negocio, plan, roles, PIN | todos los módulos protegidos | Offline no eleva permisos ni habilita módulos no contratados |
| Catálogo público | productos publicados | catálogo y API pública | Solo expone datos autorizados; no depende del sync interno del visitante |
| Exportes/reportes | datos agregados de todos los dominios | reportes, Excel/PDF, asistente | Totales reproducibles a partir de operaciones confirmadas y pendientes identificadas |

## 4. Contratos de operaciones críticas

Antes de refactorizar se escribirán contratos de dominio. Estos contratos serán la referencia de pruebas, sincronización y compatibilidad.

### 4.1 Confirmar venta

Entrada mínima:

- `operation_id`, negocio, sucursal, terminal, usuario;
- ticket local y NCF si aplica;
- artículos, cantidades, precios y seriales;
- método y desglose de pago;
- cliente/fiado si aplica;
- fecha local y versión del protocolo.

Efectos atómicos locales:

- crear venta y detalles;
- crear cargo de fiado si corresponde;
- consumir/reservar seriales;
- crear movimientos de stock;
- registrar efecto de caja;
- crear una entrada outbox;
- persistir el siguiente ticket.

No se imprimirá ni mostrará “Venta completada” hasta que la transacción local termine. No se esperará confirmación de Supabase.

### 4.2 Devolver o anular venta

- referencia obligatoria a venta y cantidades originales;
- impedir devolución acumulada superior a lo vendido;
- reponer stock/serial;
- revertir fiado o caja según método;
- crear devolución y outbox con el mismo `operation_id` en todos sus efectos.

### 4.3 Reparación

- crear/editar orden sin perder bitácora;
- pagos como eventos individuales, no solo como un arreglo reemplazable;
- consumo/devolución de repuestos mediante movimientos idempotentes;
- entrega, garantía, rechazo, cancelación y despiece como comandos explícitos.

### 4.4 Apartado

- creación reserva stock y serial;
- cada abono es un evento individual;
- completar convierte la reserva en salida definitiva sin descontar otra vez;
- cancelar libera exactamente lo reservado.

### 4.5 Caja

- apertura y cierre identificados por operación;
- ventas, gastos, abonos de apartados y pagos de reparaciones referencian caja/turno;
- corte X es lectura; corte Z/cierre es un evento persistente;
- los totales se reconstruyen sin depender de valores mutables de la interfaz.

## 5. Objetivos de servicio (SLO)

| Indicador | Objetivo inicial | Objetivo Pro |
|---|---:|---:|
| Confirmar venta local, p95 | < 500 ms | < 300 ms |
| Agregar producto por código, p95 | < 150 ms | < 80 ms |
| Abrir POS con caché preparada, p95 | < 2 s | < 1 s |
| Propagación A → B con ambas online, p95 | < 5 s | < 2 s |
| Propagación A → B, p99 | < 15 s | < 5 s |
| Convergencia después de reconectar | < 60 s | < 15 s para cola normal |
| Operaciones duplicadas por reintento | 0 | 0 |
| Operaciones perdidas silenciosamente | 0 | 0 |
| Ciclo de sync sin cambios | < 1 solicitud útil/minuto | orientado a eventos |
| Tareas largas de UI > 200 ms durante venta | 0 | 0 |

Los SLO se medirán por versión, negocio, dispositivo y tipo de operación, sin registrar información sensible del comprador.

## 6. Estrategia de evolución por fases

Cada fase tiene una puerta de entrada, pruebas obligatorias, activación gradual y criterio de reversión. No se comienza la siguiente si la anterior no es estable.

### Fase 0 — Línea base, respaldo y mapa de versiones

Objetivo: conocer el comportamiento real antes de modificarlo.

Trabajo:

- instrumentar duración de inicio, cobro, consultas Dexie y ciclos de sync;
- contar filas y pendientes por tabla;
- registrar versión de app, protocolo, Dexie y esquema remoto por dispositivo;
- medir latencia Supabase y desconexiones Realtime;
- crear diagnóstico exportable desde Estado del sistema;
- inventariar el esquema real de producción y compararlo con migraciones;
- incorporar a migraciones cualquier tabla, función, índice, RLS o publicación que hoy solo viva en scripts históricos;
- definir respaldo y restauración comprobada de Supabase;
- preparar datos anonimizados de volumen pequeño, medio y grande.

Salida obligatoria:

- tablero de línea base;
- matriz de esquema real vs. repositorio;
- lista de versiones activas;
- prueba documentada de restauración;
- cero cambios en reglas de negocio.

### Fase 1 — Camino crítico del POS

Objetivo: cobrar rápido sin alterar todavía el protocolo de sincronización.

Trabajo:

- reemplazar el recorrido completo de ventas por un contador de ticket por terminal;
- conservar el ticket generado, sin volver a calcularlo después del commit;
- cargar productos y composiciones del carrito por lote;
- usar `bulkAdd`/`bulkPut` dentro de una transacción Dexie corta;
- evitar lecturas repetidas de los mismos productos;
- separar impresión, UI secundaria y sync del commit crítico;
- mantener exactamente los mismos registros finales actuales;
- medir y alertar ventas locales superiores al SLO.

Protección:

- ejecutar en pruebas el flujo antiguo y el nuevo con la misma entrada;
- comparar venta, detalles, stock, serial, fiado, caja, ticket y NCF;
- feature flag `checkout_v2` por negocio/dispositivo;
- activar primero en un dispositivo interno, luego en el tester y finalmente en los demás.

Rollback: desactivar `checkout_v2`; los datos conservan el formato anterior.

### Fase 2 — Capa de comandos de dominio

Objetivo: evitar que cada pantalla modifique tablas relacionadas por su cuenta.

Crear servicios locales para:

- `confirmarVenta`;
- `devolverVenta`;
- `ajustarInventario`;
- `crear/abonar/completar/cancelarApartado`;
- `crear/actualizar/entregar/cancelarReparacion`;
- `registrarPagoReparacion`;
- `abrir/cerrarCaja`;
- `registrarGasto`;
- `crear/abonarFiado`.

Las pantallas llamarán comandos; los comandos serán los únicos dueños de las transacciones e invariantes. Primero se extrae el comportamiento actual sin cambiar resultados.

Salida obligatoria:

- pruebas contractuales por comando;
- ninguna escritura crítica dispersa fuera de la capa de dominio;
- resultados equivalentes al comportamiento aprobado de Fase 1.

### Fase 3 — Outbox durable y Sync v2 en modo sombra

Objetivo: representar operaciones pendientes de forma explícita sin retirar el sync actual.

Cambios aditivos:

- tabla Dexie `outbox_operaciones`;
- estados `pendiente`, `enviando`, `confirmada`, `reintento`, `error_permanente`;
- `operation_id`, tipo, payload versionado, intentos y último error;
- coordinador con push prioritario e inmediato;
- endpoint/RPC idempotente que acepte operaciones por lote;
- recibo del servidor con operaciones aceptadas/rechazadas;
- panel de estado completo para el usuario y soporte.

Transición:

- los comandos continúan marcando `estado_sincronizacion` como hoy;
- simultáneamente crean outbox cuando el flag está activo;
- Sync v2 corre inicialmente en modo sombra: calcula y registra qué haría, pero Sync v1 sigue siendo quien publica;
- se comparan resultados antes de permitir que v2 escriba.

Rollback: apagar Sync v2; Sync v1 sigue comprendiendo todos los registros.

### Fase 4 — Ingesta atómica en servidor

Objetivo: que una operación llegue completa y sea segura ante reintentos.

Trabajo:

- registrar `operation_id` con restricción única;
- RPC/endpoint transaccional para venta completa;
- operaciones equivalentes para devolución, apartado, reparación, caja, gasto y fiado;
- responder el mismo resultado si se reenvía una operación ya aceptada;
- errores por fila/operación, nunca fallo silencioso del lote;
- tabla de operaciones rechazadas auditable por soporte;
- límites de payload, permisos y validación por negocio/sucursal/rol.

Compatibilidad:

- servidor acepta protocolo v1 y v2;
- columnas nuevas son opcionales durante la transición;
- migración de base primero, backend compatible después, cliente al final;
- ninguna versión antigua queda bloqueada.

### Fase 5 — Change feed durable y convergencia entre equipos

Objetivo: garantizar recuperación de cambios aunque Realtime pierda eventos.

Cambios aditivos en servidor:

- registro ordenado `sync_changes` con secuencia monotónica;
- negocio, sucursal, entidad, registro, operación y tipo de cambio;
- endpoint paginado “cambios después del cursor”;
- cursor por negocio + dispositivo, nunca global por navegador;
- retención suficiente y mecanismo de bootstrap cuando el cursor sea demasiado antiguo.

Cliente:

- Realtime solo anuncia “hay novedades”;
- el cliente lee el change feed desde su último cursor confirmado;
- aplica cada página en una transacción Dexie;
- avanza el cursor únicamente después del commit;
- pull ligero al iniciar, recuperar conexión y en intervalos de seguridad;
- reconciliación completa solo como reparación excepcional.

Garantía resultante: si una operación está confirmada por el servidor, todos los dispositivos autorizados terminarán recibiéndola aunque hayan perdido el websocket o estado apagados.

### Fase 6 — Consistencia de stock, seriales y concurrencia

Objetivo: hacer explícitas las reglas imposibles de resolver únicamente con sincronización.

Productos comunes:

- mantener deltas atómicos e idempotentes;
- política configurable para permitir o impedir stock negativo;
- detectar y mostrar conflictos posteriores a ventas offline;
- conservar kardex por operación, dispositivo, usuario y sucursal.

Seriales/IMEI:

- restricción única de estado/venta activa en servidor;
- reserva de serial con versión cuando haya conexión;
- catálogo local indica `confirmado`, `reservado_local` o `posible_conflicto`;
- si dos cajas vendieron el mismo IMEI offline, no ocultar el problema: bloquear la sincronización de la segunda operación y abrir resolución asistida;
- nunca descartar el movimiento ni reemplazar silenciosamente al ganador.

Conteos físicos:

- un conteo absoluto debe llevar versión/base conocida;
- si hubo movimientos posteriores, solicitar conciliación en vez de pisarlos.

### Fase 7 — Rendimiento de todos los módulos

Objetivo: que el costo dependa de lo visible, no de toda la historia acumulada.

| Módulo | Trabajo específico |
|---|---|
| POS | índices de búsqueda estables, catálogo incremental, carrito por lotes, seriales por producto/estado |
| Inventario | agrupar composiciones una vez, paginar, índices compuestos, historial bajo demanda |
| Clientes/fiado | saldos agrupados en una pasada o resumen materializado; transacciones por cliente y período |
| Dashboard | consultas por período, agregados locales incrementales, evitar cargar reparaciones/apartados completos |
| Historial | paginación real por cursor, detalles solo de ventas visibles, filtros indexados |
| Caja | consultas por caja/turno, pagos Pro y gastos indexados, resumen incremental |
| Reparaciones | índices por negocio/sucursal/estado/fecha; bitácora y pagos como eventos consultables |
| Apartados | índices por negocio/sucursal/estado/fecha; abonos separados si el volumen lo requiere |
| Garantías/seriales | índices por serial, producto, estado y fecha; evitar escaneos del negocio completo |
| Gastos | rango compuesto negocio/fecha y caja/sucursal |
| Reportes/exportes | ejecución fuera del camino del POS, progreso visible, datos por rango y lotes |
| Asistente | snapshots/resúmenes; no recalcular toda la historia con cada escritura |
| Admin/equipo | consultas remotas puntuales y cacheadas; no mezclarlas con el sync operativo |
| Catálogo público | endpoint paginado/cacheado separado del POS autenticado |

Los índices Dexie requieren una nueva versión aditiva. Los índices PostgreSQL se entregan mediante migraciones versionadas y se validan con `EXPLAIN ANALYZE` sobre volúmenes representativos.

### Fase 8 — Ejecución en segundo plano y control de recursos

Objetivo: impedir que mantenimiento y sincronización degraden la caja.

- separar coordinador, transporte y aplicador de cambios;
- mover transformación pesada a un Web Worker real cuando las métricas lo justifiquen;
- limitar concurrencia de red y tamaño de lotes;
- pausar mantenimiento durante cobro, impresión y escaneo;
- usar prioridad: operación crítica > cambios recientes > catálogos > reconciliación > purga;
- no ejecutar ciclos vacíos cada 15 segundos;
- limpieza local incremental y ociosa;
- presupuestos de CPU, memoria, almacenamiento y red por dispositivo.

### Fase 9 — Preparación para escala y operación

Objetivo: validar 100 dispositivos y establecer disciplina de producción.

- pruebas de carga con 100 dispositivos simulados y varios negocios;
- pruebas de caos: latencia, pérdida de paquetes, 401, 429, 5xx, timeout y websocket caído;
- cerrar/reabrir app en cada punto crítico;
- actualización de PWA con operaciones pendientes;
- dispositivo varios días offline y recuperación paginada;
- runbooks de soporte y recuperación;
- alertas por cola envejecida, deriva de stock, errores permanentes y versiones obsoletas;
- tablero de SLO y revisión semanal durante expansión.

## 7. Estrategia de compatibilidad y despliegue

### 7.1 Orden obligatorio de cada cambio

1. Migración aditiva de Supabase.
2. Servidor compatible con clientes antiguos y nuevos.
3. Cliente nuevo con función desactivada.
4. Activación interna.
5. Activación en dispositivo piloto.
6. Activación por porcentaje/negocio.
7. Confirmación de métricas y datos.
8. Retiro de comportamiento anterior solo después de demostrar adopción.

### 7.2 Versiones de protocolo

Cada operación enviará `protocol_version`. El servidor deberá:

- aceptar al menos la versión actual y la anterior;
- responder capacidades soportadas;
- rechazar de forma explicable, nunca ignorar campos silenciosamente;
- permitir que un cliente antiguo siga vendiendo durante el despliegue;
- informar si requiere actualización antes de una futura ruptura.

### 7.3 Particularidad PWA

Una PWA puede conservar código antiguo en caché. Por eso:

- una migración nunca asumirá que todos actualizaron al mismo tiempo;
- el Service Worker no forzará recarga mientras haya operaciones pendientes;
- la nueva versión se instalará en espera y se activará en un punto seguro;
- se mostrará “Actualización lista” y se verificará el outbox antes de recargar;
- Dexie se migrará de forma aditiva y se probará desde cada versión actualmente desplegada.

### 7.4 Feature flags mínimos

- `checkout_v2`;
- `domain_commands_v2`;
- `outbox_v2_shadow`;
- `outbox_v2_write`;
- `change_feed_v2`;
- `stock_conflicts_v2`;
- `query_optimizations_v2`.

Los flags deben poder controlarse por negocio y, durante el piloto, por dispositivo.

## 8. Pirámide de pruebas obligatoria

### Unitarias

- totales, impuestos, métodos mixtos y fiado;
- siguiente ticket y NCF;
- transiciones de reparación/apartado/serial;
- cálculo de caja;
- idempotencia y clasificación de errores;
- reglas de conflicto de stock.

### Contractuales

Para cada comando, comparar el conjunto completo de efectos esperados. Una venta no se aprueba comprobando únicamente `ventas`; se comprueban también detalles, stock, movimientos, serial, fiado y caja.

### Integración local

- transacciones Dexie con fallos inyectados;
- upgrade desde cada versión relevante;
- cierre del navegador antes/después del commit;
- reintento después de excepción.

### Integración Supabase

- RLS por dueño, empleado, negocio y sucursal;
- operación enviada dos o más veces;
- lote parcialmente inválido;
- paginación y cursor;
- eventos con igual timestamp;
- versión de protocolo anterior.

### End-to-end multidispositivo

- A vende, B observa descuento;
- A vende offline, vuelve online, B converge;
- B pierde Realtime y recupera por cursor;
- A y B venden simultáneamente;
- conflicto de último stock e IMEI;
- devolución, reparación, apartado, gasto y cierre vistos desde otro equipo;
- impresión y NCF permanecen correctos.

### Regresión funcional

Matriz completa por rol (`admin`, `cajero`, `vendedor`), plan (`básico`, `pro`), sucursal, navegador instalado/no instalado y conectividad.

## 9. Despliegue recomendado con usuarios reales

| Etapa | Alcance | Permanencia mínima | Condición para avanzar |
|---|---|---:|---|
| Laboratorio | Datos sintéticos y 100 dispositivos simulados | hasta aprobar | SLO y consistencia completos |
| Interna | Dispositivo del desarrollador | 2 días operativos | sin diferencias ni errores permanentes |
| Tester | Cliente validador, un solo dispositivo | 3–5 días operativos | cobro estable y soporte sin incidentes |
| Piloto multi-PC | Un negocio con PC A y PC B | 7 días operativos | stock convergente y cero pérdidas |
| Canario | Un segundo negocio | 7 días | mismas métricas o mejores |
| General controlado | 25% → 50% → 100% | 48 h por escalón | sin degradación de SLO |

No activar una fase crítica un viernes, víspera de feriado o sin disponibilidad de soporte.

## 10. Reglas de rollback y recuperación

- rollback significa desactivar el camino nuevo, no borrar sus datos;
- las tablas/columnas nuevas permanecen hasta que termine la ventana de compatibilidad;
- Sync v1 se conserva mientras Sync v2 esté en sombra o canario;
- cada operación aceptada conserva `operation_id`, payload y recibo;
- nunca marcar como confirmada una operación sin recibo del servidor;
- nunca descartar automáticamente un error permanente relacionado con dinero, stock o seriales;
- proporcionar reintento manual y exportación de la operación para soporte;
- respaldar antes de migraciones y probar restauración, no solo creación del backup.

## 11. Puertas de calidad para producción

Una fase no se considera terminada solo porque “funciona en mi PC”. Debe cumplir:

- `npm run typecheck`, lint y pruebas completas sin errores;
- cobertura contractual de todos los efectos del dominio modificado;
- migración hacia adelante y prueba de compatibilidad con cliente anterior;
- prueba offline, reconexión y reintento;
- prueba en dispositivo de bajos recursos;
- métricas comparativas antes/después;
- plan de rollback ejecutado en staging;
- revisión de aislamiento por negocio/sucursal;
- checklist de soporte actualizado.

## 12. Orden recomendado y criterio de inversión

Prioridad empresarial:

1. Fase 0: saber qué ocurre realmente.
2. Fase 1: eliminar la espera visible al cobrar.
3. Fase 2: proteger reglas compartidas entre módulos.
4. Fases 3–5: garantizar entrega y convergencia entre equipos.
5. Fase 6: resolver explícitamente stock e IMEI concurrentes.
6. Fase 7: escalar cada pantalla con el volumen.
7. Fases 8–9: eficiencia operativa y validación a 100 dispositivos.

La captación agresiva de clientes debería comenzar después del piloto multi-PC de Fase 5. Antes se puede continuar vendiendo de manera controlada, pero no prometer sincronización instantánea o ausencia absoluta de conflictos offline.

## 13. Definición de “VentaRD nivel Pro”

VentaRD estará listo para escalar cuando una operación pueda seguirse de extremo a extremo:

```text
aceptada localmente
→ persistida
→ pendiente visible
→ enviada con idempotencia
→ confirmada por servidor
→ publicada como cambio ordenado
→ aplicada por los demás dispositivos
→ incluida correctamente en caja, historial y reportes
```

Y cuando cualquier interrupción en esa cadena sea visible, recuperable y comprobable sin depender de revisar manualmente la base de datos.
