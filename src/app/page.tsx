// src/app/page.tsx
'use client';

import { useState, useEffect, useRef, useMemo, useCallback, memo, lazy, Suspense } from 'react';
import { useConfigStore, getDispositivoId } from '@/store/useConfigStore';
import { useCartStore } from '@/store/useCartStore';
import { ProductoLocal } from '@/types/database';
import { formatDOP, formatTicket } from '@/lib/utils';
import { linkWhatsApp } from '@/lib/whatsapp';
import { logoParaImprimir } from '@/lib/logoCache';
import QrTransferencia from '@/components/shared/QrTransferencia';
import { miniatura } from '@/lib/imagen';
import Fuse from 'fuse.js';
import { useReactToPrint } from 'react-to-print';
import { TicketVenta } from '@/components/TicketVenta';
import { db, getNextTicketNumber } from '@/lib/db/dexie';
import { registrarMovimientoStock } from '@/lib/db/stock';
import { useProductosTenant, useClientesTenant, useTransaccionesFiadoTenant } from '@/lib/db/tenantQuery';
import { v4 as uuidv4 } from 'uuid';
import TopBar from '@/components/shared/TopBar';
const BarcodeScanner = lazy(() => import('@/components/ui/BarcodeScanner'));
import OfflineBanner from '@/components/shared/OfflineBanner';
import VentaLibreModal from '@/components/shared/VentaLibreModal';
import CajaModal from '@/components/shared/CajaModal';
import ConfirmModal from '@/components/ui/ConfirmModal';
import { SkeletonProductGrid } from '@/components/ui/Skeleton';
import { useLiveQuery } from 'dexie-react-hooks';

// Color del stock según nivel (puro — fuera del componente para no recrearse)
function getStockColor(producto: ProductoLocal) {
  if (producto.stock_actual <= 0) return 'text-vr-red';
  if (producto.stock_actual <= producto.stock_minimo) return 'text-vr-orange';
  return 'text-vr-gray';
}

// Tarjeta de producto memoizada: no se re-renderiza al teclear en el buscador
// mientras el producto y el handler no cambien de referencia.
const ProductCard = memo(function ProductCard({
  producto, onSelect,
}: { producto: ProductoLocal; onSelect: (p: ProductoLocal) => void }) {
  return (
    <button
      onClick={() => onSelect(producto)}
      className="bg-navy-2 p-3 sm:p-4 rounded-xl border border-navy-3 hover:border-gold/40 hover:bg-navy-3 transition-all text-left flex flex-col justify-between h-24 sm:h-28 active:scale-[0.97] group relative overflow-hidden"
    >
      <div className="flex items-start gap-2">
        {producto.imagen_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={miniatura(producto.imagen_url, 96)}
            alt=""
            loading="lazy"
            className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg object-cover bg-white shrink-0 border border-navy-3"
          />
        )}
        <div className="min-w-0 flex-1">
          <span className="font-semibold text-white line-clamp-2 text-xs sm:text-sm group-hover:text-gold-2 transition-colors block">{producto.nombre}</span>
          {producto.ubicacion && (
            <span className="block text-[10px] text-vr-gray truncate mt-0.5" title={producto.ubicacion}>📍 {producto.ubicacion}</span>
          )}
        </div>
      </div>
      <div className="flex justify-between items-end mt-1">
        <span className="text-base sm:text-lg font-bold font-mono text-gold">{formatDOP(producto.precio_venta)}</span>
        {producto.tipo === 'combo' ? (
          <span className="text-[10px] font-bold text-purple-400 bg-purple-400/10 px-1.5 py-0.5 rounded">combo</span>
        ) : producto.serializable ? (
          <span className="text-[10px] font-bold text-gold bg-gold/10 px-1.5 py-0.5 rounded">{producto.stock_actual} SN</span>
        ) : (
          <span className={`text-xs font-medium ${getStockColor(producto)}`}>
            {producto.stock_actual} uds
          </span>
        )}
      </div>
    </button>
  );
});

export default function POSPage() {
  const { negocioId, negocioNombre, sucursalId, showToast, negocioRnc, negocioTelefono, negocioDireccion, negocioMensajeTicket, negocioLogo, nombreUsuario, rolUsuario, consumirNcf, ncf: ncfConfig, impresion, dispositivoId, planTier, garantiaDiasDefault } = useConfigStore();
  const { items, subtotal, itbis, descuento, total, tipoDescuento, valorDescuento, addItem, addItemConSerial, clearCart, updateQuantity, setDescuento, setCliente, clienteActivoId, tipoPrecios, enEspera, pausarVenta, retomarVenta, descartarEnEspera } = useCartStore();

  const [searchTerm, setSearchTerm] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [metodoPago, setMetodoPago] = useState<'efectivo' | 'tarjeta' | 'transferencia' | 'fiado' | 'mixto'>('efectivo');
  const [montoRecibido, setMontoRecibido] = useState<string>('');
  const [montoEfectivoMixto, setMontoEfectivoMixto] = useState<string>('');
  const [montoTransferenciaMixto, setMontoTransferenciaMixto] = useState<string>('');
  const [ventaExitosa, setVentaExitosa] = useState(false);
  const [clienteSeleccionadoId, setClienteSeleccionadoId] = useState<string>('');
  // Nombre libre del cliente para la factura (no exige cliente registrado)
  const [clienteNombreVenta, setClienteNombreVenta] = useState('');
  const [isVentaLibreOpen, setIsVentaLibreOpen] = useState(false);
  const [isCajaOpen, setIsCajaOpen] = useState(false);
  const [ultimoTicketNum, setUltimoTicketNum] = useState<number | undefined>(undefined);
  const [ultimoNcf, setUltimoNcf] = useState<string | undefined>(undefined);
  const [ultimaVentaId, setUltimaVentaId] = useState<string | null>(null);
  const [anulando, setAnulando] = useState(false);
  const [procesandoVenta, setProcesandoVenta] = useState(false);
  const procesandoVentaRef = useRef(false);
  const [descartandoEspera, setDescartandoEspera] = useState<string | null>(null);
  const [confirmAnularOpen, setConfirmAnularOpen] = useState(false);
  const [emitirNcf, setEmitirNcf] = useState(false);
  const [isCartOpen, setIsCartOpen] = useState(false); // mobile cart drawer
  const [busquedaCliente, setBusquedaCliente] = useState('');
  const [mostrarDropdownCliente, setMostrarDropdownCliente] = useState(false);

  // Modal selector de serial
  const [productoParaSerial, setProductoParaSerial] = useState<ProductoLocal | null>(null);
  const [busquedaSerial, setBusquedaSerial] = useState('');
  const [scannerSerialPOS, setScannerSerialPOS] = useState(false);
  // Escáner de cámara para productos: cualquier celular = pistola de escaneo
  const [scannerProductoPOS, setScannerProductoPOS] = useState(false);
  const inputMontoRef = useRef<HTMLInputElement>(null);

  const ticketRef = useRef<HTMLDivElement>(null);
  const handlePrint = useReactToPrint({ contentRef: ticketRef });

  // Logo cacheado como data URL: imprime bien aunque no haya internet
  // (el logo vive en Cloudinary y offline la URL remota no carga).
  const [logoTicket, setLogoTicket] = useState<string | undefined>(undefined);
  useEffect(() => {
    let vivo = true;
    logoParaImprimir(negocioLogo).then(d => { if (vivo) setLogoTicket(d); });
    return () => { vivo = false; };
  }, [negocioLogo]);

  // Imprime por la vía configurada: ESC/POS directo o diálogo del navegador.
  // Recibe el número de ticket/ncf como argumento porque al auto-imprimir
  // el estado de React aún no se ha actualizado.
  const imprimirTicket = async (ticketNum?: number, ncfVenta?: string) => {
    if (impresion.modoImpresion === 'directa') {
      try {
        const { imprimirVentaDirecta } = await import('@/lib/print/tickets');
        await imprimirVentaDirecta({
          items: items.map(i => ({ cantidad: i.cantidad, nombre: i.nombre, precio: i.precio_venta, ubicacion: i.ubicacion })),
          subtotal, itbis, descuento, total,
          metodoPago,
          montoRecibido: metodoPago === 'efectivo' ? parseFloat(montoRecibido || '0') : total,
          devuelta: metodoPago === 'efectivo' ? devuelta : 0,
          negocio: {
            nombre: negocioNombre || 'VentaRD',
            rnc: negocioRnc || undefined,
            direccion: negocioDireccion || undefined,
            telefono: negocioTelefono || undefined,
          },
          numeroTicket: ticketNum ?? ultimoTicketNum,
          cajaCodigo: dispositivoId || undefined,
          ncf: ncfVenta ?? ultimoNcf,
          vendedor: nombreUsuario || undefined,
          clienteNombre: clienteNombreVenta.trim() || undefined,
          mensajePie: negocioMensajeTicket || undefined,
          logoUrl: logoTicket,
        }, impresion);
        return;
      } catch (e) {
        console.error('[print] impresión directa falló, usando navegador:', e);
        showToast('Impresora directa no disponible — usando impresión del navegador.', 'info');
      }
    }
    handlePrint();
  };

  const productosRaw = useLiveQuery(
    () => negocioId ? db.productos.where('negocio_id').equals(negocioId).limit(1).toArray() : [],
    [negocioId]
  );
  const catalogoIsLoading = productosRaw === undefined;
  const productosEnDBRaw = useProductosTenant();
  const productosEnDB = useMemo(() => productosEnDBRaw.filter(p => p.tipo !== 'insumo'), [productosEnDBRaw]);
  const clientes = useClientesTenant();
  const transacciones = useTransaccionesFiadoTenant();

  // Seriales disponibles del producto seleccionado para el modal
  const serialesDisponibles = useLiveQuery(async () => {
    if (!productoParaSerial) return [];
    return db.seriales
      .where('producto_id').equals(productoParaSerial.id)
      .filter(s => s.estado === 'disponible')
      .toArray();
  }, [productoParaSerial]) ?? [];

  // Firma del catálogo buscable: solo cambia si cambian nombres/códigos (no el stock).
  // Así el índice de Fuse no se reconstruye en cada tick de sincronización.
  const fuseSig = useMemo(() => productosEnDB.map(p => `${p.id}:${p.nombre}:${p.codigo_barras}`).join('|'), [productosEnDB]);
  const fuse = useMemo(
    () => new Fuse(productosEnDB, { keys: ['nombre', 'codigo_barras'], threshold: 0.4, ignoreLocation: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fuseSig]
  );
  const productosFiltrados = useMemo(() => {
    if (!searchTerm) return productosEnDB;
    return fuse.search(searchTerm).map(result => result.item);
  }, [searchTerm, fuse, productosEnDB]);

  // Renderizado progresivo: pinta un bloque y carga más al hacer scroll.
  // Mantiene la parrilla ágil con catálogos grandes sin perder ningún producto.
  const PAGINA_GRID = 48;
  const [limiteVisible, setLimiteVisible] = useState(PAGINA_GRID);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Reiniciar al cambiar la búsqueda (cada búsqueda empieza desde arriba)
  useEffect(() => { setLimiteVisible(PAGINA_GRID); }, [searchTerm]);

  const productosVisibles = useMemo(
    () => productosFiltrados.slice(0, limiteVisible),
    [productosFiltrados, limiteVisible]
  );
  const hayMas = limiteVisible < productosFiltrados.length;

  // Cargar más cuando el centinela entra en vista
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting) {
          setLimiteVisible(l => Math.min(l + PAGINA_GRID, productosFiltrados.length));
        }
      },
      { rootMargin: '300px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [productosFiltrados.length]);

  // ¿Hay números NCF disponibles para emitir? (bloques reservados o secuencia legada)
  const ncfDisponible =
    ncfConfig.bloques.some(b => b.proximo <= b.hasta) ||
    (!ncfConfig.sembrado && (ncfConfig.actual === 0 ? ncfConfig.desde : ncfConfig.actual + 1) <= ncfConfig.hasta);

  const devuelta = parseFloat(montoRecibido || '0') - total;
  const totalMixto = parseFloat(montoEfectivoMixto || '0') + parseFloat(montoTransferenciaMixto || '0');

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F2') { e.preventDefault(); searchInputRef.current?.focus(); }
      if (e.key === 'F4') { e.preventDefault(); setIsVentaLibreOpen(true); }
      if (e.key === ' ' && items.length > 0 && document.activeElement !== searchInputRef.current && !isCheckoutOpen && !isVentaLibreOpen) { e.preventDefault(); abrirModalCobro(); }
      if (e.key === 'Escape' && isCheckoutOpen && !ventaExitosa) { setIsCheckoutOpen(false); }
      if (e.key === 'Escape' && isVentaLibreOpen) { setIsVentaLibreOpen(false); }
      if (e.key === 'Escape' && isCartOpen) { setIsCartOpen(false); }
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
  }, [items, isCheckoutOpen, isVentaLibreOpen, isCartOpen, metodoPago, montoRecibido, total, ventaExitosa, searchTerm, productosFiltrados, productosEnDB, addItem]);

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
    // Pre-popular fiado con el cliente activo del carrito si existe
    setClienteSeleccionadoId(clienteActivoId ?? '');
    setClienteNombreVenta(clienteActivo?.nombre ?? '');
    setEmitirNcf(false);
    setIsCartOpen(false);
    setIsCheckoutOpen(true);
  };

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

  const procesarVentaBD = async () => {
    if (!negocioId) return;
    // Candado anti doble-cobro: en dispositivos lentos el usuario toca COBRAR
    // dos veces (o Enter + clic) y la venta/fiado se duplicaba. El ref bloquea
    // al instante (el estado tarda un render en deshabilitar el botón).
    if (procesandoVentaRef.current) return;
    procesandoVentaRef.current = true;
    setProcesandoVenta(true);

    try {
      // ── Validación de stock antes de procesar ────────────────────────────
      for (const item of items) {
        const receta = await db.composiciones.where('producto_padre_id').equals(item.id).toArray();
        if (receta.length === 0) {
          // Producto simple/insumo — verificar stock disponible
          const producto = await db.productos.get(item.id);
          if (producto && producto.stock_actual < item.cantidad) {
            showToast(
              `Stock insuficiente: ${producto.nombre} (disponible: ${producto.stock_actual < 0 ? 0 : producto.stock_actual})`,
              'error'
            );
            return;
          }
        }
      }

      const ncfGenerado = emitirNcf ? consumirNcf() || undefined : undefined;

      const cajaCodigo = getDispositivoId();
      const idVenta = uuidv4();

      await db.transaction('rw', [db.ventas, db.venta_detalles, db.productos, db.composiciones, db.transacciones_fiado, db.movimientos_stock], async () => {
        const ticketNum = await getNextTicketNumber(negocioId, cajaCodigo);

        await db.ventas.add({
          id: idVenta,
          negocio_id: negocioId,
          sucursal_id: sucursalId || undefined,
          numero_ticket: ticketNum,
          caja_codigo: cajaCodigo,
          ncf: ncfGenerado,
          ...(nombreUsuario && { vendedor_nombre: nombreUsuario }),
          total: total,
          metodo_pago: metodoPago,
          ...(metodoPago === 'mixto' && {
            monto_efectivo: parseFloat(montoEfectivoMixto || '0'),
            monto_transferencia: parseFloat(montoTransferenciaMixto || '0'),
          }),
          ...(metodoPago === 'fiado' && clienteSeleccionadoId && {
            cliente_id: clienteSeleccionadoId,
          }),
          ...(clienteNombreVenta.trim() && { cliente_nombre: clienteNombreVenta.trim() }),
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
              nombre: item.nombre,
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
            // Combo: descontar cada insumo según la receta
            for (const ingrediente of receta) {
              await registrarMovimientoStock({
                productoId: ingrediente.insumo_id,
                tipo: 'venta',
                delta: -(ingrediente.cantidad_necesaria * item.cantidad),
                referenciaId: idVenta,
              });
            }
          } else {
            await registrarMovimientoStock({
              productoId: item.id,
              tipo: 'venta',
              delta: -item.cantidad,
              referenciaId: idVenta,
            });
          }
        }
      });

      // Marcar seriales como vendidos (fuera de la transacción principal para no bloquearla)
      const serialesVendidos = items.filter(i => i.serial_id);
      if (serialesVendidos.length > 0) {
        // Manejador de evento (checkout): Date.now() es seguro aquí.
        // eslint-disable-next-line react-hooks/purity
        const ahoraSerial = Date.now();
        // Garantía (Plan Pro): se fija con el default del negocio; si es 0, sin garantía
        const dias = planTier === 'pro' ? (garantiaDiasDefault || 0) : 0;
        const garantiaHasta = dias > 0 ? ahoraSerial + dias * 24 * 60 * 60 * 1000 : null;
        const clienteVenta = clienteSeleccionadoId ? clientes.find(c => c.id === clienteSeleccionadoId) : null;
        await Promise.all(serialesVendidos.map(i =>
          db.seriales.update(i.serial_id!, {
            estado: 'vendido',
            venta_id: idVenta,
            fecha_venta: ahoraSerial,
            garantia_dias: dias,
            garantia_hasta: garantiaHasta,
            precio_venta: i.precio_venta,
            cliente_nombre: clienteVenta?.nombre ?? null,
            estado_sincronizacion: 0,
            fecha_actualizacion: ahoraSerial,
          })
        ));
      }

      const ticketNumFinal = await getNextTicketNumber(negocioId, cajaCodigo) - 1;
      setUltimoTicketNum(ticketNumFinal);
      // Persistir el último ticket emitido (sobrevive a la purga de datos viejos)
      useConfigStore.setState({ ultimoTicket: ticketNumFinal });
      setUltimoNcf(ncfGenerado);
      setUltimaVentaId(idVenta);
      setVentaExitosa(true);

      // Impresión automática al confirmar (pequeño delay para que React
      // renderice el ticket oculto con el número de ticket actualizado)
      if (impresion.autoImprimir) {
        setTimeout(() => imprimirTicket(ticketNumFinal, ncfGenerado), 400);
      }

    } catch (error) {
      console.error("Error en la transacción de venta:", error);
      showToast("Hubo un problema al procesar la venta.", "error");
    } finally {
      procesandoVentaRef.current = false;
      setProcesandoVenta(false);
    }
  };

  // Anula la venta recién hecha: devolución total auditable (queda en historial),
  // repone el stock, revierte el cargo de fiado y libera los seriales.
  const anularUltimaVenta = async () => {
    if (!negocioId || !ultimaVentaId || anulando) return;
    setAnulando(true);
    try {
      const idDevolucion = uuidv4();
      await db.transaction('rw', [db.devoluciones, db.productos, db.composiciones, db.transacciones_fiado, db.movimientos_stock], async () => {
        await db.devoluciones.add({
          id: idDevolucion,
          negocio_id: negocioId,
          venta_id: ultimaVentaId,
          items_devueltos: items.map(i => ({ producto_id: i.id, cantidad: i.cantidad, precio_unitario: i.precio_venta })),
          monto_devuelto: total,
          razon: `Venta anulada en caja${nombreUsuario ? ` por ${nombreUsuario}` : ''}`,
          fecha_creacion: Date.now(),
          estado_sincronizacion: 0,
        });

        // Reponer stock (combos vía receta)
        for (const item of items) {
          const receta = await db.composiciones.where('producto_padre_id').equals(item.id).toArray();
          if (receta.length > 0) {
            for (const ing of receta) {
              await registrarMovimientoStock({
                productoId: ing.insumo_id,
                tipo: 'devolucion',
                delta: ing.cantidad_necesaria * item.cantidad,
                referenciaId: idDevolucion,
              });
            }
          } else {
            await registrarMovimientoStock({
              productoId: item.id,
              tipo: 'devolucion',
              delta: item.cantidad,
              referenciaId: idDevolucion,
            });
          }
        }

        // Revertir el cargo de fiado con un abono automático
        if (metodoPago === 'fiado' && clienteSeleccionadoId) {
          await db.transacciones_fiado.add({
            id: uuidv4(),
            negocio_id: negocioId,
            cliente_id: clienteSeleccionadoId,
            venta_id: ultimaVentaId,
            tipo: 'abono',
            monto: total,
            concepto: 'Venta anulada en caja',
            fecha_creacion: Date.now(),
            estado_sincronizacion: 0,
            fecha_actualizacion: Date.now(),
          });
        }
      });

      // Liberar los seriales vendidos en esta venta
      const conSerial = items.filter(i => i.serial_id);
      if (conSerial.length > 0) {
        await Promise.all(conSerial.map(i =>
          db.seriales.update(i.serial_id!, {
            estado: 'disponible',
            venta_id: null,
            fecha_venta: null,
            garantia_dias: null,
            garantia_hasta: null,
            cliente_nombre: null,
            precio_venta: null,
            estado_sincronizacion: 0,
            fecha_actualizacion: Date.now(),
          })
        ));
      }

      setConfirmAnularOpen(false);
      setVentaExitosa(false);
      setIsCheckoutOpen(false);
      setUltimaVentaId(null);
      clearCart();
      setSearchTerm('');
      showToast('Venta anulada — el stock fue repuesto.', 'info');
      searchInputRef.current?.focus();
    } catch (e) {
      console.error('[anular]', e);
      showToast('No se pudo anular la venta. Hazlo desde Historial → Devolver.', 'error');
    } finally {
      setAnulando(false);
    }
  };

  // Handler estable para la parrilla: permite que ProductCard memoizado no se
  // re-renderice al teclear en el buscador.
  const onSelectProducto = useCallback((producto: ProductoLocal) => {
    if (producto.serializable) {
      setProductoParaSerial(producto);
      setBusquedaSerial('');
    } else {
      addItem(producto);
    }
  }, [addItem]);

  // Cliente activo derivado de la lista de clientes
  const clienteActivo = clientes.find(c => c.id === clienteActivoId) ?? null;
  const clientesFiltrados = busquedaCliente.trim()
    ? clientes.filter(c => c.nombre.toLowerCase().includes(busquedaCliente.toLowerCase()))
    : clientes.slice(0, 8);

  const seleccionarCliente = (cliente: typeof clientes[0]) => {
    setCliente(cliente.id, (cliente.tipo_precio ?? 1) as 1 | 2 | 3);
    setBusquedaCliente('');
    setMostrarDropdownCliente(false);
  };

  const quitarCliente = () => {
    setCliente(null, 1);
    setBusquedaCliente('');
    setMostrarDropdownCliente(false);
  };

  // Cart panel content - shared between desktop sidebar and mobile drawer
  const cartContent = (
    <>
      <div className="p-3 sm:p-4 border-b border-navy-3 flex justify-between items-center gap-2 min-w-0">
        <h2 className="text-base sm:text-lg font-display font-bold text-white shrink-0">Ticket</h2>
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          <button onClick={() => setIsCajaOpen(true)} className="text-xs text-gold hover:bg-gold/10 px-2 sm:px-3 py-1 rounded-lg transition-colors font-bold border border-gold/20 whitespace-nowrap">💰<span className="hidden sm:inline"> Caja</span></button>
          {items.length > 0 && (
            <button
              onClick={() => {
                const ok = pausarVenta(clienteActivo?.nombre ?? null);
                showToast(ok ? 'Venta en espera. Puedes atender al próximo cliente.' : 'Límite de ventas en espera alcanzado.', ok ? 'success' : 'error');
              }}
              className="text-xs text-blue-300 hover:bg-blue-400/10 px-2 sm:px-3 py-1 rounded-lg transition-colors font-bold border border-blue-400/20 whitespace-nowrap"
              title="Pausar esta venta"
            >
              ⏸<span className="hidden sm:inline"> En espera</span>
            </button>
          )}
          <button onClick={clearCart} className="text-xs text-vr-red hover:bg-vr-red/10 px-2 sm:px-3 py-1 rounded-lg transition-colors font-bold whitespace-nowrap">Limpiar</button>
          <button onClick={() => setIsCartOpen(false)} className="lg:hidden text-vr-gray hover:text-white font-bold text-xl px-1 transition-colors">✕</button>
        </div>
      </div>

      {/* Ventas en espera (facturas pausadas) */}
      {enEspera.length > 0 && (
        <div className="px-3 sm:px-4 pt-2.5 pb-2 border-b border-navy-3/50">
          <p className="text-[10px] font-black text-vr-gray uppercase tracking-wider mb-1.5">⏸ En espera ({enEspera.length})</p>
          <div className="space-y-1.5 max-h-36 overflow-y-auto">
            {enEspera.map(v => {
              const totalV = v.items.reduce((s, i) => s + i.precio_venta * i.cantidad, 0);
              return (
                <div key={v.id} className="flex items-center gap-2 bg-blue-400/10 border border-blue-400/25 rounded-xl pl-3 pr-1 py-1.5">
                  <button
                    onClick={() => { retomarVenta(v.id, clienteActivo?.nombre ?? null); showToast('Venta retomada.', 'info'); }}
                    className="flex-1 min-w-0 flex items-center justify-between gap-2 text-left"
                    title="Retomar esta venta"
                  >
                    <span className="text-xs font-bold text-white truncate">
                      {v.etiqueta || `Venta #${v.numero}`}
                    </span>
                    <span className="text-[10px] text-vr-gray font-mono shrink-0">
                      {v.items.length} ít. · {formatDOP(totalV)} · {new Date(v.creado).toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </button>
                  <button
                    onClick={() => setDescartandoEspera(v.id)}
                    className="text-vr-gray hover:text-vr-red font-bold px-1.5 text-sm transition-colors shrink-0"
                    aria-label="Descartar venta en espera"
                  >✕</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Selector de cliente para pricing */}
      <div className="px-3 sm:px-4 pt-2.5 pb-1 border-b border-navy-3/50 relative">
        {clienteActivo ? (
          <div className="flex items-center justify-between bg-navy-3/60 rounded-xl px-3 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-lg">👤</span>
              <div className="min-w-0">
                <p className="text-sm font-bold text-white truncate">{clienteActivo.nombre}</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-[10px] font-black bg-gold/20 text-gold px-1.5 py-0.5 rounded">
                    Precio {tipoPrecios}
                  </span>
                  {clienteActivo.al_por_mayor && (
                    <span className="text-[10px] font-black bg-vr-green/15 text-vr-green px-1.5 py-0.5 rounded">Mayor</span>
                  )}
                </div>
              </div>
            </div>
            <button onClick={quitarCliente} className="text-vr-gray hover:text-vr-red text-lg font-bold px-1 transition-colors shrink-0">✕</button>
          </div>
        ) : (
          <div className="relative">
            <input
              type="text"
              placeholder="+ Cliente (precio especial)"
              className="w-full text-xs bg-navy-3/40 border border-navy-3 rounded-xl px-3 py-2 text-vr-gray placeholder-vr-gray/50 focus:border-gold/50 focus:text-white outline-none transition-all"
              value={busquedaCliente}
              onChange={e => { setBusquedaCliente(e.target.value); setMostrarDropdownCliente(true); }}
              onFocus={() => setMostrarDropdownCliente(true)}
              onBlur={() => setTimeout(() => setMostrarDropdownCliente(false), 150)}
            />
            {mostrarDropdownCliente && clientes.length > 0 && (
              <div className="absolute z-50 w-full bg-navy border border-navy-3 rounded-xl mt-1 shadow-xl max-h-48 overflow-y-auto">
                {clientesFiltrados.length === 0 ? (
                  <p className="text-vr-gray text-xs p-3 text-center">Sin resultados</p>
                ) : clientesFiltrados.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    onMouseDown={() => seleccionarCliente(c)}
                    className="w-full text-left px-3 py-2.5 hover:bg-navy-3 transition-colors border-b border-navy-3/50 last:border-0 flex items-center justify-between gap-2"
                  >
                    <span className="text-sm font-bold text-white truncate">{c.nombre}</span>
                    <div className="flex items-center gap-1 shrink-0">
                      {c.al_por_mayor && (
                        <span className="text-[10px] font-black bg-vr-green/15 text-vr-green px-1 py-0.5 rounded">Mayor</span>
                      )}
                      {(c.tipo_precio ?? 1) > 1 && (
                        <span className="text-[10px] font-black bg-gold/15 text-gold px-1 py-0.5 rounded">P{c.tipo_precio}</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3">
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
              <div className="flex-1 min-w-0 pr-2">
                <h4 className="font-medium text-white text-sm truncate">{item.nombre}</h4>
                {item.serial_numero && (
                  <p className="text-[10px] font-mono text-gold/70 truncate">S/N: {item.serial_numero}</p>
                )}
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
              <div className="font-bold font-mono text-white text-sm shrink-0">{formatDOP(item.precio_venta * item.cantidad)}</div>
            </div>
          ))
        )}
      </div>

      <div className="p-3 sm:p-4 bg-navy border-t border-navy-3">
        <div className="space-y-1 mb-3 text-sm">
          <div className="flex justify-between text-vr-gray"><span>Subtotal</span><span className="font-mono">{formatDOP(subtotal)}</span></div>
          <div className="flex justify-between text-vr-gray"><span>ITBIS</span><span className="font-mono">{formatDOP(itbis)}</span></div>
          {descuento > 0 && (
            <div className="flex justify-between text-vr-green font-bold">
              <span>Descuento {tipoDescuento === 'porcentaje' ? `(${valorDescuento}%)` : ''}</span>
              <span className="font-mono">- {formatDOP(descuento)}</span>
            </div>
          )}
          <div className="flex justify-between text-xl sm:text-2xl font-black text-white pt-2 border-t border-navy-3 mt-2">
            <span>Total</span><span className="font-mono text-gold">{formatDOP(total)}</span>
          </div>
        </div>
        <button
          onClick={abrirModalCobro} disabled={items.length === 0}
          className="w-full bg-gold-gradient text-navy text-base sm:text-lg font-extrabold py-3 sm:py-4 rounded-xl hover:brightness-110 transition-all disabled:opacity-30 disabled:cursor-not-allowed shadow-lg relative"
        >
          Cobrar Venta
          <span className="hidden sm:inline absolute right-4 top-1/2 -translate-y-1/2 text-[10px] font-mono font-normal bg-navy/20 px-2 py-0.5 rounded">ESPACIO</span>
        </button>
      </div>
    </>
  );

  return (
    <div className="flex flex-col h-screen bg-navy overflow-hidden">
      <TopBar />
      <OfflineBanner />

      <div className="flex flex-col lg:flex-row flex-1 overflow-hidden relative">
        {/* COMPONENTE OCULTO DE IMPRESIÓN */}
        <div style={{ display: "none" }}>
          <TicketVenta
            ref={ticketRef} items={items} subtotal={subtotal} itbis={itbis} descuento={descuento} total={total}
            metodoPago={metodoPago} montoRecibido={montoRecibido} devuelta={devuelta}
            nombreNegocio={negocioNombre || 'VentaRD'} rnc={negocioRnc || undefined}
            direccion={negocioDireccion || undefined} telefono={negocioTelefono || undefined}
            numeroTicket={ultimoTicketNum} mensajePie={negocioMensajeTicket || undefined}
            cajaCodigo={dispositivoId || undefined}
            ncf={ultimoNcf}
            logoUrl={logoTicket}
            vendedor={nombreUsuario || undefined}
            clienteNombre={clienteNombreVenta.trim() || undefined}
          />
        </div>

        {/* COLUMNA IZQUIERDA: CATÁLOGO */}
        <div className="flex-1 flex flex-col p-3 sm:p-4 overflow-hidden">
          <div className="mb-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  ref={searchInputRef} type="text" placeholder="Buscar producto (F2)"
                  className="w-full px-4 py-3 text-sm sm:text-base bg-navy-2 border border-navy-3 rounded-xl focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none text-white placeholder-vr-gray transition-all"
                  value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} autoFocus
                />
                <span className="hidden sm:block absolute right-3 top-3 text-vr-gray font-mono text-xs bg-navy-3 px-2 py-1 rounded">F2</span>
              </div>
              <button
                onClick={() => setScannerProductoPOS(true)}
                title="Escanear código de barras con la cámara"
                className="px-3 sm:px-4 py-3 bg-navy-2 border border-navy-3 rounded-xl text-vr-gray hover:text-gold hover:border-gold/30 transition-all font-bold text-sm flex items-center gap-1 sm:gap-2 whitespace-nowrap"
              >
                📷 <span className="hidden sm:inline">Escanear</span>
              </button>
              <button
                onClick={() => setIsVentaLibreOpen(true)}
                className="px-3 sm:px-4 py-3 bg-navy-2 border border-navy-3 rounded-xl text-vr-gray hover:text-gold hover:border-gold/30 transition-all font-bold text-sm flex items-center gap-1 sm:gap-2 whitespace-nowrap"
              >
                ⚡ <span className="hidden sm:inline">Libre</span>
              </button>
            </div>
          </div>

          {/* Product grid - extra bottom padding on mobile for floating button */}
          <div className="flex-1 overflow-y-auto pr-1 pb-20 lg:pb-2">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-2 sm:gap-3">
              {catalogoIsLoading ? (
                <SkeletonProductGrid count={12} />
              ) : productosFiltrados.length === 0 ? (
                <div className="col-span-full flex flex-col justify-center items-center h-40 text-vr-gray">
                  <span className="text-4xl mb-2">📦</span>
                  <span className="font-medium text-sm">No se encontraron productos</span>
                </div>
              ) : (
                productosVisibles.map((producto) => (
                  <ProductCard key={producto.id} producto={producto} onSelect={onSelectProducto} />
                ))
              )}
            </div>
            {/* Centinela de scroll infinito + contador */}
            {hayMas && (
              <div ref={sentinelRef} className="col-span-full py-4 text-center text-xs text-vr-gray">
                Mostrando {productosVisibles.length} de {productosFiltrados.length}…
              </div>
            )}
          </div>
        </div>

        {/* MOBILE: Overlay when cart is open */}
        {isCartOpen && (
          <div
            className="lg:hidden fixed inset-0 bg-black/70 backdrop-blur-sm z-40"
            onClick={() => setIsCartOpen(false)}
          />
        )}

        {/* CART — mobile: bottom drawer, desktop: fixed sidebar */}
        <div className={`
          ${isCartOpen ? 'flex' : 'hidden lg:flex'}
          flex-col
          fixed bottom-0 left-0 right-0 lg:static
          max-h-[88vh] lg:max-h-none lg:h-auto
          lg:w-96 lg:shrink-0
          bg-navy-2
          border-t lg:border-t-0 lg:border-l border-navy-3
          rounded-t-2xl lg:rounded-none
          z-50 lg:z-10
          overflow-hidden
        `}>
          {cartContent}
        </div>

        {/* MOBILE: Floating cart button (visible when cart is closed) */}
        {!isCartOpen && (
          <div className="lg:hidden fixed bottom-0 left-0 right-0 z-30 p-3 bg-navy/95 border-t border-navy-3 backdrop-blur-sm">
            <button
              onClick={() => setIsCartOpen(true)}
              disabled={items.length === 0}
              className="w-full bg-gold-gradient text-navy font-extrabold py-3.5 rounded-xl disabled:opacity-30 flex items-center justify-between px-5 shadow-xl"
            >
              <span className="text-sm">
                {items.length > 0 ? `${items.length} ítem${items.length > 1 ? 's' : ''} • Ver Carrito` : 'Carrito vacío'}
              </span>
              <span className="font-mono font-black">{formatDOP(total)}</span>
            </button>
          </div>
        )}
      </div>

      {/* MODAL DE COBRO */}
      {isCheckoutOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
          <div className="bg-navy-2 w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[95vh] sm:max-h-[90vh] border border-navy-3 animate-scale-in">

            {ventaExitosa ? (
              <div className="p-6 sm:p-10 text-center flex flex-col items-center justify-center">
                <div className="w-16 h-16 sm:w-20 sm:h-20 bg-vr-green/15 text-vr-green rounded-full flex items-center justify-center text-3xl sm:text-4xl mb-4 sm:mb-5 border border-vr-green/30 animate-scale-in">✓</div>
                <h2 className="text-2xl sm:text-3xl font-display font-black text-white mb-2">¡Venta Exitosa!</h2>
                {ultimoTicketNum && <p className="text-vr-gray font-mono text-sm mb-4">Ticket #{formatTicket(ultimoTicketNum, dispositivoId || undefined)}</p>}
                {metodoPago === 'efectivo' && (
                  <div className="bg-vr-green/10 border border-vr-green/20 rounded-xl px-6 py-3 mb-6">
                    <p className="text-sm text-vr-gray">Devuelta</p>
                    <p className="text-3xl font-black font-mono text-vr-green">{formatDOP(devuelta)}</p>
                  </div>
                )}
                {metodoPago === 'mixto' && (
                  <div className="bg-navy border border-navy-3 rounded-xl px-6 py-3 mb-6 space-y-1 w-full max-w-xs">
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
                      const clienteRecibo = (clienteSeleccionadoId ? clientes.find(c => c.id === clienteSeleccionadoId) : null) ?? clienteActivo;
                      const encabezado = `*${negocioNombre || 'VentaRD'}*${negocioRnc ? `\nRNC: ${negocioRnc}` : ''}${negocioDireccion ? `\n${negocioDireccion}` : ''}${negocioTelefono ? `\nTel: ${negocioTelefono}` : ''}`;
                      const pie = negocioMensajeTicket || '¡Gracias por su compra!';
                      const lineas = items.map(i => `${i.cantidad}x ${i.nombre} — ${formatDOP(i.precio_venta * i.cantidad)}`).join('\n');
                      const metodoTxt: Record<string, string> = { efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta: 'Tarjeta', mixto: 'Mixto', fiado: 'Fiado' };
                      const resumen =
                        `${encabezado}\n` +
                        `Recibo #${formatTicket(ultimoTicketNum, dispositivoId || undefined)}\n` +
                        `${'—'.repeat(20)}\n` +
                        `${lineas}\n` +
                        `${'—'.repeat(20)}\n` +
                        (descuento > 0 ? `Subtotal: ${formatDOP(subtotal + itbis)}\nDescuento: -${formatDOP(descuento)}\n` : '') +
                        `*Total: ${formatDOP(total)}*\n` +
                        `Pago: ${metodoTxt[metodoPago] || metodoPago}\n\n` +
                        `${pie}\n\n` +
                        `_Hecho con VentaRD_`;
                      window.open(linkWhatsApp(resumen, clienteRecibo?.telefono), '_blank');
                    }}
                    className="flex-1 py-3 bg-vr-green/15 text-vr-green font-bold rounded-xl border border-vr-green/20 hover:bg-vr-green/25 transition-all text-sm flex items-center justify-center gap-2"
                  >
                    📱 WhatsApp
                  </button>
                  <button
                    onClick={() => { imprimirTicket(); }}
                    className="flex-1 py-3 bg-navy-3 text-white font-bold rounded-xl border border-navy-4 hover:bg-navy-4 transition-all text-sm"
                  >
                    🖨️ Imprimir ticket
                  </button>
                </div>
                <button
                  onClick={() => {
                    setVentaExitosa(false);
                    setIsCheckoutOpen(false);
                    clearCart(); // clearCart ya resetea clienteActivoId y tipoPrecios
                    setSearchTerm('');
                    searchInputRef.current?.focus();
                  }}
                  className="mt-4 w-full max-w-sm py-4 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all text-lg"
                >
                  Nueva Venta →
                </button>
                <button
                  onClick={() => setConfirmAnularOpen(true)}
                  disabled={anulando}
                  className="mt-3 text-vr-red/70 hover:text-vr-red text-xs font-bold hover:bg-vr-red/10 px-4 py-2 rounded-lg transition-all disabled:opacity-50"
                >
                  ✕ Me equivoqué — anular esta venta
                </button>
              </div>
            ) : (
              <>
                <div className="p-4 sm:p-6 bg-navy border-b border-navy-3 flex justify-between items-center">
                  <h2 className="text-lg sm:text-xl font-display font-bold text-white">Completar Pago</h2>
                  <button onClick={() => setIsCheckoutOpen(false)} className="text-vr-gray hover:text-white font-bold text-xl px-2 transition-colors">✕</button>
                </div>

                <div className="p-4 sm:p-6 flex-1 overflow-y-auto">
                  <div className="text-center mb-6">
                    <p className="text-vr-gray mb-1 text-sm">Monto a Cobrar</p>
                    <p className="text-4xl sm:text-5xl font-black font-mono text-gold">{formatDOP(total)}</p>
                  </div>

                  {/* Payment method buttons - 2 cols on xs, 3 on sm, 5 on md */}
                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-6">
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
                        className={`py-3 rounded-xl font-bold text-xs sm:text-sm border transition-all ${
                          metodoPago === key
                            ? 'border-gold bg-gold/15 text-gold shadow-md'
                            : 'border-navy-3 bg-navy-3 text-vr-gray hover:border-navy-4 hover:text-white'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {/* Nombre del cliente para la factura (texto libre, opcional) */}
                  <div className="mb-4 sm:mb-6">
                    <label className="block text-xs font-bold text-vr-gray mb-1.5">👤 Cliente para la factura <span className="font-normal text-vr-gray/60">(opcional)</span></label>
                    <input
                      type="text" placeholder="Nombre del cliente — sale impreso en el ticket"
                      className="w-full bg-navy border border-navy-3 rounded-xl px-3 py-2.5 text-sm text-white placeholder-vr-gray/50 focus:border-gold outline-none transition-all"
                      value={clienteNombreVenta} onChange={e => setClienteNombreVenta(e.target.value)}
                    />
                  </div>

                  {/* QR de transferencia (si el negocio configuró sus datos de pago) */}
                  {metodoPago === 'transferencia' && (
                    <div className="mb-4 sm:mb-6">
                      <QrTransferencia monto={total} />
                    </div>
                  )}

                  {/* DESCUENTO */}
                  <div className="bg-navy p-3 sm:p-4 rounded-xl border border-navy-3 mb-4 sm:mb-6">
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
                    <div className="bg-navy p-4 sm:p-6 rounded-xl border border-navy-3">
                      <label className="block text-sm font-bold text-vr-gray mb-3">¿Con cuánto paga el cliente?</label>
                      <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
                        <button onClick={() => setMontoRecibido(total.toString())} className="px-3 sm:px-4 py-2 bg-vr-green/15 text-vr-green font-bold rounded-lg border border-vr-green/20 hover:bg-vr-green/25 text-sm whitespace-nowrap">Exacto</button>
                        <button onClick={() => setMontoRecibido('500')} className="px-3 sm:px-4 py-2 bg-navy-3 font-bold rounded-lg border border-navy-4 hover:bg-navy-4 text-white text-sm">RD$500</button>
                        <button onClick={() => setMontoRecibido('1000')} className="px-3 sm:px-4 py-2 bg-navy-3 font-bold rounded-lg border border-navy-4 hover:bg-navy-4 text-white text-sm">RD$1,000</button>
                        <button onClick={() => setMontoRecibido('2000')} className="px-3 sm:px-4 py-2 bg-navy-3 font-bold rounded-lg border border-navy-4 hover:bg-navy-4 text-white text-sm">RD$2,000</button>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xl font-bold text-vr-gray font-mono">RD$</span>
                        <input
                          ref={inputMontoRef} type="number"
                          className="w-full text-3xl sm:text-4xl font-black font-mono bg-transparent border-b-2 border-navy-3 focus:border-gold focus:outline-none py-2 text-white"
                          placeholder="0.00" value={montoRecibido} onChange={(e) => setMontoRecibido(e.target.value)}
                        />
                      </div>
                      {parseFloat(montoRecibido || '0') >= total && (
                        <div className="mt-4 p-3 sm:p-4 bg-vr-green/10 border border-vr-green/20 rounded-xl flex justify-between items-center">
                          <span className="text-vr-green font-bold text-base">Devuelta:</span>
                          <span className="text-2xl sm:text-3xl font-black font-mono text-vr-green">{formatDOP(devuelta)}</span>
                        </div>
                      )}
                      {(parseFloat(montoRecibido || '0') > 0 && parseFloat(montoRecibido || '0') < total) && (
                        <div className="mt-4 p-3 bg-vr-red/10 border border-vr-red/20 text-vr-red rounded-xl font-bold text-center text-sm">Falta dinero para completar la venta</div>
                      )}
                    </div>
                  )}

                  {metodoPago === 'fiado' && (
                    <div className={`p-4 sm:p-6 rounded-xl border mb-4 ${excedeCredito ? 'bg-vr-red/5 border-vr-red/30' : 'bg-vr-orange/5 border-vr-orange/20'}`}>
                      <label className="block text-sm font-bold text-vr-orange mb-3">Seleccionar Cliente para Fiado</label>
                      <select
                        className="w-full text-base bg-navy border border-navy-3 focus:border-gold focus:outline-none py-3 px-4 rounded-lg font-bold text-white"
                        value={clienteSeleccionadoId}
                        onChange={(e) => {
                          setClienteSeleccionadoId(e.target.value);
                          // Prellenar el nombre de la factura con el cliente del fiado
                          const c = clientes.find(x => x.id === e.target.value);
                          if (c) setClienteNombreVenta(c.nombre);
                        }}
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
                        <div className={`mt-4 p-3 sm:p-4 rounded-xl border text-sm ${excedeCredito ? 'bg-vr-red/10 border-vr-red/30 text-vr-red' : 'bg-navy border-navy-3 text-vr-gray'}`}>
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
                            <p className="mt-3 font-bold text-center text-sm">
                              Excede el límite por {formatDOP((balanceClienteSeleccionado + total) - limiteClienteSeleccionado)}.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {metodoPago === 'mixto' && (
                    <div className="bg-navy p-4 sm:p-6 rounded-xl border border-navy-3 space-y-4">
                      <p className="text-sm font-bold text-vr-gray">Divide el pago entre efectivo y transferencia</p>
                      <div className="grid grid-cols-2 gap-3 sm:gap-4">
                        <div>
                          <label className="block text-xs font-bold text-vr-green mb-2 uppercase tracking-wider">Efectivo (RD$)</label>
                          <input
                            type="number" step="0.01" min="0"
                            className="w-full text-xl sm:text-2xl font-black font-mono bg-transparent border-b-2 border-navy-3 focus:border-vr-green focus:outline-none py-2 text-white"
                            placeholder="0.00"
                            value={montoEfectivoMixto}
                            onChange={e => setMontoEfectivoMixto(e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-purple-400 mb-2 uppercase tracking-wider">Transfer. (RD$)</label>
                          <input
                            type="number" step="0.01" min="0"
                            className="w-full text-xl sm:text-2xl font-black font-mono bg-transparent border-b-2 border-navy-3 focus:border-purple-400 focus:outline-none py-2 text-white"
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

                <div className="p-4 sm:p-6 bg-navy border-t border-navy-3 space-y-3">
                  {/* Aviso: NCF habilitado pero sin números disponibles en esta caja */}
                  {ncfConfig.habilitado && !ncfDisponible && (
                    <div className="w-full px-4 py-3 rounded-xl border border-vr-orange/30 bg-vr-orange/10 text-vr-orange text-sm font-bold text-center">
                      Sin comprobantes fiscales disponibles — conéctate a internet para reservar más
                    </div>
                  )}
                  {/* Toggle NCF — solo aparece si el negocio tiene NCF configurado y hay números */}
                  {ncfConfig.habilitado && ncfDisponible && (
                    <button
                      type="button"
                      onClick={() => setEmitirNcf(v => !v)}
                      className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all ${
                        emitirNcf
                          ? 'bg-blue-500/10 border-blue-400/30 text-blue-300'
                          : 'bg-navy-2 border-navy-3 text-vr-gray'
                      }`}
                    >
                      <span className="text-sm font-bold">
                        {emitirNcf ? '✓ Emitir comprobante fiscal' : 'Sin comprobante fiscal'}
                      </span>
                      <div className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${emitirNcf ? 'bg-blue-400' : 'bg-navy-3'}`}>
                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${emitirNcf ? 'translate-x-5' : ''}`} />
                      </div>
                    </button>
                  )}

                  <button
                    onClick={procesarVentaBD} disabled={!esMontoValido || procesandoVenta}
                    className="w-full bg-gold-gradient text-navy text-lg sm:text-xl font-extrabold py-4 sm:py-5 rounded-xl hover:brightness-110 transition-all disabled:opacity-30 disabled:cursor-not-allowed flex justify-center items-center gap-2"
                  >
                    {procesandoVenta ? 'Procesando…' : 'Confirmar e Imprimir'}
                    {!procesandoVenta && <span className="hidden sm:inline text-xs font-mono font-normal bg-navy/20 px-2 py-1 rounded ml-2">ENTER</span>}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* MODAL SELECTOR DE SERIAL */}
      {productoParaSerial && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
          <div className="bg-navy-2 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden max-h-[80vh] flex flex-col animate-scale-in">
            <div className="p-4 border-b border-navy-3 flex justify-between items-start">
              <div>
                <h2 className="text-base font-display font-bold text-white">Seleccionar serial</h2>
                <p className="text-xs text-vr-gray mt-0.5 truncate max-w-[200px]">{productoParaSerial.nombre}</p>
              </div>
              <button onClick={() => setProductoParaSerial(null)} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
            </div>

            <div className="p-3 border-b border-navy-3/50 flex gap-2">
              <input
                type="text"
                autoFocus
                placeholder="Buscar número de serie…"
                className="flex-1 bg-navy-3 border border-navy-3 rounded-xl px-3 py-2.5 text-white text-sm font-mono placeholder-vr-gray/40 focus:border-gold outline-none transition-all"
                value={busquedaSerial}
                onChange={e => setBusquedaSerial(e.target.value)}
              />
              <button
                onClick={() => setScannerSerialPOS(true)}
                className="px-3 bg-navy-3 border border-navy-3 rounded-xl text-vr-gray hover:text-gold hover:border-gold/50 transition-all"
                title="Escanear IMEI con cámara"
              >
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/>
                  <path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
                  <line x1="7" y1="12" x2="7" y2="12.01"/><line x1="12" y1="12" x2="17" y2="12"/>
                  <line x1="7" y1="8" x2="7" y2="16"/><line x1="12" y1="8" x2="12" y2="16"/>
                  <line x1="17" y1="8" x2="17" y2="16"/>
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {serialesDisponibles.length === 0 ? (
                <div className="py-10 text-center text-vr-gray">
                  <p className="text-3xl mb-2">📦</p>
                  <p className="text-sm font-medium">Sin seriales disponibles</p>
                  <p className="text-xs mt-1">Registra una entrada en Inventario</p>
                </div>
              ) : (
                serialesDisponibles
                  .filter(s => !busquedaSerial || s.numero_serial.toLowerCase().includes(busquedaSerial.toLowerCase()))
                  // Ocultar seriales ya en el carrito
                  .filter(s => !items.some(i => i.serial_id === s.id))
                  .map(serial => (
                    <button
                      key={serial.id}
                      onClick={() => {
                        addItemConSerial(productoParaSerial, serial.id, serial.numero_serial);
                        setProductoParaSerial(null);
                      }}
                      className="w-full text-left px-4 py-3 rounded-xl hover:bg-navy-3 transition-colors border border-transparent hover:border-gold/20 mb-1 flex items-center justify-between group"
                    >
                      <span className="font-mono text-sm text-white group-hover:text-gold-2 transition-colors">{serial.numero_serial}</span>
                      <span className="text-xs font-bold text-vr-green bg-vr-green/10 px-2 py-0.5 rounded">Disponible</span>
                    </button>
                  ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Scanner IMEI en el POS — busca y selecciona el serial automáticamente */}
      {scannerSerialPOS && productoParaSerial && (
        <Suspense fallback={null}>
          <BarcodeScanner
            onScan={(code) => {
              const serial = serialesDisponibles.find(s => s.numero_serial === code);
              if (serial) {
                addItemConSerial(productoParaSerial, serial.id, serial.numero_serial);
                setProductoParaSerial(null);
              } else {
                // No encontrado: dejar el código en el buscador para que el cajero vea
                setBusquedaSerial(code);
              }
              setScannerSerialPOS(false);
            }}
            onClose={() => setScannerSerialPOS(false)}
          />
        </Suspense>
      )}

      {/* ESCÁNER DE CÁMARA PARA PRODUCTOS */}
      {scannerProductoPOS && (
        <Suspense fallback={null}>
          <BarcodeScanner
            onScan={(code) => {
              setScannerProductoPOS(false);
              const producto = productosEnDB.find(p => p.codigo_barras === code);
              if (producto) {
                // Respeta el flujo de seriales (abre el selector si aplica)
                onSelectProducto(producto);
                showToast(`${producto.nombre} ${producto.serializable ? '— elige el serial' : 'agregado al carrito'}`, 'success');
              } else {
                // No existe: dejar el código en el buscador para que el cajero
                // lo vea y decida (crear el producto o venta libre)
                setSearchTerm(code);
                showToast('Ese código no está en tu inventario.', 'info');
              }
            }}
            onClose={() => setScannerProductoPOS(false)}
          />
        </Suspense>
      )}

      {/* MODAL VENTA LIBRE (F4) */}
      <VentaLibreModal isOpen={isVentaLibreOpen} onClose={() => setIsVentaLibreOpen(false)} />

      {/* MODAL APERTURA/CIERRE DE CAJA */}
      <CajaModal isOpen={isCajaOpen} onClose={() => setIsCajaOpen(false)} />

      {/* CONFIRMACIÓN DE ANULACIÓN — el cajero necesita autorización del admin */}
      <ConfirmModal
        isOpen={confirmAnularOpen}
        title="Anular esta venta"
        mensaje="Se repondrá el stock y la venta quedará registrada como devolución en el historial."
        confirmLabel="Anular venta"
        requierePinAdmin={rolUsuario === 'cajero'}
        procesando={anulando}
        onConfirm={anularUltimaVenta}
        onClose={() => setConfirmAnularOpen(false)}
      />

      {/* CONFIRMACIÓN DE DESCARTE DE VENTA EN ESPERA */}
      <ConfirmModal
        isOpen={descartandoEspera !== null}
        title="Descartar venta en espera"
        mensaje="Los productos de esta venta pausada se descartarán. El stock no se afecta (solo se descuenta al cobrar)."
        confirmLabel="Descartar"
        onConfirm={() => { if (descartandoEspera) descartarEnEspera(descartandoEspera); setDescartandoEspera(null); }}
        onClose={() => setDescartandoEspera(null)}
      />
    </div>
  );
}
