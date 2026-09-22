# Contrato de venta local v1

Estado: implementado y probado de forma aislada. No está conectado al POS de producción.

## Propósito

Definir todos los efectos que constituyen una venta aceptada por VentaRD. Una
optimización futura solo puede considerarse equivalente si conserva el conjunto
completo, no únicamente la fila de `ventas`.

## Identidad e idempotencia

- `operacionId` es también el `id` de la venta.
- Repetir el mismo `operacionId` con la misma operación devuelve el resultado
  existente y no vuelve a descontar stock.
- Repetirlo con total, negocio, caja o método diferentes es un conflicto visible.
- Los detalles, movimientos y cargo fiado referencian el mismo `operacionId`.

## Commit local obligatorio

Una sola transacción IndexedDB incluye:

1. reserva del siguiente ticket de la caja;
2. venta;
3. detalles;
4. cargo de fiado, si corresponde;
5. movimientos de stock;
6. nuevo stock local;
7. estado y garantía de seriales;
8. actualización del contador durable.

Si cualquier validación o escritura falla, todos esos cambios se revierten.

## Consumidores que deben seguir funcionando

| Efecto | Consumidores |
|---|---|
| Venta y método de pago | Historial, caja, dashboard, reportes, asistente, sync |
| Desglose mixto | Efectivo esperado, cortes X/Z, reportes |
| Detalles | Ticket, historial, corte por producto, exportes |
| Movimiento de stock | POS, inventario, kardex, sincronización entre equipos |
| Serial vendido | Garantías, inventario, reparaciones, sync |
| Cargo fiado | Clientes, balance, límites de crédito, reportes |
| Ticket por caja | Ticket impreso, historial, caja, sincronización |
| NCF | Ticket, historial, reportes fiscales, sync |

## Diferencias intencionales respecto al flujo legado

- El ticket se reserva mediante `secuencias` y no se vuelve a calcular al final.
- Se valida el stock agregado de todos los renglones y componentes del combo.
- Los seriales pertenecen al mismo commit; antes se actualizaban después.
- Fiado y detalles conservan `sucursal_id` explícitamente.
- Dos cobros concurrentes de una misma caja reciben tickets distintos.
- Un pago mixto debe cuadrar con el total con tolerancia de un centavo.

## Bloqueo antes de activar `checkout_v2`

El NCF actual se consume desde Zustand/localStorage antes del commit. El nuevo
comando acepta un NCF ya asignado para modelar el efecto, pero todavía no puede
garantizar atomicidad fiscal. No se conectará el comando a la pantalla hasta que
la reserva local del NCF y el commit de la venta compartan una estrategia durable
y probada, o se documente formalmente una política de recuperación de folios.

## Pruebas actuales

- generación completa de efectos;
- producto simple y combo;
- efectivo, mixto y fiado;
- serial y garantía;
- contador legado y contador durable;
- dos ventas concurrentes;
- repetición idempotente;
- conflicto de identidad;
- rollback por stock insuficiente;
- rollback por serial no disponible;
- rollback por colisión de escritura.
