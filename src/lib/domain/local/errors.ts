/** Mensajes cerrados: no mostrar payloads, IDs, notas ni secretos de excepciones. */
export function localCommandError(error: unknown): string {
    const code = error instanceof Error ? error.message : '';
    if(code==='SHARED_FISCAL_EXCLUDED')return 'NCF queda fuera de esta prueba de web y aplicación. No se guardó la venta ni se consumió un número.';
    if(code.includes('SHARED_PHOTO'))return 'Vuelve a seleccionar la imagen para guardarla en el formato compartido. No se eliminó la anterior.';
    if(code.includes('SHARED_PREPAR')||code.includes('SHARED_LEGACY_PENDING'))return 'Prepara el registro compartido en Configuración. Los datos anteriores y sus pendientes se conservaron.';
    if(code.includes('SHARED_'))return 'La operación requiere revisar la sincronización compartida. Conservamos los datos y los intentos anteriores.';
    if (code.includes('ncf_no_disponible')) return 'No hay NCF verificables en este dispositivo para este negocio. Conéctate y revisa Configuración. No se cobró ni se consumió un número.';
    if (code.includes('ncf_')) return 'No se pudo verificar la reserva fiscal. No se guardó un cobro parcial. Conserva el intento y solicita revisión.';
    if (code.includes('checkout_bloqueado')) return 'Hay un intento de cobro guardado. Recupéralo o abandónalo antes de editar el carrito.';
    if (code.includes('checkout_') || code.includes('cart_scope')) return 'El intento de cobro o su ámbito cambió. Revisa los intentos guardados; no se creó otro cobro automáticamente.';
    if (code.includes('refund_stock_basis_')) return 'No hay evidencia histórica inequívoca para reponer este inventario. No se modificó la venta ni el stock.';
    if (code.includes('refund_serial_selection_required')) return 'Esta devolución parcial requiere identificar el serial exacto. No se eligió ninguno automáticamente.';
    if (code.includes('refund_serial_owner_invalid')) return 'El serial ya no pertenece a esa venta o falta su historial. No se repuso inventario.';
    if (code.includes('refund_quantity') || code.includes('refund_nothing_remaining')) return 'La cantidad disponible para devolver cambió. Abre de nuevo la venta y revisa lo ya devuelto.';
    if (code.includes('refund_')) return 'No se pudo verificar el contexto histórico de la devolución. No se guardaron efectos parciales.';
    if (code.includes('conteo_invalido')) return 'Revisa el conteo: cantidades enteras no negativas y total coincidente.';
    if (code.includes('turno_ya_abierto')) return 'Ya hay una caja abierta en esta sucursal. No se creó otra.';
    if (code.includes('turno_requerido')) return 'Abre la caja de esta sucursal antes de recibir efectivo.';
    if (code.includes('turno_ambiguo')) return 'Hay más de un turno abierto en esta sucursal. No se realizó el cobro.';
    if (code.includes('turno_')) return 'El turno cambió o no corresponde a este cobro. Revisa la caja.';
    if (code.includes('documento_version_conflicto')) return 'El documento cambió. Ciérralo y ábrelo de nuevo antes de guardar.';
    if (code.includes('operacion_id_conflicto')) return 'Este intento corresponde a otra operación. No se modificó la original.';
    if (code.includes('ambito_invalido')) return 'Un artículo, cliente o serial no pertenece al contexto actual. No se guardó la operación.';
    if (code.includes('stock_insuficiente')) return 'Stock insuficiente. No se guardó ningún efecto parcial.';
    if (code.includes('inventory_scope_stock_unavailable')) return 'No hay stock verificable guardado para esta sucursal. Conecta y espera su inventario; no se usó el stock de otro local.';
    if (code.includes('stock_consumo_no_entero')) return 'La cantidad o receta produce un consumo fraccionario no compatible con este inventario. No se redondeó ni descontó stock.';
    if (code.includes('stock_consumo_')) return 'La cantidad o receta supera el rango de inventario admitido. No se guardó ningún efecto parcial.';
    if (code.includes('inventory_integer_invalid')) return 'Este movimiento requiere cantidades enteras. No se redondeó ni descontó stock.';
    if (code.includes('importe') || code.includes('pago_mixto')) return 'Revisa los importes: deben tener centavos exactos y el pago debe cuadrar.';
    if (code.includes('serial_')) return 'Revisa el serial: debe corresponder al artículo y estar disponible para esta operación.';
    return 'No se pudo guardar la operación. Conserva los datos y vuelve a intentarlo.';
}
