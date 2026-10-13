import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  nativePosPort,
  posError,
  posErrorCode,
  inputCents,
  type PosPort,
  type PosSnapshot,
  type PosLine,
  type PosQuote,
  type PosSale,
  type PosResult,
  type PosProductWrite,
  type PosStockChange,
  type PosCatalogueResult,
  type PosCartSave,
  type PosCartAction,
  type PosCartResult,
  type PosOptions,
  type PosTicket,
} from "../../platform/pos-adapter";
type CartAttempt =
  | { kind: "save"; request: PosCartSave }
  | { kind: "action"; request: PosCartAction };
function editableCents(value: string) {
  const cents = BigInt(value);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
function useWorkspace(port: PosPort) {
  const [snapshot, setSnapshot] = useState<PosSnapshot | null>(null),
    [loading, setLoading] = useState(true);
  const [lines, setLines] = useState<PosLine[]>([]),
    [query, setQuery] = useState(""),
    [received, setReceived] = useState("");
  const [paymentOpen, setPaymentOpen] = useState(false),
    [drawerOpen, setDrawerOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<
    "CASH" | "CARD" | "TRANSFER" | "MIXED" | "CREDIT"
  >("CASH");
  const [discount, setDiscount] = useState("0"),
    [mixedCash, setMixedCash] = useState(""),
    [mixedTransfer, setMixedTransfer] = useState(""),
    [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [discountKind,setDiscountKind]=useState<'amount'|'percent'>('amount');
  const [serials, setSerials] = useState<Record<string, string>>({}),
    [fiscalType, setFiscalType] = useState<"B01" | "B02" | null>(null);
  const [cashOpen, setCashOpen] = useState(false);
  const [ticket, setTicket] = useState<PosTicket | null>(null);
  const [autoPrintTicket,setAutoPrintTicket]=useState(false);
  const [waitingOpen, setWaitingOpen] = useState(false),
    [cartPending, setCartPending] = useState<CartAttempt | null>(null);
  const [result, setResult] = useState<PosResult | null>(null),
    [pending, setPending] = useState<PosSale | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const busyRef = useRef(false),
    intentRef = useRef<PosSale | null>(null);
  const [quoteState, setQuoteState] = useState<{
    key: string;
    value: PosQuote | null;
    error: string;
  }>({ key: "", value: null, error: "" });
  let tenderCents: string | null = null;
  let inputError = "";
  if (received && ["CASH", "MIXED"].includes(paymentMethod)) {
    try {
      tenderCents = inputCents(received);
    } catch (e) {
      inputError = posError(e);
    }
  }
  let options: PosOptions | undefined;
  try {
    const payment: PosOptions["payment"] =
      paymentMethod === "CASH"
        ? { method: "CASH", tenderCents: tenderCents ?? "0" }
        : paymentMethod === "MIXED"
          ? {
              method: "MIXED",
              cashCents: inputCents(mixedCash || "0"),
              transferCents: inputCents(mixedTransfer || "0"),
              tenderCents: tenderCents ?? "0",
            }
          : paymentMethod === "CREDIT"
            ? { method: "CREDIT", customerId }
            : { method: paymentMethod };
    options = {
      payment,
      ...(snapshot?.defaultWarrantyDays&&Object.keys(serials).some(id=>lines.some(l=>l.productId===id))?{warrantyDays:snapshot.defaultWarrantyDays}:{}),

      discountCents:discountKind==='amount'?inputCents(discount||"0"):"0",
      ...(discountKind==='percent'?{discountPercentBasisPoints:inputCents(discount||'0')}:{}),
      serials: Object.fromEntries(
        Object.entries(serials).filter(([id]) =>
          lines.some((l) => l.productId === id),
        ),
      ),
      ...(customerId
        ? { customer: { type: "REGISTERED" as const, id: customerId } }
        : paymentMethod !== "CREDIT" && customerName.trim()
          ? { customer: { type: "NAMED" as const, name: customerName.trim() } }
          : {}),
    };
  } catch (e) {
    inputError = posError(e);
  }
  const quoteKey = JSON.stringify({
    scopeRevision:snapshot?.scopeRevision,
    lines,
    tenderCents,
    options,
    catalogueVersions: snapshot?.products.map((p) => [
      p.id,
      p.revision,
      p.stock,
    ]),
  });
  function restoreAttempt(attempt: PosSale | null) {
    if (!attempt) return;
    const opts = attempt.options;
    const payment = opts?.payment;
    setPaymentMethod(payment?.method ?? "CASH");
    setReceived(editableCents(attempt.tenderCents));
    setDiscountKind(opts?.discountPercentBasisPoints===undefined?'amount':'percent');
    setDiscount(editableCents(opts?.discountPercentBasisPoints??opts?.discountCents??"0"));
    setSerials(opts?.serials ?? {});
    setFiscalType(attempt.fiscalType ?? null);
    setCustomerId(
      opts?.customer?.type === "REGISTERED"
        ? opts.customer.id
        : payment?.method === "CREDIT"
          ? payment.customerId
          : "",
    );
    setCustomerName(opts?.customer?.type === "NAMED" ? opts.customer.name : "");
    setMixedCash(
      payment?.method === "MIXED" ? editableCents(payment.cashCents) : "",
    );
    setMixedTransfer(
      payment?.method === "MIXED" ? editableCents(payment.transferCents) : "",
    );
  }
  useEffect(() => {
    let active = true;
    void port
      .load()
      .then((data) => {
        if (!active) return;
        setSnapshot(data);
        setLines(data.pendingAttempt?.lines ?? data.carts.active?.lines ?? []);
        setPending(data.pendingAttempt);
        intentRef.current = data.pendingAttempt;
        restoreAttempt(data.pendingAttempt);
        setLoading(false);
      })
      .catch((e) => {
        if (active) {
          setError(posError(e));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [port]);
  const ready =
    snapshot?.status === "ready" &&
    (snapshot.mode !== "staging-readonly" || snapshot.supportsDrafts);
  const [syncError,setSyncError]=useState(""),[syncing,setSyncing]=useState(false);
  const syncRef=useRef(false);
  async function synchronize(){
    if(!port.synchronize||syncRef.current)return;
    syncRef.current=true;setSyncing(true);
    try{const data=await port.synchronize();setSnapshot(data);setSyncError("");}
    catch(e){setSyncError(posError(e));try{setSnapshot(await port.load());}catch{/* Offline grant/PIN can also be unavailable; do not replace data. */}}
    finally{syncRef.current=false;setSyncing(false);}
  }
  useEffect(()=>{
    if(!ready||!port.synchronize)return;
    const perform=port.synchronize;
    let active=true,inFlight=false;
    const step=async()=>{if(!active||inFlight||syncRef.current)return;inFlight=true;syncRef.current=true;
      try{const data=await perform();if(active){setSnapshot(data);setSyncError("");}}
      catch(e){if(active){setSyncError(posError(e));try{const data=await port.load();if(active)setSnapshot(data);}catch{/* Keep prior local view; never invent a new dataset. */}}}
      finally{inFlight=false;syncRef.current=false;}
    };
    const timer=setInterval(()=>void step(),5000);void step();return()=>{active=false;clearInterval(timer);};
  },[port,ready]);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const args = JSON.parse(quoteKey) as {
      lines: PosLine[];
      tenderCents: string | null;
      options?: PosOptions;
    };
    void port
      .quote(args.lines, args.tenderCents, args.options)
      .then((value) => {
        if (active) setQuoteState({ key: quoteKey, value, error: "" });
      })
      .catch((e) => {
        if (active)
          setQuoteState({ key: quoteKey, value: null, error: posError(e) });
      });
    return () => {
      active = false;
    };
  }, [port, ready, quoteKey]);
  const quote = quoteState.key === quoteKey ? quoteState.value : null;
  const quoteError = quoteState.key === quoteKey ? quoteState.error : "";
  async function refresh() {
    const data = await port.load();
    setSnapshot(data);
    setLines(data.pendingAttempt?.lines ?? data.carts.active?.lines ?? []);
    setPending(data.pendingAttempt);
    intentRef.current = data.pendingAttempt;
    restoreAttempt(data.pendingAttempt);
  }
  async function action(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(posError(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const editingLocked =
    (snapshot?.mode === "staging-readonly" && !snapshot.supportsDrafts) ||
    busy ||
    !!pending ||
    paymentOpen ||
    cashOpen ||
    !!result ||
    !!cartPending;
  const locked = editingLocked || waitingOpen;
  async function runCart(attempt: CartAttempt): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setCartPending(attempt);
    try {
      const ack: PosCartResult = await (attempt.kind === "save"
        ? port.saveCart(attempt.request)
        : port.cartAction(attempt.request));
      setSnapshot((old) => (old ? { ...old, carts: ack.workspace } : old));
      setLines(ack.workspace.active?.lines ?? []);
      setCartPending(null);
      return true;
    } catch (e) {
      setError(posError(e));
      if (["CONTRACT_INVALID", "VERSION_CONFLICT"].includes(posErrorCode(e)))
        setCartPending(null);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function persistLines(next: PosLine[]) {
    if (locked || busyRef.current) return;
    const cart = snapshot?.carts.active;
    void runCart({
      kind: "save",
      request: {
        requestId: crypto.randomUUID(),
        cartId: cart?.id ?? null,
        expectedRevision: cart?.revision ?? null,
        lines: next,
      },
    });
  }
  function add(id: string) {
    if (locked) return;
    const p = snapshot?.products.find((p) => p.id === id);
    if (!p||p.kind==='insumo') return;
    persistLines(
      lines.some((l) => l.productId === id)
        ? lines.map((l) =>
            l.productId === id
              ? { ...l, quantity: (BigInt(l.quantity) + 1n).toString() }
              : l,
          )
        : [...lines, { productId: p.id, quantity: "1", revision: p.revision }],
    );
  }
  async function addFree(name: string, price: string, quantity: string) {
    if (locked || busyRef.current) return false;
    if (!/^[1-9][0-9]{0,9}$/.test(quantity)) throw { code: "CONTRACT_INVALID" };
    const cart = snapshot?.carts.active;
    const next = [
      ...lines,
      {
        productId: crypto.randomUUID(),
        quantity,
        revision: "1",
        free: { name: name.trim(), unitPriceCents: inputCents(price) },
      },
    ];
    return runCart({
      kind: "save",
      request: {
        requestId: crypto.randomUUID(),
        cartId: cart?.id ?? null,
        expectedRevision: cart?.revision ?? null,
        lines: next,
      },
    });
  }
  function quantity(id: string, delta: 1 | -1) {
    if (locked) return;
    persistLines(
      lines.flatMap((l) => {
        if (l.productId !== id) return [l];
        const q = BigInt(l.quantity) + BigInt(delta);
        return q > 0n ? [{ ...l, quantity: q.toString() }] : [];
      }),
    );
  }
  function remove(id: string) {
    if (!locked) persistLines(lines.filter((l) => l.productId !== id));
  }
  function clear() {
    if (!locked && lines.length) persistLines([]);
  }
  async function draftAction(
    action: "PAUSE" | "RESUME" | "DISCARD",
    id?: string,
  ) {
    if (editingLocked || busyRef.current) return false;
    const active = snapshot?.carts.active;
    const target =
      action === "PAUSE"
        ? active
        : snapshot?.carts.paused.find((c) => c.id === id);
    if (!target) return false;
    const ok = await runCart({
      kind: "action",
      request: {
        requestId: crypto.randomUUID(),
        action,
        cartId: target.id,
        expectedRevision: target.revision,
        activeCartId: action === "RESUME" ? (active?.id ?? null) : null,
        activeRevision: action === "RESUME" ? (active?.revision ?? null) : null,
      },
    });
    if (ok) setWaitingOpen(false);
    return ok;
  }
  function openPayment() {
    if (!locked && lines.length && quote?.totalCents !== null && quote) {
      setReceived("");
      setPaymentOpen(true);
    }
  }
  function reviewDraft() {
    if (!locked)
      persistLines(
        lines.map((l) => {
          const p = snapshot?.products.find((p) => p.id === l.productId);
          return p ? { ...l, revision: p.revision } : l;
        }),
      );
  }
  async function confirm() {
    if (
      busyRef.current ||
      (!intentRef.current && (!quote?.payable || inputError))
    )
      return;
    await action(async () => {
      const sale = intentRef.current ?? {
        operationId: crypto.randomUUID(),
        lines: structuredClone(lines),
        tenderCents: ["CASH", "MIXED"].includes(paymentMethod)
          ? inputCents(received || "0")
          : "0",
        cartId: snapshot?.carts.active?.id,
        expectedCartRevision: snapshot?.carts.active?.revision,
        options: structuredClone(options),
        acceptedQuoteHash: quote?.quoteHash,
        fiscalType,
      };
      intentRef.current = sale;
      setPending(sale);
      const durable = await port.confirm(sale);
      // Éxito durable antes de refresh: fallo posterior no revive la intención
      // ni oculta una venta confirmada. Leer resultado es otro paso.
      setResult(durable);
      if(durable.printStatus==="QUEUED"&&port.ticket){try{setAutoPrintTicket(true);setTicket(await port.ticket(durable.operationId))}catch(e){setError("La venta quedó guardada. "+posError(e))}}
      setLines([]);
      setReceived("");
      setPaymentOpen(false);
      setDiscount("0");
      setMixedCash("");
      setMixedTransfer("");
      setSerials({});
      setCustomerId("");
      setCustomerName("");
      setFiscalType(null);
      setPaymentMethod("CASH");
      setPending(null);
      intentRef.current = null;
      try {
        await refresh();
      } catch (e) {
        setError(`La venta quedó confirmada. ${posError(e)}`);
      }
    });
  }
  async function recover(id: string) {
    await action(async () => {
      const saved = await port.result(id);
      if(saved){setResult(saved);if(saved.printStatus==="QUEUED"&&port.ticket){setAutoPrintTicket(true);setTicket(await port.ticket(saved.operationId))}}
    });
  }
  async function retryPending() {
    if (!intentRef.current) return;
    await confirm();
  }
  async function abandonPending() {
    const attempt = intentRef.current;
    if (!attempt || !port.abandon) return;
    await action(async () => {
      await port.abandon!(attempt.operationId);
      setPending(null);
      intentRef.current = null;
      setPaymentOpen(false);
      await refresh();
    });
  }
  async function showTicket() {
    if (!result || !port.ticket) return;
    setAutoPrintTicket(false);
    await action(async () => setTicket(await port.ticket!(result.operationId)));
  }
  function closePayment() {
    if (!busyRef.current) setPaymentOpen(false);
  }
  async function catalogueMutation(fn: () => Promise<PosCatalogueResult>) {
    if (busyRef.current) throw { code: "LOCAL_STORAGE_BUSY" };
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const durable = await fn();
      try {
        await refresh();
      } catch (e) {
        setError(`El cambio quedó guardado. ${posError(e)}`);
      }
      return durable;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return {
    management: port.management,
    autoPrintTicket,
    printTicket: port.printTicket,
    historyRead: port.historyRead,
    readTicket: port.ticket,
    customerName,
    setCustomerName,
    addFree,
    ticket,
    setTicket,
    showTicket,
    abandonPending,
    canAbandon: !!port.abandon,
    paymentMethod,
    setPaymentMethod,
    discount,
    setDiscount,
    discountKind,setDiscountKind,
    mixedCash,
    setMixedCash,
    mixedTransfer,
    setMixedTransfer,
    customerId,
    setCustomerId,
    serials,
    setSerials,
    fiscalType,
    setFiscalType,
    snapshot,
    loading,
    lines,
    query,
    setQuery,
    received,
    setReceived,
    quote,
    quoteError,
    inputError,
    paymentOpen,
    drawerOpen,
    setDrawerOpen,
    cashOpen,
    setCashOpen,
    readCash: port.readCash,
    openTurn:port.openTurn,
    synchronize:port.synchronize?synchronize:undefined,syncError,syncing,
    retryRemote:port.retry?(operationId:string)=>action(async()=>{setSnapshot(await port.retry!(operationId));await synchronize();}):undefined,
    result,
    setResult,
    pending,
    busy,
    error,
    locked,
    add,
    quantity,
    remove,
    clear,
    reviewDraft,
    openPayment,
    closePayment,
    confirm,
    recover,
    retryPending,
    inspectPending: () => {
      if (pending && !busy) setPaymentOpen(true);
    },
    waitingOpen,
    setWaitingOpen,
    cartPending,
    retryCart: () =>
      cartPending ? runCart(cartPending) : Promise.resolve(false),
    pauseCart: () => draftAction("PAUSE"),
    resumeCart: (id: string) => draftAction("RESUME", id),
    discardCart: (id: string) => draftAction("DISCARD", id),
    createTestDataset: () =>
      action(async () => {
        setSnapshot(await port.createTestDataset());
      }),
    refresh: () => action(refresh),
    saveProduct: (p: PosProductWrite) =>
      catalogueMutation(() => port.saveProduct(p)),
    adjustStock: (p: PosStockChange) =>
      catalogueMutation(() => port.adjustStock(p)),
  };
}
type Workspace = ReturnType<typeof useWorkspace>;
const WorkspaceContext = createContext<Workspace | null>(null);
export function SalesProvider({
  children,
  port = nativePosPort,
}: {
  children: ReactNode;
  port?: PosPort;
}) {
  const value = useWorkspace(port);
  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
export function useSales() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("SALES_PROVIDER_REQUIRED");
  return value;
}
