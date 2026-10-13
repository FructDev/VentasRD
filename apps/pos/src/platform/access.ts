import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  PosCartWorkspace,
  PosCartSave,
  PosCartAction,
  PosCartResult,
  PosLine,
  PosQuote,
  PosCashView,
  PosHistoryFilter,
  PosHistoryPage,
  PosTicket,
  PosSnapshot,PosOptions,PosSale,PosResult,
} from "./pos-adapter";
export interface AccessBranch {
  id: string;
  name: string;
}
export interface AccessTenant {
  id: string;
  name: string;
  branches: AccessBranch[];
}
export interface AccessView {
  status:
    | "NOT_CONFIGURED"
    | "LOGIN_REQUIRED"
    | "AUTHENTICATED"
    | "LOCKED"
    | "PIN_ENROLLMENT_REQUIRED"
    | "PREPARATION_REQUIRED";
  configured: boolean;
  actorId: string | null;
  tenantId: string | null;
  role: string | null;
  pinEnrolled: boolean;
  tenants: AccessTenant[];
  catalogueReady: boolean;
  operationalReady?:boolean;
}
export interface CataloguePreview {
  manifest: {
    snapshotId: string;
    capturedAtMs: string;
    coverage: "CATALOGUE_PREVIEW_V1";
    watermark: null;
    context: { scopeType: "GLOBAL" | "BRANCH"; branchId: string | null };
  };
  products: {
    id: string;
    name: string;
    code: string | null;
    priceCents: string | null;
    stock: string | null;
    stockEvidence: string;
  }[];
}
export interface CatalogueDownload {
  complete: boolean;
  received: number;
  total: number;
  view: AccessView;
}
type Command =
  | "native_access_status"
  | "native_access_login"
  | "native_access_provision"
  | "native_access_pin"
  | "native_access_lock"
  | "native_catalogue_download"
  | "native_catalogue_read"
  | "native_cart_read"
  | "native_cart_save"
  | "native_cart_action"
  | "native_catalogue_quote"
  | "native_cash_read"
  | "native_history_read"
  | "native_history_ticket"
  | "native_fiscal_read"
  | "native_fiscal_prepare"
  | "native_sales";
async function call<T = AccessView>(
  command: Command,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!isTauri()) throw { code: "ACCESS_NATIVE_REQUIRED" };
  return invoke(command, {
    ...args,
    ipcVersion: "ventard.native.access.1",
    requestId: crypto.randomUUID(),
  });
}
export const accessPort = {
  status: () => call("native_access_status"),
  login: (email: string, password: string) =>
    call("native_access_login", { email, password }),
  provision: (tenantId: string, branchId: string | null) =>
    call("native_access_provision", { tenantId, branchId }),
  pin: (pin: string, enroll: boolean) =>
    call("native_access_pin", { pin, enroll }),
  lock: () => call("native_access_lock"),
};
export const cataloguePort = {
  step: () => call<CatalogueDownload>("native_catalogue_download"),
  read: () => call<CataloguePreview | null>("native_catalogue_read"),
};
export const accountDraftPort = {
  read: () => call<PosCartWorkspace>("native_cart_read"),
  save: (cart: PosCartSave) =>
    call<PosCartResult>("native_cart_save", { cart }),
  action: (cart: PosCartAction) =>
    call<PosCartResult>("native_cart_action", { cart }),
  quote: (lines: PosLine[]) =>
    call<PosQuote>("native_catalogue_quote", { lines }),
};
export const cashPort = { read: () => call<PosCashView>("native_cash_read") };
export const salesAccountPort={
 print:(operationId:string,snapshotHash:string,attemptId:string)=>call<{status:string;submitted?:boolean}>('native_sales',{command:{action:'PRINT',operationId,snapshotHash,attemptId}}),
 read:()=>call<PosSnapshot|null>("native_sales",{command:{action:"READ"}}),
 bootstrap:()=>call<PosSnapshot>("native_sales",{command:{action:"BOOTSTRAP"}}),
 activate:(confirmation:string,freeTax:string)=>call<PosSnapshot>("native_sales",{command:{action:"ACTIVATE",confirmation,freeTax}}),
 synchronize:()=>call<PosSnapshot>("native_sales",{command:{action:"SYNCHRONIZE"}}),
 retry:(operationId:string)=>call<PosSnapshot>("native_sales",{command:{action:"RETRY",operationId}}),
 quote:(lines:PosLine[],options:PosOptions)=>call<PosQuote>("native_sales",{command:{action:"QUOTE",lines,options}}),
 confirm:(sale:PosSale)=>{
  if(!sale.cartId||!sale.expectedCartRevision||!sale.options||!sale.acceptedQuoteHash)throw{code:"CONTRACT_INVALID"};
  const request={operationId:sale.operationId,cartId:sale.cartId,expectedCartRevision:sale.expectedCartRevision,acceptedQuoteHash:sale.acceptedQuoteHash,lines:sale.lines,options:sale.options,fiscalType:sale.fiscalType??null};
  return call<PosResult>("native_sales",{command:{action:"CONFIRM",sale:request}});
 },
 result:(operationId:string)=>call<PosResult|null>("native_sales",{command:{action:"RESULT",operationId}}),
 abandon:(operationId:string)=>call<void>("native_sales",{command:{action:"ABANDON",operationId}}),
 openTurn:async(operationId:string,openingCents:string,denominations?:import("./management").Denomination[])=>{await call("native_sales",{command:{action:"OPEN_TURN",operationId,openingCents,...(denominations?{denominations}:{})}});await salesAccountPort.synchronize();return cashPort.read();},
};
export const historyPort = {
/* Saved immutable history, separate from mutable customer metadata. */
  read: (filter: PosHistoryFilter) =>
    call<PosHistoryPage>("native_history_read", { filter }),
  ticket: (operationId: string) =>
    call<PosTicket>("native_history_ticket", { operationId }),
};
export const managementAccountPort = {
 settingsRead:()=>call<import('./management').BusinessSettingsView>('native_sales',{command:{action:'SETTINGS_READ'}}),
 settingsLoadRemote:()=>call<import('./management').BusinessSettingsView>('native_sales',{command:{action:'SETTINGS_LOAD_REMOTE'}}),
 repairPrivateRead:(repairId:string)=>call<import('./management').RepairPrivateView>('native_sales',{command:{action:'REPAIR_PRIVATE_READ',repairId}}),
 repairTicket:(operationId:string)=>call<import('./management').RepairTicket>('native_sales',{command:{action:'REPAIR_TICKET',operationId}}),
 printRepair:(operationId:string,snapshotHash:string,attemptId:string)=>call<{status:string;submitted?:boolean}>('native_sales',{command:{action:'PRINT_REPAIR',operationId,snapshotHash,attemptId}}),
 contactNotice:(family:'REPAIR'|'LAYAWAY'|'CREDIT',id:string)=>call<{status:'DRAFT_REQUESTED'}>('native_sales',{command:{action:'CONTACT_NOTICE',family,id}}),
 printLayoutRead:()=>call<{layout:import('./management').PrintLayout;canWrite:boolean;coverage:string}>('native_sales',{command:{action:'PRINT_LAYOUT_READ'}}),
 printLayoutSave:(layout:import('./management').PrintLayout)=>call<import('./management').PrintLayout>('native_sales',{command:{action:'PRINT_LAYOUT_SAVE',layout}}),
 warrantiesRead:()=>call<import('./management').WarrantiesView>('native_sales',{command:{action:'WARRANTIES_READ'}}),
 warrantyTicket:(operationId:string)=>call<import('./management').WarrantyTicket>('native_sales',{command:{action:'WARRANTY_TICKET',operationId}}),
 layawaysRead:()=>call<import('./management').LayawaysView>('native_sales',{command:{action:'LAYAWAYS_READ'}}),
 layawayTicket:(operationId:string)=>call<import('./management').LayawayTicket>('native_sales',{command:{action:'LAYAWAY_TICKET',operationId}}),
 repairsRead:()=>call<import('./management').RepairsView>('native_sales',{command:{action:'REPAIRS_READ'}}),
 reportExport:(kind:import('./management').ExportKind,fromMs:string,toMs:string)=>call<import('./management').ReportBundle>('native_sales',{command:{action:'REPORT_EXPORT',kind,fromMs,toMs}}),
 returnRead:(saleId:string)=>call<import('./management').ReturnView>('native_sales',{command:{action:'RETURN_READ',saleId}}),
 returnPreview:(saleId:string,items:import('./management').ReturnItem[],serials:string[])=>call<import('./management').ReturnPreview>('native_sales',{command:{action:'RETURN_PREVIEW',saleId,items,serials}}),
 cutTicket:(operationId:string)=>call<import('./management').CutTicket>('native_sales',{command:{action:'CUT_TICKET',operationId}}),
 printCut:(operationId:string,snapshotHash:string,attemptId:string)=>call<{status:string;submitted?:boolean}>('native_sales',{command:{action:'PRINT_CUT',operationId,snapshotHash,attemptId}}),
 abandon: (operationId:string)=>call('native_sales',{command:{action:'MANAGEMENT_ABANDON',operationId}}),
 inventoryHistory:(productId:string,page:number)=>call<import('./management').InventoryHistory>('native_sales',{command:{action:'INVENTORY_HISTORY',productId,page}}),
 read: () => call<import('./management').ManagementView>('native_sales', {command:{action:'MANAGEMENT_READ'}}),
 execute: (request: import('./management').ManagementCommand,privateChange?:import('./management').RepairPrivateChange) => call<import('./management').ManagementResult>('native_sales', {command:{action:'MANAGEMENT_EXECUTE',request,private:privateChange}}),
 report: (fromMs:string,toMs:string) => call<import('./management').ManagementReport>('native_sales', {command:{action:'REPORT',fromMs,toMs}}),
};
export interface FiscalView {
  pending: ("B01" | "B02")[];
  availableB01: string;
  availableB02: string;
  lastStatus: "ALLOCATED" | "NO_BLOCK" | null;
  lastReason: string | null;
}
export const fiscalPort = {
  read: () => call<FiscalView>("native_fiscal_read"),
  prepare: (kind: "B01" | "B02") =>
    call<FiscalView>("native_fiscal_prepare", { kind }),
};
const messages: Record<string, string> = {
  SALES_PAYMENT_CONTEXT_INVALID:"El servidor rechazó el contexto de pago/turno. La venta se conserva con el mismo ID; revisa la causa antes de reintentar.",
  SALES_SETUP_REQUIRED:"La cuenta inició sesión, pero este negocio QA aún no está adoptado para Ventas nativas. El dueño/admin debe usar «Adoptar negocio sintético» después de detener los clientes antiguos de Staging.",
  SALES_SCOPE_CONFLICT:"El negocio QA ya se adoptó en otro ámbito. Usa la misma sucursal; no se cambiará ni reparará stock automáticamente.",
  SALES_SOURCE_UNVERIFIABLE:"Los datos de origen de Staging no permiten una preparación segura. Hay que revisar el dato incompatible; no se inventarán saldos, precios ni historia.",
  SALES_SCHEMA_INCOMPATIBLE:"La función de Staging no coincide con el esquema desplegado. Se conservan los datos; hace falta corregir la compatibilidad del servidor.",
  SALES_MIGRATION_REQUIRED:"El servidor Staging todavía no tiene la migración de Ventas. No se usará producción.",
  SALES_REMOTE_DENIED:"El servidor no autorizó esta cuenta o instalación. El trabajo local se conserva.",
  SALES_REMOTE_CONFLICT:"El servidor rechazó la operación o su preparación. Se conserva para revisión, sin repetir efectos.",
  SALES_REMOTE_UNAVAILABLE:"Sin confirmación del servidor. La venta local y su intento se conservan; vuelve a sincronizar.",
  SALES_EVIDENCE_INVALID:"La evidencia remota no coincide. No se confirmará sincronización.",
  ACCESS_NOT_CONFIGURED:
    "La conexión de desarrollo aún no está configurada. No se intentará usar producción.",
  ACCESS_NATIVE_REQUIRED: "Abre esta pantalla en VentaRD nativo.",
  ACCESS_CREDENTIALS_INVALID: "Correo o contraseña incorrectos.",
  ACCESS_EMAIL_UNCONFIRMED:
    "Confirma el correo de tu cuenta antes de iniciar sesión.",
  ACCESS_NETWORK_UNAVAILABLE:
    "No se pudo conectar. Si esta instalación ya está preparada, desbloquéala con tu PIN.",
  ACCESS_ISSUER_UNAVAILABLE:
    "El servicio de preparación no está disponible. No se ha habilitado el cobro.",
  ACCESS_LOGIN_REQUIRED: "Inicia sesión online para preparar esta instalación.",
  ACCESS_TENANT_DENIED:
    "La cuenta no tiene acceso a un negocio de staging autorizado.",
  ACCESS_PROVISION_UNAVAILABLE:
    "No se pudo verificar el registro. Puedes reintentar sin crear otra instalación.",
  ACCESS_OWNER_SETUP_REQUIRED:
    "Este equipo es nuevo. Un dueño o administrador debe prepararlo primero; después podrás iniciar sesión con tu cuenta de vendedor. Usa «Usar otra cuenta» sin borrar la instalación.",
  ACCESS_INSTALLATION_SCOPE_LOCKED:
    "Esta instalación ya está vinculada a otro ámbito; no se cambia automáticamente.",
  ACCESS_KEY_UNAVAILABLE:
    "No se pudo recuperar la clave local. Los datos no se borrarán.",
  PIN_INVALID: "PIN incorrecto.",
  PIN_RATE_LIMITED:
    "Demasiados intentos. Espera al menos 30 segundos e inténtalo nuevamente.",
  PIN_ALREADY_ENROLLED:
    "Esta cuenta ya tiene PIN. Desbloquea con el PIN existente.",
  ACCESS_RATE_LIMITED:
    "Demasiados intentos de acceso. Espera e inténtalo de nuevo.",
};
Object.assign(messages, {
  CATALOGUE_MIGRATION_REQUIRED:
    "La función de catálogo aún no está disponible en Staging. No se cambiarán los datos locales.",
  CATALOGUE_REMOTE_DENIED:
    "No se autorizó la captura para esta cuenta e instalación.",
  CATALOGUE_REMOTE_UNAVAILABLE:
    "No se pudo completar la captura remota. La copia anterior se conserva; puedes reanudar.",
  CATALOGUE_EVIDENCE_INVALID:
    "La captura no pasó la verificación de ámbito, contenido o hash. No se sustituyó el catálogo anterior.",
  CATALOGUE_CAPTURE_EXPIRED:
    "La captura caducó. Conecta y descarga una captura nueva.",
  CATALOGUE_CLOCK_SKEW:
    "La hora de la PC está más de 5 segundos detrás de la captura. Comprueba la fecha y hora de Windows y vuelve a descargar. Tus datos se conservan.",
  ACCESS_PIN_REQUIRED:
    "Desbloquea la instalación con tu PIN antes de consultar el catálogo.",
  ACCESS_READ_DENIED: "El permiso local no permite consultar estos datos.",
});
Object.assign(messages, {
  FISCAL_MIGRATION_REQUIRED:
    "La reserva fiscal v2 aún no está instalada en Staging. La solicitud pendiente se conserva.",
  FISCAL_REMOTE_DENIED:
    "El servidor no autorizó esta reserva para la cuenta e instalación. No se asignan números localmente.",
  FISCAL_REMOTE_CONFLICT:
    "El servidor rechazó la identidad, contenido o contexto de la solicitud. La reserva permanece visible para revisión.",
  FISCAL_REMOTE_UNAVAILABLE:
    "No se pudo confirmar la reserva fiscal. Se conserva el mismo ID; recupera la solicitud cuando haya conexión.",
  FISCAL_EVIDENCE_INVALID:
    "El recibo fiscal no pasó la verificación. No se consumirá un bloque nuevo ni se habilitarán cobros.",
});
export function accessMessage(e: unknown) {
  const code =
    typeof e === "object" && e !== null && "code" in e ? String(e.code) : "";
  return (
    messages[code] ??
    "No se pudo completar el acceso de forma verificable. No se han borrado datos ni habilitado cobros."
  );
}
