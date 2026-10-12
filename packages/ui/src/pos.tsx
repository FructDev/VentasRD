// Presentación permanente adaptada de src/app/page.tsx: ProductCard,
// cartContent, catálogo/drawer y Completar Pago. Sin store/reglas/persistencia.
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
export interface ProductView {
  id: string;
  name: string;
  code: string;
  price: string;
  stock: string;
  available: boolean;
  stockUnknown?: boolean;
}
export interface TicketLineView {
  id: string;
  name: string;
  quantity: string;
  price: string;
  subtotal: string;
}
export interface TotalsView {
  subtotal: string;
  tax: string;
  total: string;
}
export const ProductCard = memo(function ProductCard({
  product,
  disabled,
  onSelect,
}: {
  product: ProductView;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      data-product={product.id}
      aria-label={`Añadir ${product.name}`}
      disabled={disabled || !product.available}
      onClick={() => onSelect(product.id)}
      className="bg-navy-2 p-3 sm:p-4 rounded-xl border border-navy-3 hover:border-gold/40 hover:bg-navy-3 transition-all text-left flex flex-col justify-between h-24 sm:h-28 active:scale-[0.97] group relative overflow-hidden disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <div className="min-w-0">
        <span className="font-semibold text-white line-clamp-2 text-xs sm:text-sm group-hover:text-gold-2 block">
          {product.name}
        </span>
        <span className="text-[10px] text-vr-gray font-mono">
          {product.code}
        </span>
      </div>
      <div className="flex justify-between items-end mt-1">
        <span className="text-base sm:text-lg font-bold font-mono text-gold">
          {product.price}
        </span>
        <span className="text-xs text-vr-gray">
          <span data-stock>{product.stock}</span>
          {product.stockUnknown ? "" : " uds"}
        </span>
      </div>
    </button>
  );
});
export function TicketPanel({
  items,
  totals,
  disabled,
  pending,
  paymentBlocked = false,
  pausedCount,
  children,
  onCash,
  onWaiting,
  onQuantity,
  onRemove,
  onClear,
  onPay,
  onClose,
}: {
  items: TicketLineView[];
  totals: TotalsView | null;
  disabled: boolean;
  pending: boolean;
  paymentBlocked?: boolean;
  pausedCount: number;
  children?: ReactNode;
  onCash?: () => void;
  onWaiting: () => void;
  onQuantity: (id: string, delta: 1 | -1) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onPay: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="p-3 sm:p-4 border-b border-navy-3 flex justify-between items-center gap-2">
        <h2 className="font-display text-lg font-bold">Ticket</h2>
        <div className="flex gap-2">
          <button
            aria-label="Caja"
            title={
              onCash
                ? "Consultar caja nativa local"
                : "Integración de turno comercial pendiente"
            }
            disabled={!onCash || disabled || pending}
            onClick={onCash}
            className="text-xs text-vr-gray border border-navy-3 rounded px-2 py-1"
          >
            💰 Caja
          </button>
          <button
            disabled={disabled || pending}
            onClick={onWaiting}
            className="text-xs text-gold border border-navy-3 rounded px-2 py-1"
          >
            ⏸ En espera ({pausedCount})
          </button>
          <button
            disabled={disabled || pending || !items.length}
            onClick={onClear}
            className="text-xs text-vr-red font-bold"
          >
            Limpiar
          </button>
          <button
            aria-label="Cerrar ticket"
            onClick={onClose}
            className="lg:hidden text-xl px-2"
          >
            ✕
          </button>
        </div>
      </div>
      {children}
      <div className="px-4 py-2 border-b border-navy-3">
        <label className="text-xs text-vr-gray" htmlFor="ticket-customer">
          Cliente
        </label>
        <input
          id="ticket-customer"
          disabled
          placeholder="Consumidor final · clientes pendientes de integración"
          className="w-full text-xs bg-navy rounded-xl p-2 disabled:opacity-60"
        />
      </div>
      <div className="flex-1 min-h-16 overflow-y-auto p-3 sm:p-4 space-y-3">
        {!items.length ? (
          <div className="h-full min-h-24 flex items-center justify-center text-vr-gray text-center text-sm">
            <div>
              <span className="text-3xl block mb-2">🛒</span>Agrega productos
              para comenzar
            </div>
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="flex justify-between items-start border-b border-navy-3/50 pb-3"
              data-ticket-line={item.id}
            >
              <div className="min-w-0 flex-1 pr-2">
                <h3 className="font-medium text-sm truncate">{item.name}</h3>
                <div className="text-sm text-vr-gray flex items-center gap-2 mt-1">
                  <span className="font-mono text-gold-2">{item.price}</span>
                  <span>×</span>
                  <div className="flex items-center gap-1 bg-navy-3 rounded-md px-1">
                    <button
                      aria-label={`Disminuir cantidad de ${item.name}`}
                      disabled={disabled || pending}
                      onClick={() => onQuantity(item.id, -1)}
                      className="px-2 py-1 font-bold"
                    >
                      −
                    </button>
                    <span className="w-5 text-center font-bold font-mono text-white text-xs">
                      {item.quantity}
                    </span>
                    <button
                      aria-label={`Aumentar cantidad de ${item.name}`}
                      disabled={disabled || pending}
                      onClick={() => onQuantity(item.id, 1)}
                      className="px-2 py-1 font-bold"
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>
              <div className="text-right">
                <p className="font-bold font-mono text-sm">{item.subtotal}</p>
                <button
                  aria-label={`Quitar ${item.name}`}
                  disabled={disabled || pending}
                  onClick={() => onRemove(item.id)}
                  className="text-xs text-vr-red mt-1"
                >
                  Quitar
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="p-3 sm:p-4 bg-navy border-t border-navy-3">
        <div className="space-y-1 mb-3 text-sm">
          <div className="flex justify-between text-vr-gray">
            <span>Subtotal</span>
            <span className="font-mono">{totals?.subtotal ?? "—"}</span>
          </div>
          <div className="flex justify-between text-vr-gray">
            <span>ITBIS</span>
            <span className="font-mono">{totals?.tax ?? "—"}</span>
          </div>
          <div className="flex justify-between text-2xl font-black pt-2 border-t border-navy-3">
            <span>Total</span>
            <span className="font-mono text-gold" data-cart-total>
              {totals?.total ?? "—"}
            </span>
          </div>
        </div>
        <button
          onClick={onPay}
          disabled={
            disabled || pending || paymentBlocked || !items.length || !totals
          }
          className="w-full bg-gold-gradient text-navy text-lg font-extrabold py-4 rounded-xl disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Cobrar Venta{" "}
          <span className="hidden sm:inline text-[10px] font-mono ml-2">
            ESPACIO
          </span>
        </button>
      </div>
    </>
  );
}
export function SalesWorkspace({
  products,
  items,
  totals,
  query,
  busy,
  pending,
  paymentBlocked = false,
  pausedCount,
  drawerOpen,
  children,
  notice,
  catalogueFooter,
  onCash,
  onWaiting,
  onQuery,
  onSearchEnter,
  onSelect,
  onQuantity,
  onRemove,
  onClear,
  onPay,
  onDrawer,
  onFree,
}: {
  products: ProductView[];
  items: TicketLineView[];
  totals: TotalsView | null;
  query: string;
  busy: boolean;
  pending: boolean;
  paymentBlocked?: boolean;
  pausedCount: number;
  drawerOpen: boolean;
  children?: ReactNode;
  notice?: ReactNode;
  catalogueFooter?: ReactNode;
  onCash?: () => void;
  onWaiting: () => void;
  onQuery: (value: string) => void;
  onSearchEnter: () => void;
  onSelect: (id: string) => void;
  onQuantity: (id: string, delta: 1 | -1) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onPay: () => void;
  onDrawer: (open: boolean) => void;
  onFree?: () => void;
}) {
  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {notice}
      <div className="flex flex-col lg:flex-row flex-1 min-h-0 overflow-hidden relative">
        <section
          aria-label="Catálogo de ventas"
          className="flex-1 flex flex-col p-3 sm:p-4 min-h-0 overflow-hidden"
        >
          <h1 className="sr-only">Ventas</h1>
          <div className="mb-3 flex gap-2">
            <div className="relative flex-1 min-w-0">
              <input
                id="pos-search"
                aria-label="Buscar producto"
                type="text"
                placeholder="Buscar producto (F2)"
                value={query}
                onChange={(e) => onQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onSearchEnter();
                  }
                }}
                className="w-full px-4 py-3 bg-navy-2 border border-navy-3 rounded-xl focus:border-gold outline-none text-white text-sm sm:text-base"
              />
              <span className="hidden sm:block absolute right-3 top-3 text-xs font-mono text-vr-gray bg-navy-3 rounded px-2 py-1">
                F2
              </span>
            </div>
            <button
              disabled
              title="Cámara pendiente; lector HID disponible en el buscador"
              className="px-3 py-3 border border-navy-3 rounded-xl text-vr-gray disabled:opacity-50"
            >
              📷 <span className="hidden sm:inline">Escanear</span>
            </button>
            <button
              disabled={!onFree || busy || pending}
              onClick={onFree}
              title={
                onFree
                  ? "Registrar una línea libre explícita"
                  : "Venta libre no disponible en este ámbito"
              }
              className="px-3 py-3 border border-navy-3 rounded-xl text-vr-gray disabled:opacity-50"
            >
              ⚡ <span className="hidden sm:inline">Libre</span>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto pb-20 lg:pb-2">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-2 sm:gap-3">
              {products.map((p) => (
                <ProductCard
                  key={p.id}
                  product={p}
                  disabled={busy || pending}
                  onSelect={onSelect}
                />
              ))}
              {!products.length && (
                <p className="col-span-full text-vr-gray text-center py-12">
                  No se encontraron productos
                </p>
              )}
            </div>
            <p className="text-xs text-vr-gray mt-4">
              {products.length} productos visibles · cálculos verificados por el
              núcleo
            </p>
          </div>
          {catalogueFooter}
        </section>
        {drawerOpen && (
          <div
            onClick={() => onDrawer(false)}
            className="lg:hidden fixed inset-0 bg-black/70 backdrop-blur-sm z-40"
          />
        )}
        <aside
          aria-label="Ticket de venta"
          className={`${drawerOpen ? "flex" : "hidden lg:flex"} flex-col fixed bottom-0 left-0 right-0 lg:static max-h-[88vh] lg:max-h-none lg:w-96 lg:shrink-0 bg-navy-2 border-t lg:border-t-0 lg:border-l border-navy-3 rounded-t-2xl lg:rounded-none z-50 lg:z-10 overflow-hidden`}
        >
          <TicketPanel
            items={items}
            totals={totals}
            disabled={busy}
            pending={pending}
            paymentBlocked={paymentBlocked}
            pausedCount={pausedCount}
            onCash={onCash}
            onWaiting={onWaiting}
            onQuantity={onQuantity}
            onRemove={onRemove}
            onClear={onClear}
            onPay={onPay}
            onClose={() => onDrawer(false)}
          >
            {children}
          </TicketPanel>
        </aside>
        {!drawerOpen && (
          <div className="lg:hidden fixed bottom-0 left-0 right-0 z-30 p-3 bg-navy/95 border-t border-navy-3">
            <button
              onClick={() => onDrawer(true)}
              className="w-full bg-gold-gradient text-navy font-extrabold py-3.5 rounded-xl flex justify-between px-5"
            >
              <span>Ver Carrito ({items.length})</span>
              <span className="font-mono">{totals?.total ?? "—"}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
export function SavedCartDialog({
  drafts,
  canPause,
  busy,
  onPause,
  onResume,
  onDiscard,
  onClose,
  children,
}: {
  drafts: { id: string; label: string; summary: string }[];
  canPause: boolean;
  busy: boolean;
  onPause: () => void;
  onResume: (id: string) => void;
  onDiscard: (id: string) => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [discard, setDiscard] = useState<string | null>(null);
  useEffect(() => {
    const old = document.activeElement;
    ref.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    return () => {
      if (old instanceof HTMLElement) old.focus();
    };
  }, []);
  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[60] flex items-end sm:items-center justify-center sm:p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="saved-carts-title"
        className="bg-navy-2 border border-navy-3 rounded-t-2xl sm:rounded-2xl w-full max-w-xl max-h-[95vh] overflow-y-auto"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) {
            e.preventDefault();
            onClose();
          }
          if (e.key === "Tab") {
            const list = ref.current?.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            );
            if (list?.length) {
              const first = list[0],
                last = list[list.length - 1];
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
              }
            }
          }
        }}
      >
        <div className="p-5 border-b border-navy-3 flex justify-between">
          <h2 id="saved-carts-title" className="text-xl font-bold">
            Ventas en espera
          </h2>
          <button
            aria-label="Cerrar ventas en espera"
            disabled={busy}
            onClick={onClose}
            className="px-2"
          >
            ✕
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-vr-gray">
            Guardadas en el almacenamiento local cifrado. No reservan stock ni
            representan ventas cobradas. Retomar conserva el carrito ocupado en
            espera.
          </p>
          <button
            disabled={!canPause || busy}
            onClick={onPause}
            className="w-full p-3 rounded-xl bg-gold-gradient text-navy font-bold disabled:opacity-30"
          >
            Pausar venta actual
          </button>
          {children}
          {!drafts.length && (
            <p className="text-vr-gray text-center py-4">
              No hay ventas en espera.
            </p>
          )}
          {drafts.map((d) => (
            <div
              key={d.id}
              className="p-4 bg-navy rounded-xl border border-navy-3"
            >
              <h3 className="font-bold">{d.label}</h3>
              <p className="text-sm text-vr-gray mt-1">{d.summary}</p>
              <p className="text-xs text-vr-gray mt-1">
                Precios y disponibilidad se verifican al retomar.
              </p>
              <div className="flex flex-wrap gap-3 mt-3">
                <button
                  aria-label={`Retomar ${d.label}`}
                  disabled={busy}
                  onClick={() => onResume(d.id)}
                  className="text-gold font-bold"
                >
                  Retomar
                </button>
                {discard === d.id ? (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => onDiscard(d.id)}
                      className="text-vr-red"
                    >
                      Confirmar descarte
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => setDiscard(null)}
                      className="text-vr-gray"
                    >
                      Cancelar
                    </button>
                  </>
                ) : (
                  <button
                    aria-label={`Descartar ${d.label}`}
                    disabled={busy}
                    onClick={() => setDiscard(d.id)}
                    className="text-vr-red"
                  >
                    Descartar
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
export function CheckoutDialog({
  total,
  change,
  received,
  processing,
  payable,
  testData,
  children,
  onReceived,
  onConfirm,
  onClose,
  paymentControls,
  cashInput = true,
  conditionsLocked = false,
}: {
  total: string;
  change: string | null;
  received: string;
  processing: boolean;
  payable: boolean;
  testData: boolean;
  children?: ReactNode;
  onReceived: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
  paymentControls?: ReactNode;
  cashInput?: boolean;
  conditionsLocked?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current
      ?.querySelector<HTMLInputElement>("input:not(:disabled)")
      ?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[60] flex items-end sm:items-center justify-center sm:p-4">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !processing) {
            e.preventDefault();
            onClose();
          }
          if (
            e.key === "Enter" &&
            payable &&
            !processing &&
            e.target instanceof HTMLElement &&
            e.target.id === "received"
          ) {
            e.preventDefault();
            onConfirm();
          }
          if (e.key === "Tab") {
            const nodes = dialog.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
            );
            if (nodes?.length) {
              const first = nodes[0],
                last = nodes[nodes.length - 1];
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
              }
            }
          }
        }}
        className="bg-navy-2 w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[95vh] border border-navy-3"
      >
        <div className="p-4 sm:p-6 bg-navy border-b border-navy-3 flex justify-between items-center">
          <h2 id="checkout-title" className="text-xl font-display font-bold">
            Completar Pago
          </h2>
          <button
            disabled={processing}
            aria-label="Cerrar pago"
            onClick={onClose}
            className="text-xl px-2"
          >
            ✕
          </button>
        </div>
        <div className="p-4 sm:p-6 overflow-y-auto">
          <div className="text-center mb-6">
            <p className="text-vr-gray text-sm">Monto a Cobrar</p>
            <p className="text-4xl font-black font-mono text-gold">{total}</p>
          </div>
          {paymentControls ?? (
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-6">
              {["Efectivo", "Tarjeta", "Transfer.", "Fiado", "Mixto"].map(
                (m, i) => (
                  <button
                    key={m}
                    disabled={i !== 0 || processing}
                    title={
                      i !== 0 ? "Pendiente de integración nativa" : undefined
                    }
                    className={`py-3 rounded-xl font-bold text-xs border ${i === 0 ? "border-gold bg-gold/15 text-gold" : "border-navy-3 bg-navy-3 text-vr-gray opacity-40"}`}
                    aria-pressed={i === 0}
                  >
                    {m}
                  </button>
                ),
              )}
            </div>
          )}
          {cashInput && (
            <>
              <label
                htmlFor="received"
                className="block text-xs font-bold text-vr-gray mb-2 uppercase"
              >
                Monto recibido (RD$)
              </label>
              <input
                id="received"
                inputMode="decimal"
                disabled={processing || conditionsLocked}
                value={received}
                onChange={(e) => onReceived(e.target.value)}
                placeholder="0.00"
                className="w-full text-3xl font-mono font-black bg-navy rounded-xl p-4 border border-navy-3"
              />
              <div className="mt-4 flex justify-between border border-navy-3 rounded-xl p-4">
                <span className="text-vr-gray">Devuelta</span>
                <strong className="font-mono text-vr-green text-xl">
                  {change ?? "—"}
                </strong>
              </div>
            </>
          )}
          {children}
        </div>
        <div className="p-4 sm:p-6 bg-navy border-t border-navy-3">
          <button
            onClick={onConfirm}
            disabled={!payable || processing}
            className="w-full bg-gold-gradient text-navy font-extrabold text-lg py-4 rounded-xl disabled:opacity-30"
          >
            {processing
              ? "Procesando…"
              : testData
                ? "Confirmar venta de prueba"
                : "Confirmar Venta"}
          </button>
          <p className="text-xs text-vr-gray text-center mt-3">
            Impresora y comprobantes fiscales pendientes de integración
          </p>
        </div>
      </div>
    </div>
  );
}
