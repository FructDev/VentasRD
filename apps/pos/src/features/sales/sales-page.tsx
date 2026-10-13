import { useEffect, useState } from "react";
import Pagination from "@ventard/ui/pagination";
import {
  SalesWorkspace,
  CheckoutDialog,
  SavedCartDialog,
  type ProductView,
  type TicketLineView,
} from "@ventard/ui/pos";
import { showCents, posError } from "../../platform/pos-adapter";
import { useSales } from "./workspace";
import { CashDialog } from "../cash/cash-dialog";
import { TicketDialog } from "./ticket-dialog";
import {QrTransfer} from './qr-transfer';

export function SalesPage() {
  const s = useSales();
  const [pageState, setPage] = useState({ query: "", page: 1 });
  const [abandonConfirmation, setAbandonConfirmation] = useState(false);
  const [freeOpen, setFreeOpen] = useState(false),
    [freeName, setFreeName] = useState(""),
    [freePrice, setFreePrice] = useState(""),
    [freeQty, setFreeQty] = useState("1"),
    [freeError, setFreeError] = useState("");
  const filtered = (s.snapshot?.products ?? []).filter((p) =>
    p.kind!=='insumo'&&`${p.name} ${p.code}`.toLowerCase().includes(s.query.trim().toLowerCase()),
  );
  const pageSize = 60,
    totalPages = Math.max(1, Math.ceil(filtered.length / pageSize)),
    page = Math.min(
      pageState.query === s.query ? pageState.page : 1,
      totalPages,
    );
  const products: ProductView[] = filtered
    .slice((page - 1) * pageSize, page * pageSize)
    .map((p) => ({
      id: p.id,
      name: p.name,
      code: p.code,
      price:
        p.preview?.priceVerifiable === false
          ? "No verificable"
          : showCents(p.priceCents),
      stock: p.kind==='combo'?(p.possibleStock??'No verificable'):p.preview?.stockVerifiable === false ? "No verificable" : p.stock,
      stockUnknown: p.preview?.stockVerifiable === false,
      available: !!s.snapshot?.supportsDrafts || BigInt(p.stock || "0") > 0n,
    }));
  const byId = new Map(s.snapshot?.products.map((p) => [p.id, p]));
  const items: TicketLineView[] = s.lines.map((l) => {
    const p = byId.get(l.productId);
    const subtotal = s.quote?.lineTotals.find(
      (q) => q.productId === l.productId,
    )?.subtotalCents;
    const quotedPrice=s.quote?.lineTotals.find(q=>q.productId===l.productId)?.unitPriceCents;
    return {
      id: l.productId,
      name: l.free?.name ?? p?.name ?? "Producto no disponible",
      quantity: l.quantity,
      price: quotedPrice?showCents(quotedPrice):l.free
        ? showCents(l.free.unitPriceCents)
        : p?.preview && l.revision !== p.revision
          ? "Revisión pendiente"
          : p?.preview?.priceVerifiable === false
            ? "No verificable"
            : p
              ? showCents(p.priceCents)
              : "—",
      subtotal:
        subtotal !== null && subtotal !== undefined ? showCents(subtotal) : "—",
    };
  });
  const format = (v: string | null) =>
    v === null ? "Pendiente" : showCents(v);
  const totals = s.quote
    ? {
        subtotal: format(s.quote.subtotalCents),
        tax: format(s.quote.itbisCents),
        total: format(s.quote.totalCents),
      }
    : null;
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (e.key === "F2") {
        e.preventDefault();
        if (!s.paymentOpen && !s.result && !s.waitingOpen && !s.cashOpen)
          document.querySelector<HTMLInputElement>("#pos-search")?.focus();
        return;
      }
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.matches("input,textarea,select") ||
          e.target.isContentEditable);
      if (
        e.code === "Space" &&
        !typing &&
        !s.paymentOpen &&
        !s.result &&
        !s.waitingOpen &&
        !s.cashOpen
      ) {
        e.preventDefault();
        s.openPayment();
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [s]);
  if (s.loading)
    return (
      <div role="status" className="p-6 text-vr-gray">
        Abriendo datos nativos…
      </div>
    );
  if (!s.snapshot)
    return (
      <section className="p-6">
        <h1>Ventas</h1>
        <p role="alert" className="mt-4 text-vr-orange">
          {s.error}
        </p>
        <p className="mt-3 text-vr-gray">
          No se cargaron datos ficticios automáticamente ni se reemplazó tu
          base.
        </p>
        <button onClick={() => void s.refresh()} className="mt-4 text-gold">
          Volver a consultar
        </button>
      </section>
    );
  return (
    <>
      {s.synchronize&&<div className="px-4 py-2 bg-navy-2 border-b border-navy-3 text-xs flex flex-wrap items-center gap-3">
        <span>Sincronización · pendientes: {s.snapshot.pendingOperations}</span>
        <button onClick={()=>void s.synchronize?.()} disabled={s.syncing} className="text-gold font-bold">{s.syncing?"Sincronizando…":"Sincronizar ahora"}</button>
        {s.syncError&&<span role="status" className="text-vr-orange">{s.syncError}</span>}
        {s.snapshot.syncIssues?.filter(x=>["CONFLICT","INTERVENTION"].includes(x.state)).map(x=><span key={x.operationId} className="text-vr-red">{x.operationId.slice(-8)}: {x.code} · conservada para revisión</span>)}
      </div>}
      {s.cashOpen && s.readCash && (
        <CashDialog read={s.readCash} open={s.openTurn} management={s.management} synchronize={s.synchronize} onClose={() =>{s.setCashOpen(false);void s.refresh();}} />
      )}
      <SalesWorkspace
        onFree={
          s.snapshot.mode !== "staging-readonly" && s.snapshot.mode !== "recovery-readonly" && !s.locked
            ? () => {
                setFreeError("");
                setFreeOpen(true);
              }
            : undefined
        }
        products={products}
        items={items}
        totals={totals}
        query={s.query}
        busy={s.busy}
        pending={!!s.pending || !!s.cartPending}
        paymentBlocked={
          s.snapshot.mode === "staging-readonly" || s.snapshot.mode === "recovery-readonly" || s.quote?.totalCents === null
        }
        pausedCount={s.snapshot.carts.paused.length}
        onCash={s.readCash ? () => s.setCashOpen(true) : undefined}
        onWaiting={() => s.setWaitingOpen(true)}
        drawerOpen={s.drawerOpen}
        onQuery={s.setQuery}
        onSearchEnter={() => {
          if (filtered[0]) s.add(filtered[0].id);
        }}
        onSelect={s.add}
        onQuantity={s.quantity}
        onRemove={s.remove}
        onClear={s.clear}
        onPay={s.openPayment}
        onDrawer={s.setDrawerOpen}
        catalogueFooter={
          <Pagination
            pagina={page}
            totalPaginas={totalPages}
            totalItems={filtered.length}
            itemsPorPagina={pageSize}
            onCambiar={(p) => setPage({ query: s.query, page: p })}
          />
        }
        notice={
          <>
            {s.snapshot.mode==='staging-readonly' && s.snapshot.supportsDrafts && (
              <p className="px-4 py-2 text-xs text-vr-gray border-b border-navy-3">
                Borrador local de tu cuenta · no reserva ni descuenta stock.
                Subtotal de la captura; ITBIS y total pendientes. Caja,
                validación comercial y cobro todavía deshabilitados.
              </p>
            )}
            {s.snapshot.preview && (
              <p className="px-4 py-1 text-[11px] text-vr-gray">
                {s.snapshot.preview.scope} · captura{" "}
                {new Date(Number(s.snapshot.preview.asOf)).toLocaleString(
                  "es-DO",
                )}{" "}
                · no es disponibilidad actual.
              </p>
            )}
            {s.quote?.limits?.includes("CATALOGUE_CHANGED") && (
              <p className="px-4 py-2 text-xs text-vr-orange">
                El catálogo cambió. El carrito se conserva sin modificar sus
                referencias.{" "}
                <button
                  disabled={s.locked}
                  onClick={s.reviewDraft}
                  className="underline"
                >
                  Revisar precios del catálogo actual
                </button>
              </p>
            )}
            {s.snapshot.status === "needs-dataset" && (
              <div className="p-4 border-b border-gold/30 text-sm">
                <span>No hay catálogo en el vault de pruebas. </span>
                <button
                  onClick={() => void s.createTestDataset()}
                  disabled={s.busy}
                  className="text-gold font-bold"
                >
                  Crear datos sintéticos
                </button>
              </div>
            )}
            {s.error && (
              <p role="alert" className="px-4 py-2 text-sm text-vr-red">
                {s.error}
              </p>
            )}
            {s.quoteError && (
              <p role="alert" className="px-4 py-2 text-sm text-vr-orange">
                {s.quoteError}
              </p>
            )}
            {s.cartPending && !s.busy && (
              <div className="px-4 py-2 text-vr-orange text-sm">
                Guardado sin respuesta verificable.{" "}
                <button
                  onClick={() => void s.retryCart()}
                  className="underline"
                >
                  Reintentar el mismo guardado
                </button>
              </div>
            )}
            {s.pending && (
              <div className="px-4 py-2 bg-gold/10 text-sm">
                Intento guardado — sin confirmar.{" "}
                <button
                  disabled={s.busy}
                  onClick={() => void s.retryPending()}
                  className="text-gold underline"
                >
                  Reintentar el mismo intento
                </button>
                <span className="ml-2 text-vr-gray">
                  No cambies sus condiciones sin abandono autorizado.
                </span>
                <button
                  disabled={s.busy}
                  onClick={s.inspectPending}
                  className="text-gold underline ml-2"
                >
                  Revisar intento
                </button>
              </div>
            )}
            {s.snapshot.lastResult && (
              <div className="px-4 py-1.5 text-xs text-vr-gray border-b border-navy-3">
                Última venta local:{" "}
                <button
                  className="text-gold"
                  onClick={() =>
                    void s.recover(s.snapshot!.lastResult!.operationId)
                  }
                >
                  Recuperar venta · {s.snapshot.lastResult.ticket}
                </button>
              </div>
            )}
          </>
        }
      >
        <p className="px-4 py-2 text-[11px] text-vr-gray">
          {s.busy
            ? "Procesando cambio local…"
            : s.cartPending
              ? "No se confirmó el último cambio del carrito."
              : s.snapshot.carts.active
                ? "Carrito guardado localmente; se recupera al reabrir."
                : "Cada cambio aceptado del carrito se guarda localmente."}
        </p>
      </SalesWorkspace>
      {s.waitingOpen && (
        <SavedCartDialog
          drafts={s.snapshot.carts.paused.map((c) => ({
            id: c.id,
            label: c.label,
            summary: c.lines
              .map(
                (l) =>
                  `${l.free?.name ?? s.snapshot?.products.find((p) => p.id === l.productId)?.name ?? "Producto no disponible"} × ${l.quantity}`,
              )
              .join(" · "),
          }))}
          canPause={
            s.lines.length > 0 &&
            s.snapshot.carts.paused.length < 10 &&
            !s.pending &&
            !s.cartPending
          }
          busy={s.busy || !!s.cartPending}
          onPause={() => void s.pauseCart()}
          onResume={(id) => void s.resumeCart(id)}
          onDiscard={(id) => void s.discardCart(id)}
          onClose={() => s.setWaitingOpen(false)}
        >
          {s.error && (
            <p role="alert" className="text-vr-red text-sm">
              {s.error}
            </p>
          )}
          {s.cartPending && !s.busy && (
            <button
              onClick={() =>
                void s.retryCart().then((ok) => {
                  if (ok) s.setWaitingOpen(false);
                })
              }
              className="text-gold underline"
            >
              Reintentar el mismo guardado
            </button>
          )}
        </SavedCartDialog>
      )}
      {s.paymentOpen && !s.result && (
        <CheckoutDialog
          total={totals?.total ?? "—"}
          change={s.quote?.changeCents ? showCents(s.quote.changeCents) : null}
          received={s.received}
          processing={s.busy}
          payable={!!s.pending || (!!s.quote?.payable && !s.inputError)}
          conditionsLocked={!!s.pending}
          cashInput={["CASH", "MIXED"].includes(s.paymentMethod)}
          paymentControls={
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-6">
              {(
                [
                  ["CASH", "Efectivo"],
                  ["CARD", "Tarjeta"],
                  ["TRANSFER", "Transferencia"],
                  ["CREDIT", "Fiado"],
                  ["MIXED", "Mixto"],
                ] as const
              ).map(([method, label]) => (
                <button
                  key={method}
                  disabled={s.busy || !!s.pending}
                  aria-pressed={s.paymentMethod === method}
                  onClick={() => s.setPaymentMethod(method)}
                  className={`py-3 rounded-xl font-bold text-xs border ${s.paymentMethod === method ? "border-gold bg-gold/15 text-gold" : "border-navy-3 text-vr-gray"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          }
          testData={s.snapshot.mode === "synthetic"}
          onReceived={s.setReceived}
          onConfirm={() => void s.confirm()}
          onClose={s.closePayment}
        >
          {s.paymentMethod==='TRANSFER'&&s.snapshot.business&&s.quote?.totalCents&&<QrTransfer business={s.snapshot.business} cents={s.quote.totalCents}/>}
          {s.paymentMethod === "MIXED" && (
            <div className="grid grid-cols-2 gap-3 mt-4">
              <label className="text-sm text-vr-gray">
                Parte efectivo (RD$)
                <input
                  inputMode="decimal"
                  disabled={s.busy || !!s.pending}
                  value={s.mixedCash}
                  onChange={(e) => s.setMixedCash(e.target.value)}
                  className="w-full mt-2 rounded-xl bg-navy p-3 text-white"
                />
              </label>
              <label className="text-sm text-vr-gray">
                Parte transferencia (RD$)
                <input
                  inputMode="decimal"
                  disabled={s.busy || !!s.pending}
                  value={s.mixedTransfer}
                  onChange={(e) => s.setMixedTransfer(e.target.value)}
                  className="w-full mt-2 rounded-xl bg-navy p-3 text-white"
                />
              </label>
            </div>
          )}
          {s.paymentMethod === "CREDIT" && (
            <label className="block mt-4 text-sm text-vr-gray">
              Cliente para fiado
              <select
                aria-label="Cliente para fiado"
                disabled={s.busy || !!s.pending}
                value={s.customerId}
                onChange={(e) => s.setCustomerId(e.target.value)}
                className="w-full mt-2 bg-navy rounded-xl p-3 text-white"
              >
                <option value="">Selecciona un cliente</option>
                {(s.snapshot.customers ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · saldo {showCents(c.balanceCents)} · límite{" "}
                    {c.limitCents === null
                      ? "No verificable"
                      : c.limitCents === "0"
                        ? "Sin límite"
                        : showCents(c.limitCents)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {s.paymentMethod !== "CREDIT" && (
            <div className="space-y-3 mt-4">
              <label className="block text-sm text-vr-gray">
                Cliente de la venta
                <select
                  aria-label="Cliente de la venta"
                  disabled={s.busy || !!s.pending}
                  value={s.customerId}
                  onChange={(e) => {
                    s.setCustomerId(e.target.value);
                    s.setCustomerName("");
                  }}
                  className="w-full mt-2 bg-navy rounded-xl p-3 text-white"
                >
                  <option value="">Consumidor final / nombre libre</option>
                  {(s.snapshot.customers ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              {!s.customerId && (
                <label className="block text-sm text-vr-gray">
                  Nombre para el ticket
                  <input
                    maxLength={256}
                    disabled={s.busy || !!s.pending}
                    value={s.customerName}
                    onChange={(e) => s.setCustomerName(e.target.value)}
                    className="w-full mt-2 bg-navy rounded-xl p-3 text-white"
                    placeholder="Opcional"
                  />
                </label>
              )}
              <p className="text-xs text-vr-gray">
                El cliente registrado aplica su nivel de precios verificado.
                Las ventas de contado no crean deuda.
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 mt-4">
            <label className="text-sm text-vr-gray">
              {s.discountKind==='amount'?'Descuento (RD$)':'Descuento (%)'}
              <input
                aria-label={s.discountKind==='amount'?'Descuento (RD$)':'Descuento (%)'}
                inputMode="decimal"
                disabled={s.busy || !!s.pending}
                value={s.discount}
                onChange={(e) => s.setDiscount(e.target.value)}
                className="w-full mt-2 bg-navy rounded-xl p-3 text-white"
              />
              <select aria-label="Tipo de descuento" disabled={s.busy||!!s.pending} value={s.discountKind} onChange={e=>s.setDiscountKind(e.target.value as 'amount'|'percent')} className="w-full mt-2 bg-navy rounded-xl p-2 text-white"><option value="amount">Importe RD$</option><option value="percent">Porcentaje %</option></select>
            </label>
            <label className="text-sm text-vr-gray">
              Comprobante de prueba
              <select
                disabled={s.busy || !!s.pending}
                value={s.fiscalType ?? ""}
                onChange={(e) =>
                  s.setFiscalType(
                    (e.target.value || null) as "B01" | "B02" | null,
                  )
                }
                className="w-full mt-2 bg-navy rounded-xl p-3 text-white"
              >
                <option value="">Sin NCF de prueba</option>
                <option value="B02">B02 · sintético</option>
                <option value="B01">B01 · sintético</option>
              </select>
            </label>
          </div>
          {s.lines.map((l) => {
            const product = s.snapshot?.products.find(
              (p) => p.id === l.productId,
            );
            return product?.availableSerials?.length ? (
              <label
                key={l.productId}
                className="block text-sm text-vr-gray mt-4"
              >
                Serial / IMEI de {product.name}
                <select
                  disabled={s.busy || !!s.pending}
                  value={s.serials[l.productId] ?? ""}
                  onChange={(e) =>
                    s.setSerials((old) => ({
                      ...old,
                      [l.productId]: e.target.value,
                    }))
                  }
                  className="w-full mt-2 bg-navy rounded-xl p-3 font-mono text-white"
                >
                  <option value="">Selecciona un serial disponible</option>
                  {product.availableSerials.map((serial) => (
                    <option key={serial} value={serial}>
                      {serial}
                    </option>
                  ))}
                </select>
              </label>
            ) : null;
          })}
          {s.quote?.limits?.map((code) => (
            <p key={code} role="alert" className="text-sm text-vr-orange mt-3">
              {posError({ code })}
            </p>
          ))}
          {s.error && (
            <p role="alert" className="text-sm text-vr-red mt-3">
              {s.error}
            </p>
          )}
          <p className="mt-3 text-xs text-vr-gray">
            El núcleo calcula importes y valida turno, crédito y stock. Pago
            registrado no significa liquidación bancaria. NCF y datos de este
            entorno son sintéticos.
          </p>
          {s.inputError && (
            <p role="alert" className="mt-3 text-vr-red text-sm">
              {s.inputError}
            </p>
          )}
          {s.pending && s.canAbandon && (
            <div className="text-sm mt-4 text-vr-orange">
              <p>
                Este intento conserva sus condiciones originales. Recuperarlo no
                crea otra venta.
              </p>
              {abandonConfirmation ? (
                <>
                  <button
                    disabled={s.busy}
                    onClick={() =>
                      void s
                        .abandonPending()
                        .then(() => setAbandonConfirmation(false))
                    }
                    className="text-vr-red underline mt-2"
                  >
                    Confirmar abandono del intento
                  </button>
                  <p className="text-xs mt-2">
                    No se modifica una venta confirmada. Un NCF reservado no se
                    reutiliza.
                  </p>
                </>
              ) : (
                <button
                  disabled={s.busy}
                  onClick={() => setAbandonConfirmation(true)}
                  className="underline mt-2"
                >
                  Abandonar este intento
                </button>
              )}
            </div>
          )}
        </CheckoutDialog>
      )}
      {freeOpen && (
        <div className="fixed inset-0 z-[65] bg-black/70 flex items-center justify-center p-4">
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="free-title"
            className="bg-navy-2 border border-navy-3 rounded-2xl p-6 w-full max-w-lg"
            onSubmit={(e) => {
              e.preventDefault();
              void (async () => {
                try {
                  setFreeError("");
                  if (await s.addFree(freeName, freePrice, freeQty)) {
                    setFreeOpen(false);
                    setFreeName("");
                    setFreePrice("");
                    setFreeQty("1");
                  }
                } catch (error) {
                  setFreeError(posError(error));
                }
              })();
            }}
          >
            <h2 id="free-title" className="text-xl font-bold">
              Venta libre
            </h2>
            <p className="text-xs text-vr-gray my-3">
              Línea explícita sin producto ni movimiento de inventario. Impuesto
              calculado por el núcleo con la configuración disponible.
            </p>
            <label className="block mt-3 text-sm">
              Descripción
              <input
                required
                maxLength={512}
                autoFocus
                disabled={s.busy}
                value={freeName}
                onChange={(e) => setFreeName(e.target.value)}
                className="w-full mt-2 bg-navy rounded-xl p-3"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block mt-3 text-sm">
                Precio libre (RD$)
                <input
                  required
                  inputMode="decimal"
                  disabled={s.busy}
                  value={freePrice}
                  onChange={(e) => setFreePrice(e.target.value)}
                  className="w-full mt-2 bg-navy rounded-xl p-3"
                />
              </label>
              <label className="block mt-3 text-sm">
                Cantidad libre
                <input
                  required
                  inputMode="numeric"
                  pattern="[1-9][0-9]*"
                  disabled={s.busy}
                  value={freeQty}
                  onChange={(e) => setFreeQty(e.target.value)}
                  className="w-full mt-2 bg-navy rounded-xl p-3"
                />
              </label>
            </div>
            {freeError && (
              <p role="alert" className="text-vr-red mt-3">
                {freeError}
              </p>
            )}
            <div className="flex gap-4 mt-5">
              <button
                type="button"
                disabled={s.busy}
                onClick={() => setFreeOpen(false)}
                className="text-vr-gray"
              >
                Cancelar
              </button>
              <button
                disabled={s.busy}
                className="bg-gold text-navy rounded-xl p-3 font-bold"
              >
                Agregar línea libre
              </button>
            </div>
          </form>
        </div>
      )}
      {s.result && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[60] flex items-center justify-center p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="sale-result"
            className="bg-navy-2 border border-navy-3 rounded-2xl p-6 sm:p-10 max-w-lg w-full text-center"
            data-sale-result
          >
            <div className="text-4xl text-vr-green mb-3">✓</div>
            <h2 id="sale-result" className="text-2xl font-black">
              Venta confirmada localmente
            </h2>
            <p className="my-3 font-mono text-vr-gray">
              Ticket {s.result.ticket}
            </p>
            {s.result.paymentMethod && (
              <p className="text-sm text-gold">
                Método: {s.result.paymentMethod}
              </p>
            )}
            {s.result.ncf && (
              <p className="text-sm font-mono mt-2">
                NCF de prueba: {s.result.ncf}
              </p>
            )}
            <p>
              Total: <strong>{showCents(s.result.totalCents)}</strong> · ITBIS:{" "}
              {showCents(s.result.itbisCents)}
            </p>
            <div className="my-4 bg-vr-green/10 rounded-xl p-4">
              <p className="text-vr-gray">Devuelta</p>
              <strong className="text-3xl font-mono text-vr-green">
                {showCents(s.result.changeCents)}
              </strong>
            </div>
            <p className="text-sm text-vr-gray">
              Venta de Staging. Impresora no configurada.
            </p>
            <p className="text-sm mt-2" data-sale-sync-status>{s.snapshot.lastResult?.operationId===s.result.operationId&&s.snapshot.lastResult.remoteStatus==='APPLIED'?'Sincronizada con recibo remoto verificado.':`Estado remoto: ${s.snapshot.lastResult?.operationId===s.result.operationId?s.snapshot.lastResult.remoteStatus:s.result.remoteStatus}. No se afirma sincronización sin recibo.`}</p>
            {s.retryRemote&&s.snapshot.syncIssues?.some(x=>x.operationId===s.result?.operationId&&['CONFLICT','INTERVENTION'].includes(x.state))&&<button disabled={s.busy||s.syncing} className="text-gold border border-gold/40 rounded-xl px-4 py-2 mt-3" onClick={()=>{if(window.confirm('Reintentar el mismo intento tras revisar la causa. No cambia ID, ticket, importe ni stock local.'))void s.retryRemote?.(s.result!.operationId);}}>Revisar y reintentar el mismo intento</button>}
            {s.error&&<p role="alert" className="text-vr-red text-sm mt-2">{s.error}</p>}
            <button
              disabled={s.busy}
              onClick={() => void s.showTicket()}
              className="border border-gold/40 rounded-xl px-4 py-2 mt-4 text-gold"
            >
              Ver ticket guardado
            </button>
            <button
              disabled
              className="border border-navy-3 rounded-xl px-4 py-2 mt-4 text-vr-gray"
            >
              Imprimir ticket · pendiente
            </button>
            <button
              onClick={() => {
                s.setResult(null);
                s.setTicket(null);
                document
                  .querySelector<HTMLInputElement>("#pos-search")
                  ?.focus();
              }}
              className="mt-4 w-full bg-gold-gradient text-navy rounded-xl p-4 font-bold"
            >
              Nueva Venta →
            </button>
          </div>
        </div>
      )}
      {s.ticket && (
        <TicketDialog
          key={s.ticket.operationId}
          ticket={s.ticket}
          autoPrint={s.autoPrintTicket}
          synthetic={s.snapshot.mode === "synthetic"}
          onClose={() => s.setTicket(null)}
        />
      )}
    </>
  );
}
