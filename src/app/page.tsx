// src/app/page.tsx
'use client';

import { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore, memo, lazy, Suspense } from 'react';
import { useConfigStore, getDispositivoId } from '@/store/useConfigStore';
import { useCartStore, mismoScope, type CartScope } from '@/store/useCartStore';
import { ProductoLocal } from '@/types/database';
import { formatDOP, formatTicket } from '@/lib/utils';
import { linkWhatsApp } from '@/lib/whatsapp';
import { logoParaImprimir } from '@/lib/logoCache';
import QrTransferencia from '@/components/shared/QrTransferencia';
import { miniatura } from '@/lib/imagen';
import Fuse from 'fuse.js';
import { useReactToPrint } from 'react-to-print';
import { TicketVenta } from '@/components/TicketVenta';
import { db } from '@/lib/db/dexie';
import { confirmarDevolucionLocal } from '@/lib/domain/devoluciones/confirmarDevolucionLocal';
import { useClientesTenant, useTransaccionesFiadoTenant } from '@/lib/db/tenantQuery';
import { v4 as uuidv4 } from 'uuid';
import TopBar from '@/components/shared/TopBar';
const BarcodeScanner = lazy(() => import('@/components/ui/BarcodeScanner'));
import OfflineBanner from '@/components/shared/OfflineBanner';
import VentaLibreModal from '@/components/shared/VentaLibreModal';
import { localCommandError } from '@/lib/domain/local/errors';
import CajaModal from '@/components/shared/CajaModal';
import ConfirmModal from '@/components/ui/ConfirmModal';
import { SkeletonProductGrid } from '@/components/ui/Skeleton';
import { useLiveQuery } from 'dexie-react-hooks';
import { estaSyncActivo, iniciarMedicion, type ResultadoMetrica } from '@/lib/rendimiento';
import { prepararCheckoutLocal, confirmarCheckoutLocal, leerCheckoutLocal, listarCheckoutsSinResolver,
  abandonarCheckoutLocal, abandonarBorradorSinCheckout, reconocerCheckoutLocal, type CheckoutLocal } from '@/lib/domain/ventas/checkoutLocal';
import { VERSION_CONTRATO_VENTA, asegurarContratoPreparacionVenta } from '@/lib/domain/ventas/contrato';
import type { ConfirmarVentaLocalEntrada } from '@/lib/domain/ventas/confirmarVentaLocal';
import { moneyCents } from '@/lib/domain/local/command';
import { estadoNcfLocal } from '@/lib/domain/ventas/ncfLocal';
import {sharedBalanceCents} from '@/lib/sync/shared-balance';
import { resolveCurrentCatalogMatches } from '@/lib/catalog/search';
import { catalogAtScope, requireProductAtScope } from '@/lib/sync/inventory/scope-stock';
import { catalogWindow, extendCatalogWindow } from '@/lib/catalog/window';
import { devueltaVerificable, resumenBorrador, debeConfirmarConEnter, puedeAbrirCarrito } from '@/lib/domain/ventas/presentacion';

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
  const { negocioId, negocioNombre, sucursalId, showToast, negocioRnc, negocioTelefono, negocioDireccion, negocioMensajeTicket, negocioLogo, nombreUsuario, rolUsuario, ncf: ncfConfig, impresion, planTier, garantiaDiasDefault } = useConfigStore();
  const cart = useCartStore();
  const activarScope = cart.activarScope;
  const cartHydrated = useSyncExternalStore(useCallback(cb => {
    const off = useCartStore.persist.onFinishHydration(cb);
    const start = useCartStore.persist.onHydrate(cb);
    return () => { off(); start(); };
  }, []), () => useCartStore.persist.hasHydrated(), () => false);
  const scope = useMemo<CartScope | null>(() => negocioId ? { negocioId, sucursalId: sucursalId || null } : null, [negocioId, sucursalId]);
  useEffect(() => { if (cartHydrated && scope) activarScope(scope); }, [cartHydrated, scope, activarScope]);
  const cartReady = cartHydrated && mismoScope(cart.scope, scope);
  const { tipoDescuento, valorDescuento, tipoPrecios } = cart;
  const items = cartReady ? cart.items : [];
  const subtotal = cartReady ? cart.subtotal : 0, itbis = cartReady ? cart.itbis : 0;
  const descuento = cartReady ? cart.descuento : 0, total = cartReady ? cart.total : 0;
  const errorCalculo = cartReady ? cart.errorCalculo : null;
  const formatCartAmount = (amount: number) => errorCalculo ? 'No verificable' : formatDOP(amount);
  const clienteActivoId = cartReady ? cart.clienteActivoId : null;
  const enEspera = cart.enEspera.filter(v => mismoScope(v.scope, scope));
  const mutateCart = useCallback((action: () => void) => {
    const current = useConfigStore.getState();
    const currentScope = current.negocioId ? { negocioId: current.negocioId, sucursalId: current.sucursalId || null } : null;
    if (!cartHydrated || !scope || !mismoScope(scope, currentScope) || !mismoScope(useCartStore.getState().scope, scope)) {
      showToast(localCommandError(new Error('cart_scope_incompatible')), 'error'); return;
    }
    try { action(); } catch (e) { showToast(localCommandError(e), 'error'); }
  }, [scope, showToast, cartHydrated]);
  const addItem = useCallback((p: ProductoLocal) => mutateCart(() => useCartStore.getState().addItem(p)), [mutateCart]);
  const addItemConSerial = (p: ProductoLocal, id: string, numero: string) => mutateCart(() => cart.addItemConSerial(p, id, numero));
  const clearCart = () => mutateCart(() => cart.clearCart());
  const updateQuantity = (id: string, q: number) => mutateCart(() => cart.updateQuantity(id, q));
  const setDescuento = (tipo: 'monto' | 'porcentaje', v: number) => mutateCart(() => cart.setDescuento(tipo, v));
  const setCliente = (id: string | null, tier: 1 | 2 | 3) => mutateCart(() => cart.setCliente(id, tier));
  const pausarVenta = (etiqueta?: string | null) => { let ok = false; mutateCart(() => { ok = cart.pausarVenta(etiqueta); }); return ok; };
  const retomarVenta = (id: string, etiqueta?: string | null) => mutateCart(() => cart.retomarVenta(id, etiqueta));
  const descartarEnEspera = (id: string) => mutateCart(() => cart.descartarEnEspera(id));
  const checkouts = useLiveQuery(() => scope ? listarCheckoutsSinResolver(db, scope) : [], [scope]) ?? [];
  const [checkoutVisible, setCheckoutVisible] = useState<CheckoutLocal | null>(null);
  const [modalScope, setModalScope] = useState<CartScope | null>(null);
  const [modalCartId, setModalCartId] = useState<string | null>(null);
  const receiptRef = useRef<CheckoutLocal | null>(null);
  const recibo = checkoutVisible && mismoScope(checkoutVisible.scope, scope) ? checkoutVisible : null;

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
  const [dropdownClienteFactura, setDropdownClienteFactura] = useState(false);
  const [isVentaLibreOpen, setIsVentaLibreOpen] = useState(false);
  const [isCajaOpen, setIsCajaOpen] = useState(false);
  const [ultimoTicketNum, setUltimoTicketNum] = useState<number | undefined>(undefined);
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
  const [serialScope, setSerialScope] = useState<CartScope | null>(null);
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
  const imprimirTicket = async (capturado = receiptRef.current) => {
    const current = useConfigStore.getState();
    if (!capturado || capturado.estado !== 'COMMITTED' || !mismoScope(capturado.scope,
      { negocioId: current.negocioId ?? '', sucursalId: current.sucursalId || null }) || receiptRef.current?.cartId !== capturado.cartId) return;
    const { comprobante: c, comando, efectos } = capturado;
    if (impresion.modoImpresion === 'directa') {
      try {
        const { imprimirVentaDirecta } = await import('@/lib/print/tickets');
        await imprimirVentaDirecta({
          items: c.items.map(i => ({ cantidad: i.cantidad, nombre: i.nombre, precio: i.precio_venta, ubicacion: i.ubicacion })),
          subtotal: c.subtotal, itbis: c.itbis, descuento: c.descuento, total: c.total,
          metodoPago: comando.metodoPago, montoRecibido: c.montoRecibido,
          devuelta: comando.metodoPago === 'efectivo' ? c.montoRecibido - c.total : 0,
          negocio: c.negocio, numeroTicket: efectos?.secuencia.numeroTicket,
          cajaCodigo: comando.cajaCodigo, ncf: comando.ncf, vendedor: comando.vendedorNombre,
          clienteNombre: comando.clienteNombre, mensajePie: c.negocio.mensajePie,
          logoUrl: c.logoUrl, fechaVenta: comando.fecha,
        }, impresion);
        return;
      } catch (e) {
        console.error('[print] impresión directa falló, usando navegador:', e);
        showToast('Impresora directa no disponible — usando impresión del navegador.', 'info');
      }
    }
    handlePrint();
  };

  // Una sola lectura local alimenta tanto el estado de carga como el catalogo.
  // Antes se consultaba Dexie dos veces al abrir el POS.
  const productosEnDBRaw = useLiveQuery(
    () => negocioId
      ? db.productos.where('negocio_id').equals(negocioId)
        .filter(p => !p.eliminado && p.tipo !== 'insumo')
        .toArray()
      : [],
    [negocioId]
  );
  const catalogoIsLoading = productosEnDBRaw === undefined;
  const productosEnDB = useMemo(() => negocioId ? catalogAtScope(productosEnDBRaw ?? [],
    { negocioId, sucursalId: sucursalId ?? null }) : [], [productosEnDBRaw, negocioId, sucursalId]);
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
    const indexedMatches = fuse.search(searchTerm).map(result => result.item);
    return resolveCurrentCatalogMatches(indexedMatches, productosEnDB);
  }, [searchTerm, fuse, productosEnDB]);

  // Renderizado progresivo: pinta un bloque y carga más al hacer scroll.
  // Mantiene la parrilla ágil con catálogos grandes sin perder ningún producto.
  const PAGINA_GRID = 48;
  const gridKey = JSON.stringify([negocioId, sucursalId || null, searchTerm]);
  const [gridWindow, setGridWindow] = useState({ key: gridKey, limit: PAGINA_GRID });
  const currentWindow = catalogWindow(gridWindow, gridKey, PAGINA_GRID);
  // Ajuste condicionado durante render: React descarta el render anterior.
  // No hay frame con una ventana de otro ámbito ni cascada de effects.
  if (currentWindow !== gridWindow) setGridWindow(currentWindow);
  const limiteVisible = currentWindow.limit;
  const sentinelRef = useRef<HTMLDivElement>(null);

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
          setGridWindow(prior => extendCatalogWindow(prior, gridKey, productosFiltrados.length, PAGINA_GRID));
        }
      },
      { rootMargin: '300px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [gridKey, productosFiltrados.length]);

  const ncfLocal = useLiveQuery(async () => negocioId ? estadoNcfLocal(db, negocioId, ncfConfig.tipo) : undefined, [negocioId, ncfConfig.tipo]);
  const ncfDisponible = ncfConfig.negocioId === negocioId && ncfConfig.habilitado && !!ncfLocal?.deviceId && (ncfLocal?.disponibles ?? 0) > 0;

  const devuelta = devueltaVerificable(montoRecibido, total, errorCalculo);
  const totalMixto = parseFloat(montoEfectivoMixto || '0') + parseFloat(montoTransferenciaMixto || '0');

  useEffect(() => {
    if (isCheckoutOpen && !ventaExitosa) {
      setTimeout(() => inputMontoRef.current?.focus(), 100);
    }
  }, [isCheckoutOpen, ventaExitosa]);

  const abrirModalCobro = () => {
    // Revisar el borrador NO es cobrar. La guardia de importes permanece en
    // esMontoValido/preflight/commit; el usuario puede corregir su descuento.
    if (!cartReady || cart.bloqueado || !scope) {
      showToast('Revisa los intentos guardados antes de iniciar otro cobro.', 'info'); return;
    }
    receiptRef.current = null; setCheckoutVisible(null);
    setModalScope(scope); setModalCartId(cart.cartId);
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
    const balance = cliente?sharedBalanceCents(cliente,transacciones)/100:0;
    return {
      balanceClienteSeleccionado: balance,
      limiteClienteSeleccionado: limite,
      excedeCredito: limite > 0 && (balance + total) > limite,
    };
  }, [clienteSeleccionadoId, metodoPago, clientes, transacciones, total]);

  const mixtoCuadra = (() => {
    try {
      const efectivo = moneyCents(parseFloat(montoEfectivoMixto || '0'));
      const transferencia = moneyCents(parseFloat(montoTransferenciaMixto || '0'));
      return efectivo > 0 && transferencia > 0 && efectivo + transferencia === moneyCents(total);
    } catch { return false; }
  })();
  const esMontoValido = !errorCalculo && (
    (metodoPago === 'efectivo' && parseFloat(montoRecibido || '0') >= total) ||
    (metodoPago === 'tarjeta' || metodoPago === 'transferencia') ||
    (metodoPago === 'fiado' && clienteSeleccionadoId !== '' && !excedeCredito) ||
    (metodoPago === 'mixto' && mixtoCuadra));

  const mostrarCheckout = (row: CheckoutLocal) => {
    const current = useConfigStore.getState();
    if (!mismoScope(row.scope, { negocioId: current.negocioId ?? '', sucursalId: current.sucursalId || null })) return;
    receiptRef.current = row; setCheckoutVisible(row); setModalScope(row.scope); setModalCartId(row.cartId);
    setUltimoTicketNum(row.efectos?.secuencia.numeroTicket);
    if (row.efectos && current.negocioId === row.scope.negocioId) {
      useConfigStore.setState({ ultimoTicket: Math.max(current.ultimoTicket, row.efectos.secuencia.numeroTicket) });
    }
    setUltimaVentaId(row.estado === 'COMMITTED' ? row.cartId : null);
    setVentaExitosa(row.estado === 'COMMITTED'); setIsCheckoutOpen(true);
  };
  const recuperarCheckout = async (row: CheckoutLocal, confirmar = false) => {
    if (procesandoVentaRef.current || !scope || !mismoScope(row.scope, scope)) return;
    procesandoVentaRef.current = true; setProcesandoVenta(true);
    try {
      // Recobro manual usa exclusivamente el comando persistido. No NCF/stock desde UI.
      const result = confirmar ? await confirmarCheckoutLocal(db, row.scope, row.cartId)
        : await leerCheckoutLocal(db, row.scope, row.cartId);
      if (result) mostrarCheckout(result);
    } catch (e) { showToast(localCommandError(e), 'error'); }
    finally { procesandoVentaRef.current = false; setProcesandoVenta(false); }
  };
  const finalizarCheckoutUI = async (row: CheckoutLocal) => {
    try {
      await reconocerCheckoutLocal(db, row.scope, row.cartId);
      useCartStore.getState().finalizarCheckout(row.cartId);
      if (receiptRef.current?.cartId !== row.cartId) return;
      receiptRef.current = null; setCheckoutVisible(null); setVentaExitosa(false); setIsCheckoutOpen(false);
      setSearchTerm(''); searchInputRef.current?.focus();
    } catch (e) { showToast(localCommandError(e), 'error'); }
  };
  const procesarVentaBD = async () => {
    const idVenta = modalCartId;
    if (!negocioId || !scope || !cartReady || !idVenta || cart.cartId !== idVenta || !mismoScope(modalScope, scope) || !esMontoValido) return;
    // Candado anti doble-cobro: en dispositivos lentos el usuario toca COBRAR
    // dos veces (o Enter + clic) y la venta/fiado se duplicaba. El ref bloquea
    // al instante (el estado tarda un render en deshabilitar el botón).
    if (procesandoVentaRef.current) return;
    procesandoVentaRef.current = true;
    setProcesandoVenta(true);
    const finalizarInterfazLista = iniciarMedicion();
    const syncActivoAlIniciar = estaSyncActivo();
    const finalizarVenta = iniciarMedicion();
    let resultadoVenta: ResultadoMetrica = 'ok';

    try {
      useCartStore.getState().bloquearCheckout(idVenta);
      const prepared = await leerCheckoutLocal(db, scope, idVenta);
      // Otra pestaña pudo preparar/confirmar esta identidad. Mostrar su intención
      // real antes de volver a ejecutar; nunca cobrar usando un formulario distinto.
      if (prepared) { mostrarCheckout(prepared); return; }
      // Preflight UX antes de consumir NCF. El commit vuelve a comprobar el turno
      // bajo lock: este read no sustituye la garantía transaccional ni reserva NCF.
      const turnos = await db.cajas.where('negocio_id').equals(negocioId)
        .filter(c => c.estado === 'abierta' && (c.sucursal_id ?? null) === (sucursalId || null)).toArray();
      if (turnos.length > 1) throw new Error('turno_ambiguo');
      if ((metodoPago === 'efectivo' || metodoPago === 'mixto') && !turnos.length) throw new Error('turno_requerido');
      const cajaId = turnos[0]?.id;
      // ── Validación de stock antes de procesar ────────────────────────────
      const finalizarValidacion = iniciarMedicion();
      for (const item of items) {
        const product = await db.productos.get(item.id);
        if (item.venta_libre) {
          if (product || item.negocio_id !== negocioId || item.serial_id) throw new Error('producto_ambito_invalido');
          continue;
        }
        if (!product || product.negocio_id !== negocioId || product.eliminado) throw new Error('producto_ambito_invalido');
        const receta = await db.composiciones.where('producto_padre_id').equals(item.id).toArray();
        if (receta.length === 0) {
          // Producto simple/insumo — verificar stock disponible
          const producto = requireProductAtScope(product, { negocioId, sucursalId: sucursalId ?? null });
          if (producto && producto.stock_actual < item.cantidad) {
            throw new Error('stock_insuficiente');
          }
        }
      }
      finalizarValidacion('venta.validacion', 'ok', { articulos: items.length });

      const cajaCodigo = getDispositivoId();

      // Handler de cobro: la marca temporal se captura al confirmar, no durante render.
      // eslint-disable-next-line react-hooks/purity
      const fechaVenta = Date.now();
      const itemsContrato = await Promise.all(items.map(async item => {
        const receta = await db.composiciones.where('producto_padre_id').equals(item.id).toArray();
        return {
          productoId: item.id,
          ...(item.venta_libre ? { sinStock: true as const } : {}),
          nombre: item.nombre,
          cantidad: item.cantidad,
          precioUnitario: item.precio_venta,
          ...(receta.length > 0 && {
            ingredientes: receta.map(ingrediente => ({
              productoId: ingrediente.insumo_id,
              cantidadNecesaria: ingrediente.cantidad_necesaria,
            })),
          }),
          ...(item.serial_id && item.serial_numero && {
            serial: { id: item.serial_id, numero: item.serial_numero },
          }),
        };
      }));
      const current = useConfigStore.getState();
      if (!mismoScope(scope, { negocioId: current.negocioId ?? '', sucursalId: current.sucursalId || null })) throw new Error('checkout_ambito_invalido');
      const comando: ConfirmarVentaLocalEntrada = {
        version: VERSION_CONTRATO_VENTA,
        operacionId: idVenta,
        negocioId,
        sucursalId: sucursalId || undefined,
        cajaCodigo,
        cajaId,
        fecha: fechaVenta,
        total,
        metodoPago,
        ...(metodoPago === 'mixto' && {
          montoEfectivo: parseFloat(montoEfectivoMixto || '0'),
          montoTransferencia: parseFloat(montoTransferenciaMixto || '0'),
        }),
        vendedorNombre: nombreUsuario || undefined,
        clienteId: clienteSeleccionadoId || undefined,
        clienteNombre: clienteNombreVenta.trim() || undefined,
        garantiaDias: planTier === 'pro' ? (garantiaDiasDefault || 0) : 0,
        originDeviceId: cajaCodigo,
        items: itemsContrato,
        ultimoTicketConocido: useConfigStore.getState().ultimoTicket,
      };
      asegurarContratoPreparacionVenta(comando);
      if (emitirNcf && (!ncfDisponible || !ncfLocal?.deviceId)) throw new Error('ncf_no_disponible');
      await prepararCheckoutLocal(db, { cartId: idVenta, scope, comando,
        ...(emitirNcf && ncfLocal?.deviceId ? { solicitudFiscal: { version: 1 as const, tipo: ncfConfig.tipo, deviceId: ncfLocal.deviceId } } : {}),
        comprobante: { items, subtotal, itbis, descuento, total,
        montoRecibido: metodoPago === 'efectivo' ? parseFloat(montoRecibido || '0') : total,
        negocio: { nombre: negocioNombre || 'VentaRD', rnc: negocioRnc || undefined,
          direccion: negocioDireccion || undefined, telefono: negocioTelefono || undefined, mensajePie: negocioMensajeTicket || undefined },
        logoUrl: logoTicket,
      } });
      const finalizarTransaccion = iniciarMedicion();
      const resultado = await confirmarCheckoutLocal(db, scope, idVenta);
      finalizarTransaccion('venta.transaccion_local', 'ok', { articulos: items.length });

      mostrarCheckout(resultado);

      // Impresión automática al confirmar (pequeño delay para que React
      // renderice el ticket oculto con el número de ticket actualizado)
      if (impresion.autoImprimir) {
        setTimeout(() => imprimirTicket(resultado), 400);
      }

    } catch (error) {
      resultadoVenta = 'error';
      showToast(localCommandError(error), "error");
      try {
        const saved = await leerCheckoutLocal(db, scope, idVenta);
        if (saved && saved.estado !== 'ABANDONED') mostrarCheckout(saved);
        else useCartStore.getState().desbloquearCheckout(idVenta);
      } catch { showToast('No se pudo verificar el intento guardado. Conserva el carrito y revisa la recuperación.', 'error'); }
    } finally {
      finalizarVenta('venta.total', resultadoVenta, {
        articulos: items.length,
        seriales: items.filter(i => i.serial_id).length,
        online: navigator.onLine,
        syncActivoInicio: syncActivoAlIniciar,
        syncActivoFinal: estaSyncActivo(),
        impresionAutomatica: impresion.autoImprimir,
        pwa: window.matchMedia('(display-mode: standalone)').matches,
      });
      procesandoVentaRef.current = false;
      setProcesandoVenta(false);
      // Dos frames: el primero aplica el estado React y el segundo aproxima el
      // momento en que la interfaz ya volvió a estar pintada y utilizable.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        finalizarInterfazLista('venta.interfaz_lista', resultadoVenta, {
          articulos: items.length,
          seriales: items.filter(i => i.serial_id).length,
          syncActivoInicio: syncActivoAlIniciar,
          syncActivoFinal: estaSyncActivo(),
          impresionAutomatica: impresion.autoImprimir,
        });
      }));
    }
  };

  // Anula la venta recién hecha: devolución total auditable (queda en historial),
  // repone el stock, revierte el cargo de fiado y libera los seriales.
  const anularUltimaVenta = async () => {
    if (!negocioId || !ultimaVentaId || anulando) return;
    setAnulando(true);
    try {
      await confirmarDevolucionLocal(db, {
        operationId: uuidv4(), negocioId, sucursalId: sucursalId || undefined,
        ventaId: ultimaVentaId, fecha: Date.now(), originDeviceId: getDispositivoId(),
        razon: `Venta anulada en caja${nombreUsuario ? ` por ${nombreUsuario}` : ''}`,
        // Sin cantidades de carrito: todo lo pendiente de la venta persistida.
      });

      setConfirmAnularOpen(false);
      setVentaExitosa(false);
      setIsCheckoutOpen(false);
      setUltimaVentaId(null);
      if (recibo) await finalizarCheckoutUI(recibo);
      setSearchTerm('');
      showToast('Venta anulada — el stock fue repuesto.', 'info');
      searchInputRef.current?.focus();
    } catch (e) {
      showToast(localCommandError(e), 'error');
    } finally {
      setAnulando(false);
    }
  };

  // Handler estable para la parrilla: permite que ProductCard memoizado no se
  // re-renderice al teclear en el buscador.
  const onSelectProducto = useCallback((producto: ProductoLocal) => {
    if (producto.serializable) {
      setSerialScope(scope);
      setProductoParaSerial(producto);
      setBusquedaSerial('');
    } else {
      addItem(producto);
    }
  }, [addItem, scope, setSerialScope, setProductoParaSerial, setBusquedaSerial]);

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

  // Reemplazar el listener tras cada render conserva el formulario actual
  // (incluidos ambos importes mixtos), sin un cierre con dependencias omitidas.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F2') { e.preventDefault(); searchInputRef.current?.focus(); }
      if (e.key === 'F4') { e.preventDefault(); setIsVentaLibreOpen(true); }
      if (e.key === ' ' && items.length > 0 && document.activeElement !== searchInputRef.current && !isCheckoutOpen && !isVentaLibreOpen) { e.preventDefault(); abrirModalCobro(); }
      if (e.key === 'Escape' && isCheckoutOpen && !ventaExitosa) setIsCheckoutOpen(false);
      if (e.key === 'Escape' && isVentaLibreOpen) setIsVentaLibreOpen(false);
      if (e.key === 'Escape' && isCartOpen) setIsCartOpen(false);
      if (e.key === 'Enter') {
        if (isCheckoutOpen && !ventaExitosa) {
          e.preventDefault();
          if (debeConfirmarConEnter({ key: e.key, checkoutOpen: isCheckoutOpen,
            ventaExitosa, importeValido: esMontoValido, procesando: procesandoVentaRef.current })) void procesarVentaBD();
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
  });

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
      {errorCalculo && <div role="alert" className="p-3 text-xs text-vr-red bg-vr-red/10">
        Importes no verificables: revisa precios, cantidades y descuento. El borrador se conservó sin redondearlo; no se puede cobrar.
        <button type="button" onClick={abrirModalCobro} disabled={cart.bloqueado || !cartReady}
          className="block underline font-bold mt-2 disabled:opacity-50">Revisar descuento</button>
      </div>}
      {cartReady && cart.bloqueado && cart.cartId && !checkouts.some(c => c.cartId === cart.cartId) && (
        <div className="p-3 text-xs text-gold bg-gold/10">
          <p>Borrador bloqueado sin intento visible. Revisa la recuperación antes de editarlo.</p>
          <button disabled={procesandoVenta} className="underline mt-2" onClick={async () => {
            if (!scope || !cart.cartId || procesandoVentaRef.current) return;
            const id = cart.cartId; procesandoVentaRef.current = true; setProcesandoVenta(true);
            try {
              await abandonarBorradorSinCheckout(db, scope, id, Date.now());
              useCartStore.getState().renovarCheckout(id);
              showToast('Identidad del borrador retirada sin crear cobro. Los artículos se conservaron. Ningún NCF consumido se reutilizó.', 'info');
            } catch (e) { showToast(localCommandError(e), 'error'); }
            finally { procesandoVentaRef.current = false; setProcesandoVenta(false); }
          }}>Verificar ausencia de cobro y liberar borrador</button>
        </div>
      )}

      {/* Ventas en espera (facturas pausadas) */}
      {enEspera.length > 0 && (
        <div className="px-3 sm:px-4 pt-2.5 pb-2 border-b border-navy-3/50">
          <p className="text-[10px] font-black text-vr-gray uppercase tracking-wider mb-1.5">⏸ En espera ({enEspera.length})</p>
          <div className="space-y-1.5 max-h-36 overflow-y-auto">
            {enEspera.map(v => {
              const resumen = resumenBorrador(v);
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
                      {v.items.length} ít. · {resumen.total === null ? 'No verificable' : formatDOP(resumen.total)} · {new Date(v.creado).toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit' })}
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
          <div className="flex justify-between text-vr-gray"><span>Subtotal</span><span className="font-mono">{formatCartAmount(subtotal)}</span></div>
          <div className="flex justify-between text-vr-gray"><span>ITBIS</span><span className="font-mono">{formatCartAmount(itbis)}</span></div>
          {descuento > 0 && (
            <div className="flex justify-between text-vr-green font-bold">
              <span>Descuento {tipoDescuento === 'porcentaje' ? `(${valorDescuento}%)` : ''}</span>
              <span className="font-mono">- {formatDOP(descuento)}</span>
            </div>
          )}
          <div className="flex justify-between text-xl sm:text-2xl font-black text-white pt-2 border-t border-navy-3 mt-2">
            <span>Total</span><span className="font-mono text-gold">{formatCartAmount(total)}</span>
          </div>
        </div>
        <button
          onClick={abrirModalCobro} disabled={items.length === 0 || !!errorCalculo}
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
      {checkouts.length > 0 && (
        <div className="bg-gold/10 border-b border-gold/30 p-3 text-sm text-white flex flex-wrap items-center gap-2">
          <span>Intentos de cobro guardados en esta sucursal:</span>
          {checkouts.map(row => <button key={row.cartId} disabled={procesandoVenta} onClick={() => recuperarCheckout(row)}
            className="rounded border border-gold/40 px-3 py-1 text-gold disabled:opacity-40">
            {row.estado === 'COMMITTED' ? 'Recuperar venta' : 'Revisar intento'} · {formatDOP(row.comprobante.total)}
          </button>)}
        </div>
      )}
      {(cart.carritosGuardados.some(c => !c.scope) || cart.enEspera.some(v => !v.scope)) && (
        <p className="p-2 text-xs text-gold bg-navy-2">Se conservaron borradores antiguos sin sucursal verificable. No se asignaron ni cobraron automáticamente.</p>
      )}

      <div className="flex flex-col lg:flex-row flex-1 overflow-hidden relative">
        {/* COMPONENTE OCULTO DE IMPRESIÓN */}
        <div style={{ display: "none" }}>
          <TicketVenta
            ref={ticketRef} items={recibo?.comprobante.items ?? []} subtotal={recibo?.comprobante.subtotal ?? 0}
            itbis={recibo?.comprobante.itbis ?? 0} descuento={recibo?.comprobante.descuento ?? 0} total={recibo?.comprobante.total ?? 0}
            metodoPago={recibo?.comando.metodoPago ?? ''} montoRecibido={String(recibo?.comprobante.montoRecibido ?? 0)}
            devuelta={recibo?.comando.metodoPago === 'efectivo' ? recibo.comprobante.montoRecibido - recibo.comprobante.total : 0}
            nombreNegocio={recibo?.comprobante.negocio.nombre} rnc={recibo?.comprobante.negocio.rnc}
            direccion={recibo?.comprobante.negocio.direccion} telefono={recibo?.comprobante.negocio.telefono}
            numeroTicket={recibo?.efectos?.secuencia.numeroTicket} mensajePie={recibo?.comprobante.negocio.mensajePie}
            cajaCodigo={recibo?.comando.cajaCodigo} ncf={recibo?.comando.ncf} logoUrl={recibo?.comprobante.logoUrl}
            vendedor={recibo?.comando.vendedorNombre} clienteNombre={recibo?.comando.clienteNombre} fechaVenta={recibo?.comando.fecha}
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
              disabled={!puedeAbrirCarrito(items.length, enEspera.length)}
              className="w-full bg-gold-gradient text-navy font-extrabold py-3.5 rounded-xl disabled:opacity-30 flex items-center justify-between px-5 shadow-xl"
            >
              <span className="text-sm">
                {items.length > 0 ? `${items.length} ítem${items.length > 1 ? 's' : ''} • Ver Carrito` : enEspera.length > 0 ? `Ver ventas en espera (${enEspera.length})` : 'Carrito vacío'}
              </span>
              <span className="font-mono font-black">{formatCartAmount(total)}</span>
            </button>
          </div>
        )}
      </div>

      {/* MODAL DE COBRO */}
      {isCheckoutOpen && mismoScope(modalScope, scope) && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
          <div className="bg-navy-2 w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[95vh] sm:max-h-[90vh] border border-navy-3 animate-scale-in">

            {ventaExitosa ? (
              <div className="p-6 sm:p-10 text-center flex flex-col items-center justify-center">
                <div className="w-16 h-16 sm:w-20 sm:h-20 bg-vr-green/15 text-vr-green rounded-full flex items-center justify-center text-3xl sm:text-4xl mb-4 sm:mb-5 border border-vr-green/30 animate-scale-in">✓</div>
                <h2 className="text-2xl sm:text-3xl font-display font-black text-white mb-2">¡Venta Exitosa!</h2>
                {ultimoTicketNum && <p className="text-vr-gray font-mono text-sm mb-4">Ticket #{formatTicket(ultimoTicketNum, recibo?.comando.cajaCodigo)}</p>}
                {recibo?.comando.ncf && <p className="text-blue-300 font-mono text-sm mb-4">NCF: {recibo.comando.ncf}</p>}
                {recibo?.comando.metodoPago === 'efectivo' && (
                  <div className="bg-vr-green/10 border border-vr-green/20 rounded-xl px-6 py-3 mb-6">
                    <p className="text-sm text-vr-gray">Devuelta</p>
                    <p className="text-3xl font-black font-mono text-vr-green">{formatDOP(recibo.comprobante.montoRecibido - recibo.comprobante.total)}</p>
                  </div>
                )}
                {recibo?.comando.metodoPago === 'mixto' && (
                  <div className="bg-navy border border-navy-3 rounded-xl px-6 py-3 mb-6 space-y-1 w-full max-w-xs">
                    <div className="flex justify-between text-sm">
                      <span className="text-vr-green font-bold">Efectivo</span>
                      <span className="font-mono text-white">{formatDOP(recibo.comando.montoEfectivo ?? 0)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-purple-400 font-bold">Transferencia</span>
                      <span className="font-mono text-white">{formatDOP(recibo.comando.montoTransferencia ?? 0)}</span>
                    </div>
                  </div>
                )}
                <div className="flex gap-3 mt-4 w-full max-w-sm">
                  <button
                    onClick={() => {
                      if (!recibo) return;
                      const c = recibo.comprobante, n = c.negocio;
                      const encabezado = `*${n.nombre}*${n.rnc ? `\nRNC: ${n.rnc}` : ''}${n.direccion ? `\n${n.direccion}` : ''}${n.telefono ? `\nTel: ${n.telefono}` : ''}`;
                      const pie = n.mensajePie || '¡Gracias por su compra!';
                      const lineas = c.items.map(i => `${i.cantidad}x ${i.nombre} — ${formatDOP(i.precio_venta * i.cantidad)}`).join('\n');
                      const metodoTxt: Record<string, string> = { efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta: 'Tarjeta', mixto: 'Mixto', fiado: 'Fiado' };
                      const resumen =
                        `${encabezado}\n` +
                        `Recibo #${formatTicket(recibo.efectos?.secuencia.numeroTicket, recibo.comando.cajaCodigo)}\n` +
                        `${'—'.repeat(20)}\n` +
                        `${lineas}\n` +
                        `${'—'.repeat(20)}\n` +
                        (c.descuento > 0 ? `Subtotal: ${formatDOP(c.subtotal + c.itbis)}\nDescuento: -${formatDOP(c.descuento)}\n` : '') +
                        `*Total: ${formatDOP(c.total)}*\n` +
                        `Pago: ${metodoTxt[recibo.comando.metodoPago]}\n\n` +
                        `${pie}\n\n` +
                        `_Hecho con VentaRD_`;
                      window.open(linkWhatsApp(resumen), '_blank');
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
                  onClick={() => { if (recibo) void finalizarCheckoutUI(recibo); }}
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
            ) : recibo?.estado === 'PREPARED' ? (
              <div className="p-6 space-y-4 text-white">
                <h2 className="text-xl font-bold">Intento guardado — pendiente de confirmación local</h2>
                <p>{formatDOP(recibo.comprobante.total)} · {recibo.comando.metodoPago} · {recibo.comprobante.items.length} artículos</p>
                <p className="text-sm text-vr-gray">Reintentar conserva el comando original. No modifica el importe, el cliente ni el NCF.</p>
                <button disabled={procesandoVenta} onClick={() => recuperarCheckout(recibo, true)} className="bg-gold text-navy rounded p-3 font-bold disabled:opacity-40">Confirmar este mismo intento</button>
                <button disabled={procesandoVenta} onClick={async () => {
                  if (procesandoVentaRef.current) return;
                  procesandoVentaRef.current = true; setProcesandoVenta(true);
                  try {
                    await abandonarCheckoutLocal(db, recibo.scope, recibo.cartId);
                    useCartStore.getState().renovarCheckout(recibo.cartId);
                    receiptRef.current = null; setCheckoutVisible(null); setIsCheckoutOpen(false);
                    showToast(recibo.fiscal === 'NONE' ? 'Intento abandonado. El carrito se conserva para revisarlo.' : 'Intento abandonado. El NCF legacy consumido no se reutilizó ni devolvió a la secuencia.', 'info');
                  } catch (e) { showToast(localCommandError(e), 'error'); }
                  finally { procesandoVentaRef.current = false; setProcesandoVenta(false); }
                }} className="block text-vr-red underline">Abandonar intento sin borrar su evidencia</button>
                <button onClick={() => setIsCheckoutOpen(false)} className="block text-vr-gray">Volver sin modificar</button>
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
                    <p className="text-4xl sm:text-5xl font-black font-mono text-gold">{formatCartAmount(total)}</p>
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

                  {/* Cliente para la factura: elige uno registrado o escribe un nombre libre */}
                  <div className="mb-4 sm:mb-6 relative">
                    <label className="block text-xs font-bold text-vr-gray mb-1.5">👤 Cliente para la factura <span className="font-normal text-vr-gray/60">(opcional)</span></label>
                    <input
                      type="text" placeholder="Escribe el nombre o elige un cliente registrado"
                      className="w-full bg-navy border border-navy-3 rounded-xl px-3 py-2.5 text-sm text-white placeholder-vr-gray/50 focus:border-gold outline-none transition-all"
                      value={clienteNombreVenta}
                      onChange={e => { setClienteNombreVenta(e.target.value); setDropdownClienteFactura(true); }}
                      onFocus={() => setDropdownClienteFactura(true)}
                      onBlur={() => setTimeout(() => setDropdownClienteFactura(false), 150)}
                    />
                    {dropdownClienteFactura && clientes.length > 0 && (() => {
                      const q = clienteNombreVenta.trim().toLowerCase();
                      const sugeridos = (q ? clientes.filter(c => c.nombre.toLowerCase().includes(q)) : clientes).slice(0, 6);
                      // Si el texto ya coincide exacto con un cliente, no hay nada que sugerir
                      if (sugeridos.length === 0 || (sugeridos.length === 1 && sugeridos[0].nombre === clienteNombreVenta)) return null;
                      return (
                        <div className="absolute z-50 w-full bg-navy border border-navy-3 rounded-xl mt-1 shadow-xl max-h-44 overflow-y-auto">
                          {sugeridos.map(c => (
                            <button
                              key={c.id} type="button"
                              onMouseDown={() => { setClienteNombreVenta(c.nombre); setDropdownClienteFactura(false); }}
                              className="w-full text-left px-3 py-2.5 hover:bg-navy-3 transition-colors border-b border-navy-3/50 last:border-0 text-sm font-bold text-white truncate"
                            >
                              {c.nombre}
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                  </div>

                  {/* QR de transferencia (si el negocio configuró sus datos de pago) */}
                  {metodoPago === 'transferencia' && !errorCalculo && (
                    <div className="mb-4 sm:mb-6">
                      <QrTransferencia monto={total} />
                    </div>
                  )}

                  {/* DESCUENTO */}
                  {errorCalculo && <p role="alert" className="mb-3 text-vr-red text-sm">Importes no verificables. Revisa el descuento y los artículos antes de cobrar.</p>}
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
                        <button disabled={!!errorCalculo} onClick={() => setMontoRecibido(total.toString())} className="px-3 sm:px-4 py-2 bg-vr-green/15 text-vr-green font-bold rounded-lg border border-vr-green/20 hover:bg-vr-green/25 text-sm whitespace-nowrap disabled:opacity-50">Exacto</button>
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
                      {devuelta !== null && (
                        <div className="mt-4 p-3 sm:p-4 bg-vr-green/10 border border-vr-green/20 rounded-xl flex justify-between items-center">
                          <span className="text-vr-green font-bold text-base">Devuelta:</span>
                          <span className="text-2xl sm:text-3xl font-black font-mono text-vr-green">{formatDOP(devuelta)}</span>
                        </div>
                      )}
                      {(!errorCalculo && parseFloat(montoRecibido || '0') > 0 && parseFloat(montoRecibido || '0') < total) && (
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
                            <span className="font-mono font-bold text-white">+ {formatCartAmount(total)}</span>
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
                      <div className={`flex justify-between items-center p-3 rounded-lg border ${mixtoCuadra && !errorCalculo ? 'bg-vr-green/10 border-vr-green/20' : 'bg-navy-3 border-navy-3'}`}>
                        <span className="text-sm font-bold text-vr-gray">Total ingresado:</span>
                        <span className={`font-mono font-black text-lg ${mixtoCuadra && !errorCalculo ? 'text-vr-green' : 'text-white'}`}>
                          {formatDOP(totalMixto)}
                        </span>
                      </div>
                      {totalMixto > 0 && totalMixto < total && (
                        <p className="text-xs text-vr-red font-bold text-center">Faltan {formatDOP(total - totalMixto)} para completar el pago</p>
                      )}
                      {totalMixto >= total && !mixtoCuadra && <p className="text-xs text-vr-red font-bold text-center">El reparto debe coincidir exactamente con el total, en centavos.</p>}
                    </div>
                  )}
                </div>

                <div className="p-4 sm:p-6 bg-navy border-t border-navy-3 space-y-3">
                  {/* Aviso: NCF habilitado pero sin números disponibles en esta caja */}
                  {ncfLocal?.incierta && <p className="text-sm text-vr-orange">Abastecimiento NCF incierto. No se reintentará automáticamente. Revisión manual en Configuración.</p>}
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
      {productoParaSerial && mismoScope(serialScope, scope) && cartReady && (
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
      {scannerSerialPOS && productoParaSerial && mismoScope(serialScope, scope) && cartReady && (
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
      <VentaLibreModal isOpen={isVentaLibreOpen && cartReady && !cart.bloqueado} scope={scope} onClose={() => setIsVentaLibreOpen(false)} />

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
