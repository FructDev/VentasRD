// src/app/page.tsx
'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { useCartStore } from '@/store/useCartStore';
import { ProductoLocal } from '@/types/database';
import { formatDOP } from '@/lib/utils';
import Fuse from 'fuse.js';
import { useReactToPrint } from 'react-to-print';
import { TicketVenta } from '@/components/TicketVenta';
import { db, getNextTicketNumber } from '@/lib/db/dexie';
import { useProductosTenant, useClientesTenant, useTransaccionesFiadoTenant } from '@/lib/db/tenantQuery';
import { v4 as uuidv4 } from 'uuid';
import TopBar from '@/components/shared/TopBar';
import OfflineBanner from '@/components/shared/OfflineBanner';
import VentaLibreModal from '@/components/shared/VentaLibreModal';
import CajaModal from '@/components/shared/CajaModal';
import { SkeletonProductGrid } from '@/components/ui/Skeleton';
import { useLiveQuery } from 'dexie-react-hooks';

export default function POSPage() {
  const { negocioId, negocioNombre, sucursalId, showToast, negocioRnc, negocioDireccion, negocioMensajeTicket } = useConfigStore();
  const { items, subtotal, itbis, descuento, total, tipoDescuento, valorDescuento, addItem, clearCart, updateQuantity, setDescuento } = useCartStore();

  const [searchTerm, setSearchTerm] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [metodoPago, setMetodoPago] = useState<'efectivo' | 'tarjeta' | 'transferencia' | 'fiado' | 'mixto'>('efectivo');
  const [montoRecibido, setMontoRecibido] = useState<string>('');
  const [montoEfectivoMixto, setMontoEfectivoMixto] = useState<string>('');
  const [montoTransferenciaMixto, setMontoTransferenciaMixto] = useState<string>('');
  const [ventaExitosa, setVentaExitosa] = useState(false);
  const [clienteSeleccionadoId, setClienteSeleccionadoId] = useState<string>('');
  const [isVentaLibreOpen, setIsVentaLibreOpen] = useState(false);
  const [isCajaOpen, setIsCajaOpen] = useState(false);
  const [ultimoTicketNum, setUltimoTicketNum] = useState<number | undefined>(undefined);
  const inputMontoRef = useRef<HTMLInputElement>(null);

  const ticketRef = useRef<HTMLDivElement>(null);
  const handlePrint = useReactToPrint({ contentRef: ticketRef });

  // 1. LECTURA REACTIVA AISLADA POR NEGOCIO
  const productosRaw = useLiveQuery(
    () => negocioId ? db.productos.where('negocio_id').equals(negocioId).limit(1).toArray() : [],
    [negocioId]
  );
  const catalogoIsLoading = productosRaw === undefined;
  const productosEnDBRaw = useProductosTenant();
  const productosEnDB = useMemo(() => productosEnDBRaw.filter(p => p.tipo !== 'insumo'), [productosEnDBRaw]);
  const clientes = useClientesTenant();
  const transacciones = useTransaccionesFiadoTenant();

  // MOTOR DE BÚSQUEDA
  const fuse = useMemo(() => new Fuse(productosEnDB, { keys: ['nombre', 'codigo_barras'], threshold: 0.4, ignoreLocation: true }), [productosEnDB]);
  const productosFiltrados = useMemo(() => {
    if (!searchTerm) return productosEnDB;
    return fuse.search(searchTerm).map(result => result.item);
  }, [searchTerm, fuse, productosEnDB]);

  const devuelta = parseFloat(montoRecibido || '0') - total;
  const totalMixto = parseFloat(montoEfectivoMixto || '0') + parseFloat(montoTransferenciaMixto || '0');

  // MOTOR DE ATAJOS DE TECLADO
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F2') { e.preventDefault(); searchInputRef.current?.focus(); }
      if (e.key === 'F4') { e.preventDefault(); setIsVentaLibreOpen(true); }
      if (e.key === ' ' && items.length > 0 && document.activeElement !== searchInputRef.current && !isCheckoutOpen && !isVentaLibreOpen) { e.preventDefault(); abrirModalCobro(); }
      if (e.key === 'Escape' && isCheckoutOpen && !ventaExitosa) { setIsCheckoutOpen(false); }
      if (e.key === 'Escape' && isVentaLibreOpen) { setIsVentaLibreOpen(false); }
      if (e.key === 'Enter') {
        if (isCheckoutOpen && !ventaExitosa) {
          e.preventDefault();
          if (esMontoValido) { procesarVentaBD(); }
        } else if (document.activeElement === searchInputRef.current && searchTerm) {
          e.preventDefault();
          const productoExacto = productosEnDB.find(p => p.codigo_barras === searchTerm);
          if (productoExacto) { addItem(productoExacto); setSearchTerm(''); }
          else if (productosFiltrados.length === 1) { addItem(productosFiltrados[0]); setSearchTerm(''); }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [items, isCheckoutOpen, isVentaLibreOpen, metodoPago, montoRecibido, total, ventaExitosa, searchTerm, productosFiltrados, productosEnDB, addItem]);

  // AUTO-ENFOQUE EN INPUT DE EFECTIVO
  useEffect(() => {
    if (isCheckoutOpen && !ventaExitosa) {
      setTimeout(() => inputMontoRef.current?.focus(), 100);
    }
  }, [isCheckoutOpen, ventaExitosa]);

  const abrirModalCobro = () => {
    setMetodoPago('efectivo');
    setMontoRecibido('');
    setMontoEfectivoMixto('');
    setMontoTransferenciaMixto('');
    setVentaExitosa(false);
    setClienteSeleccionadoId('');
    setIsCheckoutOpen(true);
  };

  // Crédito: balance actual del cliente seleccionado y si excede el límite
  const { balanceClienteSeleccionado, limiteClienteSeleccionado, excedeCredito } = useMemo(() => {
    if (!clienteSeleccionadoId || metodoPago !== 'fiado') {
      return { balanceClienteSeleccionado: 0, limiteClienteSeleccionado: 0, excedeCredito: false };
    }
    const cliente = clientes.find(c => c.id === clienteSeleccionadoId);
    const limite = cliente?.limite_credito ?? 0;
    const cargos = transacciones.filter(t => t.tipo === 'cargo' && t.cliente_id === clienteSeleccionadoId).reduce((s, t) => s + t.monto, 0);
    const abonos = transacciones.filter(t => t.tipo === 'abono' && t.cliente_id === clienteSeleccionadoId).reduce((s, t) => s + t.monto, 0);
    const balance = cargos - abonos;
    return {
      balanceClienteSeleccionado: balance,
      limiteClienteSeleccionado: limite,
      excedeCredito: limite > 0 && (balance + total) > limite,
    };
  }, [clienteSeleccionadoId, metodoPago, clientes, transacciones, total]);

  const esMontoValido =
    (metodoPago === 'efectivo' && parseFloat(montoRecibido || '0') >= total) ||
    (metodoPago === 'tarjeta' || metodoPago === 'transferencia') ||
    (metodoPago === 'fiado' && clienteSeleccionadoId !== '' && !excedeCredito) ||
    (metodoPago === 'mixto' && parseFloat(montoEfectivoMixto || '0') > 0 && parseFloat(montoTransferenciaMixto || '0') > 0 && totalMixto >= total);

  // 3. ESCRITURA TRANSACCIONAL EN DEXIE
  const procesarVentaBD = async () => {
    if (!negocioId) return;

    try {
      await db.transaction('rw', [db.ventas, db.venta_detalles, db.productos, db.composiciones, db.transacciones_fiado], async () => {
        const idVenta = uuidv4();
        const ticketNum = await getNextTicketNumber(negocioId);

        await db.ventas.add({
          id: idVenta,
          negocio_id: negocioId,
          sucursal_id: sucursalId || undefined,
          numero_ticket: ticketNum,
          total: total,
          metodo_pago: metodoPago,
          ...(metodoPago === 'mixto' && {
            monto_efectivo: parseFloat(montoEfectivoMixto || '0'),
            monto_transferencia: parseFloat(montoTransferenciaMixto || '0'),
          }),
          ...(metodoPago === 'fiado' && clienteSeleccionadoId && {
            cliente_id: clienteSeleccionadoId,
          }),
          estado_sincronizacion: 0,
          fecha_creacion: Date.now(),
        });

        if (metodoPago === 'fiado' && clienteSeleccionadoId) {
            await db.transacciones_fiado.add({
                id: uuidv4(),
                negocio_id: negocioId,
                cliente_id: clienteSeleccionadoId,
                venta_id: idVenta,
                tipo: 'cargo',
                monto: total,
                concepto: 'Compra en POS',
                fecha_creacion: Date.now(),
                estado_sincronizacion: 0,
                fecha_actualizacion: Date.now()
            });
        }

        for (const item of items) {
          await db.venta_detalles.add({
              id: uuidv4(),
              venta_id: idVenta,
              producto_id: item.id,
              negocio_id: negocioId,
              cantidad: item.cantidad,
              precio_unitario: item.precio_venta,
              subtotal: item.precio_venta * item.cantidad,
              estado_sincronizacion: 0,
              fecha_creacion: Date.now()
          });

          const receta = await db.composiciones
            .where('producto_padre_id')
            .equals(item.id)
            .toArray();

          if (receta.length > 0) {
            for (const ingrediente of receta) {
              const insumoEnAlmacen = await db.productos.get(ingrediente.insumo_id);
              if (insumoEnAlmacen) {
                const cantidadARestar = ingrediente.cantidad_necesaria * item.cantidad;
                const newStock = parseFloat((insumoEnAlmacen.stock_actual - cantidadARestar).toFixed(3));
                await db.productos.update(ingrediente.insumo_id, {
                  stock_actual: newStock,
                  estado_sincronizacion: 0,
                  fecha_actualizacion: Date.now()
                });
              }
            }
          } else {
            const productoSimple = await db.productos.get(item.id);
            if (productoSimple) {
              const newStock = parseFloat((productoSimple.stock_actual - item.cantidad).toFixed(3));
              await db.productos.update(item.id, {
                stock_actual: newStock,
                estado_sincronizacion: 0,
                fecha_actualizacion: Date.now()
              });
            }
          }
        }
      });

      setUltimoTicketNum(await getNextTicketNumber(negocioId) - 1);
      setVentaExitosa(true);
      setTimeout(() => { handlePrint(); }, 100);

    } catch (error) {
      console.error("Error en la transacción de venta:", error);
      showToast("Hubo un problema al procesar la venta.", "error");
    }
  };

  const getStockColor = (producto: ProductoLocal) => {
    if (producto.stock_actual <= 0) return 'text-vr-red';
    if (producto.stock_actual <= producto.stock_minimo) return 'text-vr-orange';
    return 'text-vr-gray';
  };

  return (
    <div className="flex flex-col h-screen bg-navy overflow-hidden">
      <TopBar />
      <OfflineBanner />

      <div className="flex flex-1 overflow-hidden">
        {/* COMPONENTE OCULTO DE IMPRESIÓN */}
        <div style={{ display: "none" }}>
          <TicketVenta
            ref={ticketRef} items={items} subtotal={subtotal} itbis={itbis} descuento={descuento} total={total}
            metodoPago={metodoPago} montoRecibido={montoRecibido} devuelta={devuelta}
            nombreNegocio={negocioNombre || 'VentaRD'} numeroTicket={ultimoTicketNum}
            mensajePie={negocioMensajeTicket || undefined}
          />
        </div>

        {/* COLUMNA IZQUIERDA: CATÁLOGO */}
        <div className="flex-1 flex flex-col p-4 overflow-hidden">
          <div className="mb-4">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  ref={searchInputRef} type="text" placeholder="Buscar producto o escanear código (F2)"
                  className="w-full px-5 py-3.5 text-base bg-navy-2 border border-navy-3 rounded-xl focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none text-white placeholder-vr-gray transition-all"
                  value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} autoFocus
                />
                <span className="absolute right-3 top-3.5 text-vr-gray font-mono text-xs bg-navy-3 px-2 py-1 rounded">F2</span>
              </div>
              <button
                onClick={() => setIsVentaLibreOpen(true)}
                className="px-4 py-3.5 bg-navy-2 border border-navy-3 rounded-xl text-vr-gray hover:text-gold hover:border-gold/30 transition-all font-bold text-sm flex items-center gap-2 whitespace-nowrap"
              >
                ⚡ Libre
                <span className="text-[10px] font-mono bg-navy-3 px-1.5 py-0.5 rounded">F4</span>
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto pr-2">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {catalogoIsLoading ? (
                <SkeletonProductGrid count={12} />
              ) : productosFiltrados.length === 0 ? (
                <div className="col-span-full flex flex-col justify-center items-center h-40 text-vr-gray">
                  <span className="text-4xl mb-2">📦</span>
                  <span className="font-medium">No se encontraron productos</span>
                </div>
              ) : (
                productosFiltrados.map((producto) => (
                  <button
                    key={producto.id} onClick={() => addItem(producto)}
                    className="bg-navy-2 p-4 rounded-xl border border-navy-3 hover:border-gold/40 hover:bg-navy-3 transition-all text-left flex flex-col justify-between h-28 active:scale-[0.97] group"
                  >
                    <span className="font-semibold text-white line-clamp-2 text-sm group-hover:text-gold-2 transition-colors">{producto.nombre}</span>
                    <div className="flex justify-between items-end mt-2">
                      <span className="text-lg font-bold font-mono text-gold">{formatDOP(producto.precio_venta)}</span>
                      <span className={`text-xs font-medium ${getStockColor(producto)}`}>
                        {producto.stock_actual} uds
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        {/* COLUMNA DERECHA: TICKET Y COBRO */}
        <div className="w-96 bg-navy-2 border-l border-navy-3 flex flex-col z-10">
          <div className="p-4 border-b border-navy-3 flex justify-between items-center">
            <h2 className="text-lg font-display font-bold text-white">Ticket</h2>
            <div className="flex items-center gap-2">
              <button onClick={() => setIsCajaOpen(true)} className="text-xs text-gold hover:bg-gold/10 px-3 py-1 rounded-lg transition-colors font-bold border border-gold/20">💰 Caja</button>
              <button onClick={clearCart} className="text-xs text-vr-red hover:bg-vr-red/10 px-3 py-1 rounded-lg transition-colors font-bold">Limpiar</button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {items.length === 0 ? (
              <div className="h-full flex items-center justify-center text-vr-gray text-center px-4 text-sm">
                <div>
                  <span className="text-3xl block mb-2">🛒</span>
                  Agrega productos para comenzar
                </div>
              </div>
            ) : (
              items.map((item) => (
                <div key={item.id} className="flex justify-between items-start border-b border-navy-3/50 pb-3 animate-fade-in">
                  <div className="flex-1">
                    <h4 className="font-medium text-white text-sm">{item.nombre}</h4>
                    <div className="text-sm text-vr-gray flex items-center gap-2 mt-1">
                      <span className="font-mono font-semibold text-gold-2">{formatDOP(item.precio_venta)}</span>
                      <span>×</span>
                      <div className="flex items-center gap-1 bg-navy-3 rounded-md px-1">
                        <button onClick={() => updateQuantity(item.id, item.cantidad - 1)} className="px-2 font-bold hover:text-gold transition-colors">-</button>
                        <span className="w-5 text-center font-bold font-mono text-white text-xs">{item.cantidad}</span>
                        <button onClick={() => updateQuantity(item.id, item.cantidad + 1)} className="px-2 font-bold hover:text-gold transition-colors">+</button>
                      </div>
                    </div>
                  </div>
                  <div className="font-bold font-mono text-white text-sm">{formatDOP(item.precio_venta * item.cantidad)}</div>
                </div>
              ))
            )}
          </div>

          <div className="p-4 bg-navy border-t border-navy-3">
            <div className="space-y-1.5 mb-4 text-sm">
              <div className="flex justify-between text-vr-gray"><span>Subtotal</span><span className="font-mono">{formatDOP(subtotal)}</span></div>
              <div className="flex justify-between text-vr-gray"><span>ITBIS</span><span className="font-mono">{formatDOP(itbis)}</span></div>
              {descuento > 0 && (
                <div className="flex justify-between text-vr-green font-bold">
                  <span>Descuento {tipoDescuento === 'porcentaje' ? `(${valorDescuento}%)` : ''}</span>
                  <span className="font-mono">- {formatDOP(descuento)}</span>
                </div>
              )}
              <div className="flex justify-between text-2xl font-black text-white pt-2 border-t border-navy-3 mt-2">
                <span>Total</span><span className="font-mono text-gold">{formatDOP(total)}</span>
              </div>
            </div>
            <button
              onClick={abrirModalCobro} disabled={items.length === 0}
              className="w-full bg-gold-gradient text-navy text-lg font-extrabold py-4 rounded-xl hover:brightness-110 transition-all disabled:opacity-30 disabled:cursor-not-allowed shadow-lg relative"
            >
              Cobrar Venta
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[10px] font-mono font-normal bg-navy/20 px-2 py-0.5 rounded">ESPACIO</span>
            </button>
          </div>
        </div>
      </div>

      {/* MODAL DE COBRO */}
      {isCheckoutOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-navy-2 w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-full border border-navy-3 animate-scale-in">

            {ventaExitosa ? (
              <div className="p-10 text-center flex flex-col items-center justify-center">
                <div className="w-20 h-20 bg-vr-green/15 text-vr-green rounded-full flex items-center justify-center text-4xl mb-5 border border-vr-green/30 animate-scale-in">✓</div>
                <h2 className="text-3xl font-display font-black text-white mb-2">¡Venta Exitosa!</h2>
                {ultimoTicketNum && <p className="text-vr-gray font-mono text-sm mb-4">Ticket #{String(ultimoTicketNum).padStart(5, '0')}</p>}
                {metodoPago === 'efectivo' && (
                  <div className="bg-vr-green/10 border border-vr-green/20 rounded-xl px-6 py-3 mb-6">
                    <p className="text-sm text-vr-gray">Devuelta</p>
                    <p className="text-3xl font-black font-mono text-vr-green">{formatDOP(devuelta)}</p>
                  </div>
                )}
                {metodoPago === 'mixto' && (
                  <div className="bg-navy border border-navy-3 rounded-xl px-6 py-3 mb-6 space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-vr-green font-bold">Efectivo</span>
                      <span className="font-mono text-white">{formatDOP(parseFloat(montoEfectivoMixto || '0'))}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-purple-400 font-bold">Transferencia</span>
                      <span className="font-mono text-white">{formatDOP(parseFloat(montoTransferenciaMixto || '0'))}</span>
                    </div>
                  </div>
                )}
                <div className="flex gap-3 mt-4 w-full max-w-sm">
                  <button
                    onClick={() => {
                      const encabezado = `${negocioNombre || 'VentaRD'}${negocioRnc ? `\nRNC: ${negocioRnc}` : ''}${negocioDireccion ? `\n${negocioDireccion}` : ''}`;
                      const pie = negocioMensajeTicket || '¡Gracias por su compra!';
                      const resumen = `Ticket #${String(ultimoTicketNum).padStart(5, '0')}\n${encabezado}\n\n${items.map(i => `${i.cantidad}x ${i.nombre} — ${formatDOP(i.precio_venta * i.cantidad)}`).join('\n')}\n\nTotal: ${formatDOP(total)}\nPago: ${metodoPago}\n\n${pie}`;
                      window.open(`https://wa.me/?text=${encodeURIComponent(resumen)}`, '_blank');
                    }}
                    className="flex-1 py-3 bg-vr-green/15 text-vr-green font-bold rounded-xl border border-vr-green/20 hover:bg-vr-green/25 transition-all text-sm flex items-center justify-center gap-2"
                  >
                    📱 Enviar WhatsApp
                  </button>
                  <button
                    onClick={() => { handlePrint(); }}
                    className="flex-1 py-3 bg-navy-3 text-white font-bold rounded-xl border border-navy-4 hover:bg-navy-4 transition-all text-sm"
                  >
                    🖨️ Reimprimir
                  </button>
                </div>
                <button
                  onClick={() => {
                    setVentaExitosa(false);
                    setIsCheckoutOpen(false);
                    clearCart();
                    setSearchTerm('');
                    searchInputRef.current?.focus();
                  }}
                  className="mt-6 w-full max-w-sm py-4 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all text-lg"
                >
                  Nueva Venta →
                </button>
              </div>
            ) : (
              <>
                <div className="p-6 bg-navy border-b border-navy-3 flex justify-between items-center">
                  <h2 className="text-xl font-display font-bold text-white">Completar Pago</h2>
                  <button onClick={() => setIsCheckoutOpen(false)} className="text-vr-gray hover:text-white font-bold text-xl px-2 transition-colors">✕</button>
                </div>

                <div className="p-6 flex-1 overflow-y-auto">
                  <div className="text-center mb-8">
                    <p className="text-vr-gray mb-1 text-sm">Monto a Cobrar</p>
                    <p className="text-5xl font-black font-mono text-gold">{formatDOP(total)}</p>
                  </div>

                  <div className="grid grid-cols-3 md:grid-cols-5 gap-2 mb-8">
                    {([
                      { key: 'efectivo', label: 'Efectivo' },
                      { key: 'tarjeta', label: 'Tarjeta' },
                      { key: 'transferencia', label: 'Transfer.' },
                      { key: 'fiado', label: 'Fiado' },
                      { key: 'mixto', label: 'Mixto' },
                    ] as const).map(({ key, label }) => (
                      <button
                        key={key}
                        onClick={() => setMetodoPago(key)}
                        className={`py-3.5 rounded-xl font-bold text-sm border transition-all ${
                          metodoPago === key
                            ? 'border-gold bg-gold/15 text-gold shadow-md'
                            : 'border-navy-3 bg-navy-3 text-vr-gray hover:border-navy-4 hover:text-white'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {/* ── DESCUENTO ── */}
                  <div className="bg-navy p-4 rounded-xl border border-navy-3 mb-6">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm font-bold text-vr-gray">Descuento</span>
                      <div className="flex bg-navy-2 border border-navy-3 rounded-lg p-0.5">
                        {(['porcentaje', 'monto'] as const).map(t => (
                          <button
                            key={t}
                            onClick={() => setDescuento(t, valorDescuento)}
                            className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${tipoDescuento === t ? 'bg-gold text-navy' : 'text-vr-gray hover:text-white'}`}
                          >
                            {t === 'porcentaje' ? '%' : 'RD$'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="number" min="0"
                        max={tipoDescuento === 'porcentaje' ? 100 : undefined}
                        step={tipoDescuento === 'porcentaje' ? 1 : 10}
                        placeholder="0"
                        value={valorDescuento || ''}
                        onChange={e => setDescuento(tipoDescuento, parseFloat(e.target.value) || 0)}
                        className="flex-1 bg-navy-2 border border-navy-3 rounded-lg p-2 text-white font-mono font-bold text-center focus:border-gold outline-none text-lg"
                      />
                      {descuento > 0 && (
                        <div className="text-vr-green font-bold text-sm font-mono whitespace-nowrap">
                          − {formatDOP(descuento)}
                        </div>
                      )}
                      {descuento > 0 && (
                        <button onClick={() => setDescuento('porcentaje', 0)} className="text-vr-gray hover:text-vr-red text-lg font-bold px-2">✕</button>
                      )}
                    </div>
                  </div>

                  {metodoPago === 'efectivo' && (
                    <div className="bg-navy p-6 rounded-xl border border-navy-3">
                      <label className="block text-sm font-bold text-vr-gray mb-3">¿Con cuánto paga el cliente?</label>
                      <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
                        <button onClick={() => setMontoRecibido(total.toString())} className="px-4 py-2 bg-vr-green/15 text-vr-green font-bold rounded-lg border border-vr-green/20 hover:bg-vr-green/25 text-sm whitespace-nowrap">Exacto</button>
                        <button onClick={() => setMontoRecibido('500')} className="px-4 py-2 bg-navy-3 font-bold rounded-lg border border-navy-4 hover:bg-navy-4 text-white text-sm">RD$500</button>
                        <button onClick={() => setMontoRecibido('1000')} className="px-4 py-2 bg-navy-3 font-bold rounded-lg border border-navy-4 hover:bg-navy-4 text-white text-sm">RD$1,000</button>
                        <button onClick={() => setMontoRecibido('2000')} className="px-4 py-2 bg-navy-3 font-bold rounded-lg border border-navy-4 hover:bg-navy-4 text-white text-sm">RD$2,000</button>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-2xl font-bold text-vr-gray font-mono">RD$</span>
                        <input
                          ref={inputMontoRef} type="number"
                          className="w-full text-4xl font-black font-mono bg-transparent border-b-2 border-navy-3 focus:border-gold focus:outline-none py-2 text-white"
                          placeholder="0.00" value={montoRecibido} onChange={(e) => setMontoRecibido(e.target.value)}
                        />
                      </div>
                      {parseFloat(montoRecibido || '0') >= total && (
                        <div className="mt-6 p-4 bg-vr-green/10 border border-vr-green/20 rounded-xl flex justify-between items-center">
                          <span className="text-vr-green font-bold text-lg">Devuelta:</span>
                          <span className="text-3xl font-black font-mono text-vr-green">{formatDOP(devuelta)}</span>
                        </div>
                      )}
                      {(parseFloat(montoRecibido || '0') > 0 && parseFloat(montoRecibido || '0') < total) && (
                        <div className="mt-6 p-4 bg-vr-red/10 border border-vr-red/20 text-vr-red rounded-xl font-bold text-center text-sm">Falta dinero para completar la venta</div>
                      )}
                    </div>
                  )}

                  {metodoPago === 'fiado' && (
                    <div className={`p-6 rounded-xl border mb-8 ${excedeCredito ? 'bg-vr-red/5 border-vr-red/30' : 'bg-vr-orange/5 border-vr-orange/20'}`}>
                      <label className="block text-sm font-bold text-vr-orange mb-3">Seleccionar Cliente para Fiado</label>
                      <select
                        className="w-full text-base bg-navy border border-navy-3 focus:border-gold focus:outline-none py-3 px-4 rounded-lg font-bold text-white"
                        value={clienteSeleccionadoId}
                        onChange={(e) => setClienteSeleccionadoId(e.target.value)}
                      >
                        <option value="" disabled>-- Elige un cliente --</option>
                        {clientes.map(c => (
                            <option key={c.id} value={c.id}>{c.nombre} {c.limite_credito > 0 ? `(Límite: ${formatDOP(c.limite_credito)})` : ''}</option>
                        ))}
                      </select>
                      {clientes.length === 0 && (
                          <p className="mt-3 text-vr-red text-sm font-bold bg-vr-red/10 p-2 rounded border border-vr-red/20">No hay clientes registrados. Ve a la pantalla de Clientes primero.</p>
                      )}
                      {clienteSeleccionadoId && limiteClienteSeleccionado > 0 && (
                        <div className={`mt-4 p-4 rounded-xl border text-sm ${excedeCredito ? 'bg-vr-red/10 border-vr-red/30 text-vr-red' : 'bg-navy border-navy-3 text-vr-gray'}`}>
                          <div className="flex justify-between mb-1">
                            <span>Deuda actual</span>
                            <span className="font-mono font-bold text-white">{formatDOP(balanceClienteSeleccionado)}</span>
                          </div>
                          <div className="flex justify-between mb-1">
                            <span>Esta venta</span>
                            <span className="font-mono font-bold text-white">+ {formatDOP(total)}</span>
                          </div>
                          <div className={`flex justify-between pt-2 border-t font-bold ${excedeCredito ? 'border-vr-red/30' : 'border-navy-3'}`}>
                            <span>Límite de crédito</span>
                            <span className="font-mono">{formatDOP(limiteClienteSeleccionado)}</span>
                          </div>
                          {excedeCredito && (
                            <p className="mt-3 font-bold text-center">
                              Excede el límite por {formatDOP((balanceClienteSeleccionado + total) - limiteClienteSeleccionado)}. No se puede procesar.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {metodoPago === 'mixto' && (
                    <div className="bg-navy p-6 rounded-xl border border-navy-3 space-y-4">
                      <p className="text-sm font-bold text-vr-gray">Divide el pago entre efectivo y transferencia</p>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-vr-green mb-2 uppercase tracking-wider">Efectivo (RD$)</label>
                          <input
                            type="number" step="0.01" min="0"
                            className="w-full text-2xl font-black font-mono bg-transparent border-b-2 border-navy-3 focus:border-vr-green focus:outline-none py-2 text-white"
                            placeholder="0.00"
                            value={montoEfectivoMixto}
                            onChange={e => setMontoEfectivoMixto(e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-purple-400 mb-2 uppercase tracking-wider">Transferencia (RD$)</label>
                          <input
                            type="number" step="0.01" min="0"
                            className="w-full text-2xl font-black font-mono bg-transparent border-b-2 border-navy-3 focus:border-purple-400 focus:outline-none py-2 text-white"
                            placeholder="0.00"
                            value={montoTransferenciaMixto}
                            onChange={e => setMontoTransferenciaMixto(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className={`flex justify-between items-center p-3 rounded-lg border ${totalMixto >= total ? 'bg-vr-green/10 border-vr-green/20' : 'bg-navy-3 border-navy-3'}`}>
                        <span className="text-sm font-bold text-vr-gray">Total ingresado:</span>
                        <span className={`font-mono font-black text-lg ${totalMixto >= total ? 'text-vr-green' : 'text-white'}`}>
                          {formatDOP(totalMixto)}
                        </span>
                      </div>
                      {totalMixto > 0 && totalMixto < total && (
                        <p className="text-xs text-vr-red font-bold text-center">Faltan {formatDOP(total - totalMixto)} para completar el pago</p>
                      )}
                    </div>
                  )}
                </div>

                <div className="p-6 bg-navy border-t border-navy-3">
                  <button
                    onClick={procesarVentaBD} disabled={!esMontoValido}
                    className="w-full bg-gold-gradient text-navy text-xl font-extrabold py-5 rounded-xl hover:brightness-110 transition-all disabled:opacity-30 disabled:cursor-not-allowed flex justify-center items-center gap-2"
                  >
                    Confirmar e Imprimir
                    <span className="text-xs font-mono font-normal bg-navy/20 px-2 py-1 rounded ml-2">ENTER</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* MODAL VENTA LIBRE (F4) */}
      <VentaLibreModal isOpen={isVentaLibreOpen} onClose={() => setIsVentaLibreOpen(false)} />

      {/* MODAL APERTURA/CIERRE DE CAJA */}
      <CajaModal isOpen={isCajaOpen} onClose={() => setIsCajaOpen(false)} />
    </div>
  );
}