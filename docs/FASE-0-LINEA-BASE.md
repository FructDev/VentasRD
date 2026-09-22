# Fase 0 — Línea base y protocolo de diagnóstico

Esta fase añade observabilidad local. No cambia reglas de venta, inventario, caja ni sincronización.

## Estado de implementación

- [x] Registro local limitado y sin PII.
- [x] Medición de arranque y detección de servidor.
- [x] Medición del cobro por etapas.
- [x] Medición de pull, push/mantenimiento y ciclo total de sync.
- [x] Medición de navegación y tareas largas.
- [x] Conteo completo de tablas y pendientes.
- [x] Resumen p50/p95/máximo y errores.
- [x] Exportación JSON y reinicio de muestras.
- [x] Pruebas unitarias, TypeScript, lint y build.
- [ ] Ejecutar protocolo local y reunir muestras.
- [ ] Comparar PC A / PC B.
- [ ] Obtener y auditar el esquema real de Supabase.
- [ ] Cerrar línea base y priorizar los cuellos medidos.

## Qué se mide

| Métrica | Significado |
|---|---|
| `arranque.comprobar_servidor` | Tiempo para decidir si Supabase está disponible |
| `arranque.autenticacion` | Tiempo del flujo de autenticación/caché hasta liberar la app |
| `navegacion.modulo` | Tiempo percibido desde el clic hasta pintar la nueva ruta |
| `ui.tarea_larga` | Bloqueo del hilo principal superior a 50 ms reportado por el navegador |
| `venta.validacion` | Validación local de stock y composiciones |
| `venta.transaccion_local` | Transacción Dexie de venta, detalles, fiado y movimientos |
| `venta.seriales` | Actualización posterior de IMEI/seriales |
| `venta.ticket_final` | Segundo cálculo actual del número de ticket |
| `venta.total` | Tiempo completo desde confirmar hasta liberar el botón |
| `venta.interfaz_lista` | Tiempo desde confirmar hasta dos frames después de liberar la interfaz |
| `sync.pull` | Descarga y reconciliación previa al push |
| `sync.push_y_mantenimiento` | Subida de pendientes, purga y mantenimiento |
| `sync.total` | Ciclo completo del sincronizador |
| `stock.push_confirmacion` | Tiempo para confirmar un movimiento de stock en Supabase |
| `stock.realtime_aplicacion` | Tiempo para aplicar en otro equipo el aviso Realtime recibido |

Se conservan como máximo 300 muestras en `localStorage`. No se almacenan nombres de clientes/productos, teléfonos, seriales, importes ni contenido de tickets.

El diagnóstico v2 conserva las 100 muestras más recientes con contexto técnico
(ruta, cantidad de artículos/seriales, PWA, impresión y solapamiento con sync).
También identifica versión activa, Service Worker y número de entradas por caché.

## Inventario local observado

- Dexie: `VentaRD_Vault`, versión 20.
- Tablas operativas: productos, composiciones, ventas, detalles, clientes, fiado, cajas, sucursales, devoluciones, cortes, seriales, movimientos de stock, gastos, reparaciones y apartados.
- El diagnóstico cuenta todas las filas y los pendientes de las 14 tablas sincronizables.
- Estado del sistema también registra almacenamiento persistente, cuota, memoria disponible cuando el navegador la expone, tamaño de pantalla y versión Dexie.

## Riesgo de esquema identificado

El historial de migraciones de `supabase/migrations/` comienza después de varias tablas base. Funciones críticas como `aplicar_movimiento_stock` aparecen además en scripts históricos. Antes de cambiar Sync v1 se debe obtener un dump solo de esquema de producción y compararlo con:

- migraciones versionadas;
- `scripts/sql/` históricos;
- consultas actuales de `worker.ts`;
- índices, RLS, triggers, RPC y publicación Realtime reales.

El resultado de esa comparación se convertirá en migraciones idempotentes. No se ejecutarán ALTER sueltos.

## Protocolo local de línea base

Usar datos de prueba, nunca la cuenta productiva de un cliente.

### Preparación

1. Ejecutar VentaRD localmente.
2. Abrir `Configuración → Estado del Sistema`.
3. Pulsar `Reiniciar métricas`.
4. Anotar dispositivo, navegador y condición de red.
5. Confirmar que no existan pendientes anteriores o anotarlos.

### Escenario A — Arranque

Realizar cinco aperturas en cada condición:

- online estable;
- red lenta;
- PC conectada al router pero sin salida a internet;
- completamente offline;
- reinicio desde cero de la PWA.

### Escenario B — Cobro

Realizar diez ventas por grupo:

- un producto simple;
- cinco productos simples;
- carrito de veinte líneas;
- combo;
- venta con IMEI;
- varios IMEI;
- efectivo, transferencia, tarjeta, fiado y mixto;
- impresión automática activada y desactivada.

No comparar importes reales: las métricas solo necesitan número de artículos/seriales.

### Escenario C — Navegación y volumen

Recorrer cinco veces:

```text
POS → Inventario → Clientes → Historial → Dashboard → Caja → POS
```

Repetir con conjuntos de datos pequeño, medio y grande.

### Escenario D — Sincronización PC A / PC B

1. Abrir ambas instancias con el mismo negocio de prueba.
2. Reiniciar métricas en ambas.
3. Vender en A y cronometrar cuándo B muestra el descuento.
4. Repetir diez veces con ambas online.
5. Desconectar A, vender cinco veces, reconectar y observar convergencia.
6. Desconectar B, vender en A, reconectar B y observar convergencia.
7. Minimizar/restaurar B para medir el efecto de `visibilitychange`.
8. Exportar JSON desde ambos dispositivos.

### Escenario E — Módulos Pro relacionados

Medir y verificar propagación de:

- creación, pago, cambio de estado y entrega de reparación;
- consumo/devolución de repuesto;
- creación, abono, finalización y cancelación de apartado;
- reserva/liberación de IMEI;
- garantía;
- gasto en efectivo;
- apertura, corte X y cierre Z;
- devolución de venta y reversión de fiado.

## Evidencia que se conserva

Para cada escenario guardar:

- JSON exportado por dispositivo;
- versión/commit probado;
- condición de red;
- cantidad aproximada de filas por tabla;
- resultado funcional esperado/observado;
- video o cronometraje externo cuando se evalúe percepción visual.

## Puerta de salida de Fase 0

La Fase 0 termina cuando existan:

- al menos 20 muestras de ventas representativas;
- al menos 20 ciclos de sync online y varios con error controlado;
- mediciones de inicio online/offline/red muerta;
- comparación PC A/PC B;
- inventario confirmado del esquema Supabase real;
- lista priorizada de cuellos de botella con p50, p95 y máximo;
- conjunto de regresión que se repetirá después de Fase 1.
