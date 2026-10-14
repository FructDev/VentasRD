// Puerto del frontend definitivo. Cambiar el consumidor comercial IPC-1 no
// requiere otra pantalla: actualmente el único consumidor habilitado es el
// fixture cifrado nativo, explícito y aislado; nunca fallback a datos JS.
import { qaInvoke, qaError, inputCents, showCents, type QaRead } from "./qa";
import {nativeManagementPort} from './management';
import {
  cataloguePort,
  accountDraftPort,
  cashPort,
  historyPort,
  salesAccountPort,
} from "./access";
export { inputCents, showCents };
export const posErrorCode = qaError;
export interface PosLine {
  productId: string;
  quantity: string;
  revision: string;
  free?: { name: string; unitPriceCents: string };
}
export interface PosProduct {
  id: string;
  name: string;
  code: string;
  priceCents: string;
  stock: string;
  revision: string;
  availableSerials?: string[];
  photo?:string|null;
  photoVersion?:string;
  photoUnavailable?:boolean;
  stockRevision?:string|null;
  costCents?:string|null;
  tier2Cents?:string|null;
  tier3Cents?:string|null;
  taxRate?:{numerator:string;denominator:string};
  minimum?:string|null;
  serialRequired?:boolean;
  recipe?:{productId:string;perUnit:{numerator:string;denominator:string};revision:string}[];
  possibleStock?:string|null;
  marginCents?:string|null;
  valuationCents?:string|null;
  kind?: "simple" | "insumo" | "combo";
  location?: string;
  locationKnown?:boolean;
  preview?: {
    priceVerifiable: boolean;
    stockVerifiable: boolean;
    stockEvidence: string;
  };
}
export interface PosProductWrite {
  operationId: string;
  productId: string | null;
  expectedRevision: string | null;
  name: string;
  code: string;
  priceCents: string;
}
export interface PosStockChange {
  operationId: string;
  productId: string;
  expectedRevision: string;
  delta: string;
  reason: string;
}
export interface PosCatalogueResult {
  operationId: string;
  product: PosProduct;
  remoteStatus: string;
}
export interface PosResult {
  operationId: string;
  hash: string;
  ticket: string;
  totalCents: string;
  itbisCents: string;
  changeCents: string;
  remoteStatus: string;
  paymentMethod?: string | null;
  discountCents?: string | null;
  ncf?: string | null;
  printStatus?: string | null;
}
export type PosPayment =
  | { method: "CASH"; tenderCents: string }
  | { method: "CARD" }
  | { method: "TRANSFER" }
  | {
      method: "MIXED";
      cashCents: string;
      transferCents: string;
      tenderCents: string;
    }
  | { method: "CREDIT"; customerId: string };
export interface PosOptions {
  warrantyDays?:string;
  payment: PosPayment;
  discountCents: string;
  discountPercentBasisPoints?:string;
  serials: Record<string, string>;
  customer?:
    { type: "REGISTERED"; id: string } | { type: "NAMED"; name: string };
}
export interface PosCustomer {
  id: string;
  name: string;
  balanceCents: string;
  limitCents: string | null;
}
export interface PosSale {
  operationId: string;
  lines: PosLine[];
  tenderCents: string;
  cartId?: string | null;
  expectedCartRevision?: string | null;
  options?: PosOptions;
  acceptedQuoteHash?: string | null;
  fiscalType?: "B01" | "B02" | null;
}
export interface PosCart {
  id: string;
  revision: string;
  label: string;
  lines: PosLine[];
}
export interface PosCartWorkspace {
  active: PosCart | null;
  paused: PosCart[];
}
export interface PosCartSave {
  requestId: string;
  cartId: string | null;
  expectedRevision: string | null;
  lines: PosLine[];
}
export interface PosCartAction {
  requestId: string;
  action: "PAUSE" | "RESUME" | "DISCARD";
  cartId: string;
  expectedRevision: string;
  activeCartId: string | null;
  activeRevision: string | null;
}
export interface PosCartResult {
  requestId: string;
  cartId: string;
  revision: string;
  workspace: PosCartWorkspace;
}
export interface PosQuote {
  subtotalCents: string | null;
  itbisCents: string | null;
  totalCents: string | null;
  changeCents: string | null;
  payable: boolean;
  lineTotals: { productId: string; subtotalCents: string | null;unitPriceCents?:string }[];
  limits?: string[];
  quoteHash?: string | null;
  discountCents?: string;
}
export interface PosSnapshot {business?:import("./management").BusinessHeader|null;
  defaultWarrantyDays?:string;
  status: "ready" | "needs-dataset";
  mode: "synthetic" | "commercial" | "staging-readonly" | "staging-operational" | "recovery-readonly";
  backupCapturedAtMs?:string;
  supportsDrafts?: boolean;
  scopeRevision?:string;
  inventoryReadOnly?:boolean;
  inventorySummary?:{lowCount:string;minimumCoverage:string;capitalCents:string|null;unknownCapitalProducts:string;bestMargin:{name:string;amountCents:string}|null};
  preview?: { asOf: string; scope: string; snapshotId: string };
  products: PosProduct[];
  confirmedSales: string;
  cashCents: string;
  pendingOperations: string;
  lastResult: PosResult | null;
  pendingAttempt: PosSale | null;
  carts: PosCartWorkspace;
  customers?: PosCustomer[];
  syncIssues?:{operationId:string;state:string;code:string}[];
}
export interface PosCashView {
  pendingOpening?:{operationId:string;openingCents:string;denominations?:import("./management").Denomination[]}|null;
  scope: "GLOBAL" | "BRANCH";
  branchId: string | null;
  turn: {
    operationId: string;
    turnId: string;
    actorId: string;
    openingCents: string;
    openedAtMs: string;
    remoteStatus: string;
  } | null;
  canOpen: boolean;
  limitation: "COMMERCIAL_BOOTSTRAP_REQUIRED"|"STAGING_NATIVE_SHARED_TURN";
}
export interface PosPort {
  photos?(productIds:string[]):Promise<{rows:{id:string;version:string;data:string}[]}>;
  printTicket?(operationId:string,snapshotHash:string,attemptId:string,raster?:import("./management").PrintRaster):Promise<{status:string;submitted?:boolean}>;
  management?: import('./management').ManagementPort;
  retry?(operationId:string):Promise<PosSnapshot>;
  synchronize?():Promise<PosSnapshot>;
  openTurn?(operationId:string,openingCents:string,denominations?:import("./management").Denomination[]):Promise<PosCashView>;
  historyRead?(filter: PosHistoryFilter): Promise<PosHistoryPage>;
  abandon?(operationId: string): Promise<void>;
  ticket?(operationId: string): Promise<PosTicket>;
  load(): Promise<PosSnapshot>;
  createTestDataset(): Promise<PosSnapshot>;
  quote(
    lines: PosLine[],
    tenderCents: string | null,
    options?: PosOptions,
  ): Promise<PosQuote>;
  confirm(sale: PosSale): Promise<PosResult>;
  result(id: string): Promise<PosResult | null>;
  saveProduct(product: PosProductWrite): Promise<PosCatalogueResult>;
  adjustStock(movement: PosStockChange): Promise<PosCatalogueResult>;
  saveCart(cart: PosCartSave): Promise<PosCartResult>;
  cartAction(cart: PosCartAction): Promise<PosCartResult>;
  readCash?(): Promise<PosCashView>;
}
function snapshot(value: QaRead): PosSnapshot {
  return {
    status: value.status === "READY" ? "ready" : "needs-dataset",
    mode: "synthetic",
    products: (value.catalogue?.products ?? []).map((p) => ({
      ...p,
      kind: "simple",
    })),
    confirmedSales: value.catalogue?.confirmedSales ?? "0",
    cashCents: value.catalogue?.cashCents ?? "0",
    pendingOperations: value.catalogue?.pendingOperations ?? "0",
    lastResult: value.catalogue?.lastResult ?? null,
    pendingAttempt: value.catalogue?.pendingAttempt ?? null,
    carts: value.catalogue?.carts ?? { active: null, paused: [] },
    customers: value.catalogue?.customers ?? [],
  };
}
export const nativePosPort: PosPort = {
  historyRead: (filter) =>
    qaInvoke<PosHistoryPage>("qa_history_read", { filter }),
  abandon: (operationId) => qaInvoke<void>("qa_sale_abandon", { operationId }),
  ticket: (operationId) =>
    qaInvoke<PosTicket>("qa_sale_ticket", { operationId }),
  async load() {
    return snapshot(await qaInvoke<QaRead>("qa_read"));
  },
  async createTestDataset() {
    return snapshot(await qaInvoke<QaRead>("qa_create"));
  },
  quote(lines, tenderCents, options) {
    return qaInvoke<PosQuote>("qa_quote", {
      quote: { lines, tenderCents, options },
    });
  },
  confirm(sale) {
    return qaInvoke<PosResult>("qa_sell", { sale });
  },
  result(operationId) {
    return qaInvoke<PosResult | null>("qa_result", { operationId });
  },
  saveProduct(product) {
    return qaInvoke<PosCatalogueResult>("qa_product_save", { product });
  },
  adjustStock(movement) {
    return qaInvoke<PosCatalogueResult>("qa_stock_adjust", { movement });
  },
  saveCart(cart) {
    return qaInvoke<PosCartResult>("qa_cart_save", { cart });
  },
  cartAction(cart) {
    return qaInvoke<PosCartResult>("qa_cart_action", { cart });
  },
};
const errors: Record<string, string> = {
  PRINT_QUEUE_MISSING:'La cola de impresora ya no está instalada. Revisa la conexión en Ajustes.',
  PRINT_TARGET_CHANGED:'La conexión de impresión cambió. Vuelve a abrir el ticket para usar el destino actual.',
  PRINT_TARGET_INVALID:'Selecciona una conexión de impresora válida en Ajustes.',
  PRINT_WIDTH_CONFLICT:'El ancho en puntos de la impresora no coincide con 58/80mm. Ajusta la conexión en Ajustes.',
  PRINT_RASTER_INVALID:'No se pudo preparar la imagen completa del ticket. No se envió una nueva impresión.',
  PRINT_RASTER_REQUIRED:'Se requiere la imagen original del ticket para imprimir directamente.',
  PRINT_DIRECT_REQUIRED:'La página de prueba requiere seleccionar impresión directa.',
  PRINT_TRANSPORT_UNCERTAIN:'No se pudo confirmar el envío a la impresora. Comprueba el papel y recupera el intento; no se reenviará automáticamente.',
  FISCAL_SETTINGS_MIGRATION_REQUIRED:'La configuración fiscal nativa aún no está instalada en Staging. La secuencia y las reservas existentes se conservan.',
  FISCAL_SETTINGS_PENDING:'Recupera o abandona la solicitud fiscal pendiente antes de editar otra secuencia.',
  FISCAL_SETTINGS_EVIDENCE_INVALID:'La respuesta de configuración fiscal no pasó la verificación. No se cambiaron las reservas locales.',
  FISCAL_SETTINGS_KIND_TRANSITION_REQUIRED:'Cambiar entre B01 y B02 requiere conciliar los rangos anteriores. No se reemplazó su cursor.',
  FISCAL_SETTINGS_ALLOCATED_RANGE_CONFLICT:'El rango termina antes de números ya asignados. No se pueden reutilizar.',
  FISCAL_SETTINGS_VERSION_CONFLICT:'La secuencia central cambió. Abandona el intento sin efectos y actualiza antes de editarla.',
  IMPORT_FILE_LIMIT:'El archivo supera 500 filas, 100 columnas u 8 MB. Divide el archivo y conserva sus códigos como texto.',
  IMPORT_EMPTY_FILE:'El archivo no contiene encabezados y productos.',
  IMPORT_FORMULA_UNSUPPORTED:'El archivo contiene fórmulas. Exporta valores fijos antes de importar.',
  IMPORT_DUPLICATE_MAPPING:'Cada campo debe usar una columna diferente.',
  IMPORT_CONTEXT_MISMATCH:'Esta importación corresponde a otra cuenta, actor o sucursal.',
  IMPORT_NOT_FOUND:'No se encontró el intento de importación en esta instalación.',
  CREDIT_OVERPAY:'El abono supera el saldo pendiente. Comprueba el importe.',
  CREDIT_BALANCE_PENDING:'No puedes borrar un cliente con deuda pendiente. Registra el pago primero.',
  CASH_PENDING:'Sincroniza los movimientos pendientes de esta sucursal antes de cerrar la caja.',
  CASH_UNVERIFIED:'Falta una base verificable de efectivo del turno. Sincroniza antes de registrar el movimiento o el arqueo.',
  PRINT_FAILED:'Windows no pudo abrir la impresión. La venta sigue guardada; revisa la solicitud antes de reimprimir.',
  ACCESS_LOGIN_REQUIRED:"Inicia sesión online para sincronizar. Las ventas locales siguen conservadas.",
  SALES_SCHEMA_INCOMPATIBLE:"La función de Staging no coincide con el esquema desplegado. Los datos y pendientes se conservan.",
  SALES_HEADER_PROOF_REQUIRED:"El servidor no pudo acreditar el encabezado original del comprobante. Se conserva el mismo documento; no se reemplazan sus datos por la configuración actual.",
  SALES_SETUP_REQUIRED:"El negocio QA aún necesita adopción autorizada por dueño/admin antes de preparar Ventas.",
  SALES_SOURCE_UNVERIFIABLE:"Los datos de origen no permiten una preparación segura. No se reconstruirán saldos ni stock.",
  SALES_SCOPE_CONFLICT:"El negocio QA se adoptó en otro ámbito. Usa la sucursal adoptada.",
  SALES_REMOTE_UNAVAILABLE:"Sin confirmación remota. Las ventas quedan guardadas y pendientes.",
  SALES_REMOTE_DENIED:"El servidor no autorizó la operación. Se conserva para revisión.",
  SALES_REMOTE_CONFLICT:"Hay un conflicto remoto. La venta permanece visible; no se repara automáticamente.",
  SALES_MIGRATION_REQUIRED:"Falta aplicar la migración de Ventas en Staging.",
  BACKUP_ARCHIVE_READ_ONLY: 'Esta copia es de sólo lectura. Vuelve a tu cuenta para operar.',
  SETTINGS_MIGRATION_REQUIRED:"Falta aplicar la migración de Ajustes y actualizar los datos de la cuenta.",
  HISTORY_SNAPSHOT_UNAVAILABLE:
    "Esta venta no tiene un ticket histórico verificable. No se reconstruirá con datos actuales.",
  HISTORY_SNAPSHOT_CORRUPT:
    "El ticket guardado no pasó la verificación. La venta se conserva sin corregir sus cifras.",
  TURN_REQUIRED: "Para cobrar efectivo necesitas un turno abierto.",
  RETURN_FISCAL_PENDING: "La devolución fiscal requiere nota de crédito; esta integración está pendiente.",
  PRO_REQUIRED: "Este módulo requiere nivel Pro confirmado por el permiso firmado.",
  SERVICE_STATE_INVALID: "Esta acción no corresponde al estado actual del equipo.",
  CONTACT_PHONE_INVALID:"Comprueba el teléfono del cliente antes de abrir WhatsApp.",
  CONTACT_OPEN_FAILED:"No se pudo abrir WhatsApp. Comprueba el navegador predeterminado de Windows.",
  WARRANTY_ORIGIN_UNKNOWN:"La garantía o su fecha original de venta no son verificables. No se reconstruyen datos históricos.",
  SERVICE_OVERPAY: "El pago supera el saldo o la cotización es menor que los abonos guardados.",
  SERVICE_REFUND_EXCESS: "El importe supera el depósito pendiente de devolver.",
  SERVICE_REFUND_DIVERGED: "Las devoluciones y el depósito no coinciden. Revisa la sincronización antes de continuar.",
  SERVICE_REFUND_UNVERIFIED: "No se encontró el depósito original verificable en esta instalación.",
  SERVICE_PART_UNSUPPORTED: "El producto no es compatible con esta operación.",
  SERVICE_SYNC_CONFLICT: "El servicio tiene una operación en conflicto. Revisa la sincronización antes de modificarla.",
  SERVICE_GUARANTEE_FREE: "El reingreso por garantía conserva cobro cero.",
  SERVICE_GUARANTEE_EXPIRED: "La reparación original no tiene una garantía vigente para este reingreso.",
  PRIVATE_VERSION_CONFLICT: "Cambió el dato privado del equipo. Reabre la ficha antes de guardarlo.",
  RETURN_CHANGED: "Cambió lo pendiente de devolver. Revisa las devoluciones guardadas de esta venta.",
  RETURN_QUANTITY_INVALID: "La cantidad supera lo pendiente o no es una unidad entera.",
  RETURN_NOTHING_REMAINING: "Selecciona artículos que todavía puedan devolverse.",
  RETURN_STOCK_AMBIGUOUS: "Las líneas tienen consumos distintos. Devuelve todas las unidades restantes de ese artículo.",
  RETURN_STOCK_FRACTIONAL: "La devolución produce stock fraccionario; selecciona una cantidad que reponga unidades enteras.",
  RETURN_SERIAL_INVALID: "Selecciona los seriales originales vendidos, uno por cada unidad a devolver.",
  RETURN_CREDIT_UNVERIFIED: "No se puede verificar el cargo original de fiado.",
  RETURN_PAID_CREDIT_PENDING: "El saldo actual no cubre el reintegro. Es necesario conciliar los pagos antes de devolver.",
  RETURN_BASIS_UNAVAILABLE: "Faltan datos históricos verificables para calcular esta devolución.",
  EXPORT_TOO_LARGE: "El reporte supera 10,000 filas. Selecciona un período más corto; no se exporta una lista truncada.",
  TURN_CHANGED: "El turno cambió o está cerrado. El cobro no se confirmó.",
  STOCK_UNVERIFIED: "No hay stock operativo verificable para esta venta.",
  SERIAL_CONFLICT:
    "Selecciona un serial disponible y vende una sola unidad por serial.",
  CREDIT_LIMIT: "El fiado supera el límite de crédito del cliente.",
  LEGACY_NOT_VERIFIABLE:
    "Los datos del cliente o la configuración necesaria no son verificables.",
  FISCAL_UNKNOWN:
    "No hay un rango fiscal autorizado disponible para esta instalación.",
  FISCAL_EXHAUSTED:
    "El rango fiscal local se agotó. No se inventará un comprobante.",
  CATALOGUE_READ_ONLY:
    "Esta captura sólo permite consultar. Cobro y cambios de inventario todavía no están habilitados.",
  QA_NATIVE_REQUIRED:
    "Abre la aplicación Tauri para acceder a los datos nativos.",
  QA_NATIVE_UNAVAILABLE:
    "El adaptador nativo no está habilitado en esta compilación.",
  QA_AMOUNT_INVALID:
    "Introduce un importe válido con un máximo de dos decimales.",
  KEY_MISSING:
    "No se encontró la clave de este vault. No se creó una base nueva.",
  KEY_TEMPORARILY_UNAVAILABLE:
    "La clave está temporalmente bloqueada. Desbloquea Windows y vuelve a revisar.",
  KEY_INVALIDATED:
    "La clave necesita recuperación. Tus archivos se conservaron.",
  STOCK_UNAVAILABLE: "La cantidad supera la disponibilidad local verificada.",
  VERSION_CONFLICT:
    "Los datos o el turno cambiaron. Conserva el intento y revísalo.",
  PRODUCT_CODE_EXISTS:
    "Ya existe otro producto con ese código. Usa un código único.",
  PRODUCT_TYPE_REQUIRED: "Esta captura no incluye el tipo del producto. Selecciona Venta, Insumo o Combo antes de guardar.",
  PRODUCT_LOCATION_REQUIRED: "Esta captura no incluye la ubicación. Declara una ubicación o marca Sin ubicación asignada.",
  PRODUCT_NOT_SELLABLE: "Este producto es un insumo. Se consume mediante su receta.",
  PRODUCT_TYPE_IN_USE: "El producto tiene stock, seriales o recetas que impiden cambiar su tipo.",
  PRODUCT_RECIPE_IN_USE: "El producto forma parte de un combo activo. Revisa la receta antes de eliminarlo.",
  RECIPE_COST_INVALID: "El costo de los ingredientes debe producir centavos exactos. Revisa las cantidades de la receta.",
  RECIPE_INVALID: "La receta requiere insumos activos, cantidades exactas y ningún combo anidado.",
  SERIAL_REQUIRED: "Registra una serie única por unidad. El ajuste de productos con seriales necesita selección individual.",
  SERIAL_UNAVAILABLE: "Una serie está repetida o ya registrada en el negocio.",
  SERIAL_INVENTORY_DIVERGED: "El stock y las series disponibles no coinciden. Sincroniza y revisa las unidades antes de ajustar.",
  OPERATION_ALREADY_APPLIED: "El intento ya tiene efectos. Recupera su resultado; no puede descartarse.",
  OPERATION_ID_CONFLICT:
    "La identidad del intento no coincide con su contenido original.",
  CONTRACT_INVALID:
    "El núcleo rechazó los datos de la operación. No se confirmó la venta.",
  LOCAL_STORAGE_IO:
    "No fue posible confirmar la escritura local. Conserva el intento para recuperarlo.",
};
async function readOnly(): Promise<never> {
  throw { code: "CATALOGUE_READ_ONLY" };
}
export const nativePreviewPort: PosPort = {
  historyRead: historyPort.read,
  ticket: historyPort.ticket,
  async load() {
    const value = await cataloguePort.read();
    if (!value) throw { code: "CATALOGUE_INCOMPLETE" };
    const carts = await accountDraftPort.read();
    return {
      status: "ready",
      mode: "staging-readonly",
      supportsDrafts: true,
      preview: {
        asOf: value.manifest.capturedAtMs,
        scope:
          value.manifest.context.scopeType === "BRANCH"
            ? `Sucursal ${value.manifest.context.branchId}`
            : "Global",
        snapshotId: value.manifest.snapshotId,
      },
      products: value.products.map((p) => ({
        id: p.id,
        name: p.name,
        code: p.code ?? "",
        priceCents: p.priceCents ?? "",
        stock: p.stock ?? "",
        revision: value.manifest.snapshotId,
        preview: {
          priceVerifiable: p.priceCents !== null,
          stockVerifiable: p.stock !== null,
          stockEvidence: p.stockEvidence,
        },
      })),
      confirmedSales: "",
      cashCents: "",
      pendingOperations: "",
      lastResult: null,
      pendingAttempt: null,
      carts,
    };
  },
  createTestDataset: readOnly,
  quote: (lines) => accountDraftPort.quote(lines),
  confirm: readOnly,
  result: readOnly,
  saveProduct: readOnly,
  adjustStock: readOnly,
  saveCart: accountDraftPort.save,
  cartAction: accountDraftPort.action,
  readCash: cashPort.read,
};
export const nativeOperationalPort:PosPort={
 printTicket:salesAccountPort.print,
 photos:salesAccountPort.photos,
 management:nativeManagementPort,
 ...nativePreviewPort,
 async load(){const value=await salesAccountPort.read();if(!value)throw{code:"COMMERCIAL_BOOTSTRAP_REQUIRED"};return value;},
 quote:(lines,_tender,options)=>{if(!options)throw{code:"CONTRACT_INVALID"};return salesAccountPort.quote(lines,options);},
 confirm:salesAccountPort.confirm,result:salesAccountPort.result,abandon:salesAccountPort.abandon,
 synchronize:salesAccountPort.synchronize,openTurn:salesAccountPort.openTurn,retry:salesAccountPort.retry,
};
export function posError(error: unknown): string {
  const code = qaError(error);
  return (
    errors[code] ??
    `No se pudo completar la operación (${code}). Los datos se conservaron.`
  );
}
export interface PosTicket {autoPrintJob?:{attemptId:string;state:string};actorName?:string|null;
  printTarget?:import("./management").PrinterProfile;printLayout?:import("./management").PrintLayout;
  printAttempt?:{attemptId:string;state:string};
  printSnapshotHash?: string;
  business?:import("./management").BusinessHeader;
  version: string;
  operationId: string;
  ticket: string;
  ncf: string | null;
  originAtUtcMs: string;
  customerName: string | null;
  sale: {
    lines: {
      name: string;
      quantity: { numerator: string; denominator: string };
      unitPriceCents: string;
      serial: string | null;
    }[];
    totals: {
      subtotalCents: string;
      discountCents: string;
      itbisCents: string;
      totalCents: string;
    };
    payment: {
      tenderCents?: string;
      method: string;
      changeCents: string;
      paidCents: string;
      creditChargeCents: string;
    };
  };
}
export interface PosHistoryFilter {
  search: string;
  method: string | null;
  fromMs: string | null;
  toMs: string | null;
  page: number;
}
export interface PosHistoryRow {
  operationId: string;
  ticket: string;
  dateMs: string | null;
  method: string | null;
  totalCents: string;
  itbisCents: string;
  discountCents: string;
  ncf: string | null;
  customerName: string | null;
  ticketEvidence:
    "VERIFIED_SNAPSHOT" | "UNAVAILABLE_LEGACY" | "CORRUPT_SNAPSHOT";
  remoteStatus: "UNVERIFIED"|"APPLIED";
}
export interface PosHistoryPage {
  rows: PosHistoryRow[];
  total: string;
  page: number;
  pageSize: number;
  scope: string;
  branchId: string | null;
  coverage: "LOCAL_NATIVE_ONLY";
}
