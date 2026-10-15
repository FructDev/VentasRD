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
  presentation?:{tenantId:string;actorId:string;actorName:string|null;businessName:string|null;logo:string|null;color:string|null;font:string|null;capturedAtMs:string}|null;
  status:
    | "NOT_CONFIGURED"
    | "LOGIN_REQUIRED"
    | "AUTHENTICATED"
    | "LOCKED"
    | "PIN_ENROLLMENT_REQUIRED"
    | "PREPARATION_REQUIRED" | "RECOVERY_ARCHIVE";
  // Recovery archives are read-only data sources, never operational grants.
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
  | "native_sales" | "native_backup";
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
 historyLoadRemote:()=>call<{coverage:string;count:string;watermark:string;capturedAtMs:string}>('native_sales',{command:{action:'HISTORY_LOAD_REMOTE'}}),
 photos:(productIds:string[])=>call<{rows:{id:string;version:string;data:string}[]}>('native_sales',{command:{action:'PRODUCT_PHOTOS',productIds}}),
 print:(operationId:string,snapshotHash:string,attemptId:string,raster?:import("./management").PrintRaster)=>call<{status:string;submitted?:boolean}>('native_sales',{command:{action:'PRINT',operationId,snapshotHash,attemptId,...(raster?{raster}:{})}}),
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
 customerActivity:(customerId:string)=>call<import('./management').CustomerActivity>('native_sales',{command:{action:'CUSTOMER_ACTIVITY',customerId}}),
 teamShare:(operationId:string)=>call<{status:string}>('native_sales',{command:{action:'TEAM_SHARE',operationId}}),
 teamRead:()=>call<import('./management').TeamView>('native_sales',{command:{action:'TEAM_READ'}}),
 teamExecute:(input:import('./management').TeamInput)=>call<import('./management').TeamReceipt>('native_sales',{command:{action:'TEAM_EXECUTE',input}}),
 teamRecover:(cancel:boolean)=>call<import('./management').TeamReceipt>('native_sales',{command:{action:'TEAM_RECOVER',cancel}}),
 catalogueRead:()=>call<import('./management').CatalogueView>('native_sales',{command:{action:'CATALOGUE_READ'}}),
 catalogueOpen:(share:boolean)=>call<{status:string}>('native_sales',{command:{action:'CATALOGUE_OPEN',share}}),
 settingsRead:()=>call<import('./management').BusinessSettingsView>('native_sales',{command:{action:'SETTINGS_READ'}}),
 settingsLoadRemote:()=>call<import('./management').BusinessSettingsView>('native_sales',{command:{action:'SETTINGS_LOAD_REMOTE'}}),
 repairPrivateRead:(repairId:string)=>call<import('./management').RepairPrivateView>('native_sales',{command:{action:'REPAIR_PRIVATE_READ',repairId}}),
 repairTicket:(operationId:string)=>call<import('./management').RepairTicket>('native_sales',{command:{action:'REPAIR_TICKET',operationId}}),
 printRepair:(operationId:string,snapshotHash:string,attemptId:string,raster?:import("./management").PrintRaster)=>call<{status:string;submitted?:boolean}>('native_sales',{command:{action:'PRINT_REPAIR',operationId,snapshotHash,attemptId,...(raster?{raster}:{})}}),
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
 printCut:(operationId:string,snapshotHash:string,attemptId:string,raster?:import("./management").PrintRaster)=>call<{status:string;submitted?:boolean}>('native_sales',{command:{action:'PRINT_CUT',operationId,snapshotHash,attemptId,...(raster?{raster}:{})}}),
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
  HISTORY_MIGRATION_REQUIRED:'El servidor todavía necesita habilitar la descarga del historial nativo. Tus ventas guardadas se conservan.',
  HISTORY_SYNC_REQUIRED:'Primero hay que resolver los pendientes y completar la sincronización. La historia se conserva sin repetir ventas.',
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
  LOGIN_REQUIRED: "Inicia sesión online para continuar el traslado. El PIN desbloquea los datos locales; las copias y los intentos se conservan.",
  REMOTE_DENIED: "La cuenta no tiene permiso para leer o continuar este traslado. Revisa el negocio y los permisos; las copias se conservan.",
  NETWORK_UNAVAILABLE: "No se pudo confirmar la respuesta de la nube. Conserva el mismo intento y vuelve a continuar cuando haya conexión.",
  TABLE_UNAVAILABLE: "Una tabla del historial no está disponible en la nube. No se consideró vacía; las copias anteriores se conservan.",
  ACCESS_TENANT_DENIED:
    "La cuenta no tiene acceso a un negocio de staging autorizado.",
  ACCESS_PROVISION_UNAVAILABLE:
    "No se pudo verificar el registro. Puedes reintentar sin crear otra instalación.",
  ACCESS_OWNER_SETUP_REQUIRED:
    "Este equipo es nuevo. Un dueño o administrador debe prepararlo primero; después podrás iniciar sesión con tu cuenta de vendedor. Usa «Usar otra cuenta» sin borrar la instalación.",
  ACCESS_INSTALLATION_SCOPE_LOCKED:
    "Esta instalación ya está vinculada a otro ámbito; no se cambia automáticamente.",
  TRANSITION_INVALID:'Los datos de la transición no pudieron verificarse. Se conservó el estado anterior.',
  TRANSITION_CONTEXT:'Cambió la cuenta o el equipo. Regresa al contexto del informe para continuar.',
  TRANSITION_STORAGE:'No se pudo guardar el informe. Actualiza para recuperar el resultado anterior.',
  TRANSITION_SOURCE_CONFLICT:'La fuente o la identidad del informe cambió. No se sustituyeron los datos conservados.',
  TRANSITION_TOO_LARGE:'La captura admite 32 MB y 200.000 filas; la combinación, hasta 600.000 filas de fuentes. Se superó un límite y no se omitieron datos silenciosamente.',
  CUTOVER_BACKUP_REQUIRED:'Crea y verifica un respaldo nuevo después de incorporar esta conciliación. El respaldo anterior no contiene exactamente sus decisiones.',
  CUTOVER_REVIEW_REQUIRED:'Publica la historia y resuelve las observaciones antes de activar el negocio.',
  CUTOVER_CLOUD_REQUIRED:'Falta la captura completa de nube para el corte operativo.',
  CUTOVER_COPIES_NOT_CONVERGED:'Hay datos elegidos que todavía difieren de la nube. Completa su conciliación; no se volverán a enviar ventas antiguas automáticamente.',
  CUTOVER_SOURCE_CHANGED:'La nube cambió después de la captura. Captura y concilia de nuevo antes de hacer el corte.',
  CUTOVER_CLOSE_WEB_CASH:'Cierra la caja en la versión web y captura su estado final antes del corte. Se conserva su historia y arqueo.',
  CUTOVER_CASH_HISTORY_CONFIRMATION_REQUIRED:'Revisa y confirma la conservación histórica de las ventas antiguas sin caja. Sus cobros no se repetirán ni se reconstruirá una caja.',
  CASH_LINK_UNKNOWN:'Hay un movimiento histórico en efectivo sin caja identificada. Se conserva para consulta; concilia esa referencia antes del corte. No se asignará por fecha ni se repetirá el cobro.',
  CUTOVER_SERVICE_CAPTURE_TOO_LARGE:'Los servicios activos superan 512 KiB de incorporación operativa. El corte no se aplicó; conserva la copia para revisión.',
  CUTOVER_SERVICE_BASELINE_CONFLICT:'Un servicio ya tiene una base o movimientos nativos diferentes. Se conserva y requiere revisión antes de otro corte.',
  CUTOVER_SERVICE_RESERVATIONS_REQUIRED:'Confirma los abonos anteriores y las reservas físicas de reparaciones y apartados antes del corte.',
  CUTOVER_SERVICE_REQUIRES_RECONCILIATION:'Hay reparaciones o apartados activos sin incorporación operativa verificada. Se conservan; su continuación todavía requiere conciliación.',
  CUTOVER_CREDIT_UNVERIFIABLE:'La deuda contiene importes o referencias que impiden adoptar un saldo seguro.',
  CUTOVER_ACTIVE_BALANCE_CONFLICT:'El saldo nativo existente difiere de la historia web. No se reemplazó el saldo ni el trabajo posterior.',
  CUTOVER_ACTIVE_SCOPE_CONFLICT:'Este negocio ya tiene otro ámbito o ITBIS operativo. Usa su configuración vigente; no se cambió el ámbito existente.',
  CUTOVER_SOURCE_CONFLICT:'La fuente guardada no coincide con su huella. Conserva las copias y revisa el origen antes de activar.',
  CUTOVER_STORAGE:'La operación no pudo confirmarse en el almacenamiento local. Recupera el mismo intento.',
  CUTOVER_INVALID:'Los datos del corte no cumplen el contrato esperado. No se activaron efectos a partir de esos datos.',
  CUTOVER_ID_CONFLICT:'El intento de corte ya tiene datos distintos. Recupera el intento guardado.',
  CUTOVER_CONTEXT:'La cuenta, instalación o permiso cambió. El intento original se conserva.',
  CUTOVER_RECEIPT_INVALID:'La respuesta no demuestra este corte exacto; el intento sigue pendiente.',
  CUTOVER_BOOTSTRAP_REQUIRED:'El corte remoto está conservado; falta terminar la descarga operativa. Recupera el mismo intento.',
  SALES_SYNC_INCOMPLETE:'La recepción aún no alcanzó la última operación. Vuelve a recuperar o sincronizar; el avance se conserva.',
  TRANSITION_REVISION:'El informe cambió o ya se incorporó. Actualiza antes de elegir otra versión.',
  TRANSITION_REVIEW_REQUIRED:'Resuelve las versiones en conflicto antes de incorporar el historial.',
  TRANSITION_DOCUMENT_REQUIRED:'Esta fila pertenece a una venta con versiones diferentes. Elige la venta completa desde la tabla ventas.',
  TRANSITION_DOCUMENT_OWNERSHIP:'Una identidad de efecto aparece vinculada a ventas o negocios distintos. Se conservó todo y requiere revisar esa identidad antes de elegir.',
  TRANSITION_HISTORY_EXISTS:'El nuevo informe debe conservar las fuentes y datos del historial ya incorporado.',
  TRANSITION_MONEY_OVERFLOW:'La suma supera el rango de dinero permitido. Requiere revisar los importes.',
  MIGRATION_REQUIRED:'La captura completa requiere habilitar su migración en Staging. Las copias recibidas se conservaron.',
  WEB_RECONCILE_INVALID:'La observación no pudo verificarse. La copia y los resultados anteriores se conservan.',
  WEB_RECONCILE_PENDING:'Esta copia ya tiene una lectura pendiente. Continúa el mismo informe para conservar su progreso.',
  WEB_RECONCILE_CONTEXT:'Cambió la cuenta, la caja o el equipo. Vuelve a la cuenta del informe para continuar.',
  WEB_RECONCILE_STORAGE:'No se pudo guardar el resultado. Consulta el mismo informe para recuperar su progreso.',
  WEB_RECONCILE_ID_CONFLICT:'Esta identidad de informe corresponde a otra copia. No se sobrescribió.',
  WEB_RECONCILE_BATCH_CHANGED:'El lote ya cambió. Actualiza el informe y continúa desde su progreso guardado.',
  WEB_RECONCILE_OBSERVATION_CONFLICT:'Ese lote ya tiene otra observación guardada. Se conservó la primera; actualiza el informe.',
  WEB_RECONCILE_TOO_LARGE:'La observación supera el tamaño admitido. La copia se conserva y requiere revisión.',
  WEB_IMPORT_INVALID:'El archivo del navegador está incompleto o usa un formato incompatible. Los datos activos se conservaron.',
  WEB_IMPORT_KEY_INVALID:'La llave no corresponde al archivo o éste fue modificado. Los datos activos se conservaron.',
  WEB_IMPORT_IO:'No se pudo leer el archivo o su llave. Comprueba que ambos estén disponibles en este equipo.',
  WEB_IMPORT_TOO_LARGE:'Este traslado supera el límite de 32 MB; requiere preparar una copia de mayor tamaño.',
  WEB_IMPORT_STORAGE:'No se pudo guardar la copia. El mismo archivo puede recibirse de nuevo sin repetir ventas.',
  WEB_IMPORT_TENANT_MISMATCH:'La copia pertenece a otro negocio. Selecciona su cuenta antes de recibirla.',
  WEB_IMPORT_CONTEXT_CHANGED:'Cambió la cuenta durante la recepción. Vuelve a elegir el archivo desde la cuenta correcta.',
  WEB_IMPORT_ID_CONFLICT:'Ya se recibió una copia diferente con esta identidad. Se conservó la copia anterior.',
  BACKUP_JOB_ABANDONED:'Este intento fue descartado. Sus archivos se conservan; inicia un respaldo nuevo.',
  BACKUP_ALREADY_VERIFIED:'Este respaldo ya está verificado. Puedes comprobarlo de nuevo sin cambiar su identidad.',
  BACKUP_IO:'No se pudo completar el archivo. Conserva el intento y verifica el espacio o la unidad.',
  BACKUP_INVALID:'El respaldo está incompleto o fue modificado. Los datos activos se conservaron.',
  BACKUP_DATABASE_INVALID:'No se pudo verificar la base cifrada del respaldo.',
  BACKUP_SCHEMA_UNSUPPORTED:'Esta copia requiere una versión compatible de VentaRD.',
  BACKUP_KEY_INVALID:'La llave no corresponde al respaldo o sus datos fueron modificados.',
  BACKUP_FILE_EXISTS:'El destino contiene otro archivo. No se sobrescribió; elige otra ubicación para un respaldo nuevo.',
  BACKUP_SEPARATE_KEY_REQUIRED:'Guarda la llave en una carpeta o unidad diferente del respaldo.',
  BACKUP_DESTINATION_INVALID:'Elige una ubicación externa a los datos internos de VentaRD.',
  BACKUP_SOURCE_CHANGED:'Cambió la copia temporal verificada. Se conserva el intento anterior.',
  BACKUP_ORIGINAL_DEVICE_REQUIRED:'Esta copia puede consultarse, pero no acredita que éste sea el Windows original. Preparar otro equipo requiere una identidad nueva; no se clonó la instalación.',
  BACKUP_CONTEXT_MISMATCH:'La copia pertenece a otra identidad de negocio o equipo. Puedes consultarla, pero no recuperar con ella la llave de esta instalación.',
  BACKUP_KEY_STORE_FAILED:'No se pudo guardar o recuperar la llave en Windows. No se reemplazaron claves ni datos.',
  BACKUP_CURRENT_DATABASE_REQUIRED:'La base original debe permanecer en este equipo. La copia se puede consultar; no reemplaza automáticamente la base activa.',
  BACKUP_CLOSE_ACTIVE_REQUIRED:'Cierra y vuelve a abrir VentaRD antes de recuperar una llave local perdida. Los datos actuales se conservan.',
  BACKUP_NOT_OPEN:'Vuelve a elegir y verificar el respaldo y su llave.',
  RECOVERY_REVIEW_REQUIRED:'Este equipo está revisando un respaldo. Confirma o cancela esa recuperación antes de guardar cambios nuevos.',
  RECOVERY_NEW_IDENTITY_REQUIRED:'Para continuar usa una instalación nueva del mismo negocio y sucursal. La identidad del equipo anterior se conserva únicamente como origen histórico.',
  RECOVERY_FRESH_INSTALLATION_REQUIRED:'Esta recuperación necesita una instalación nueva que todavía no haya creado operaciones propias. No se reemplazarán sus datos actuales.',
  RECOVERY_PENDING_UNVERIFIED:'Quedan operaciones del respaldo sin comprobante remoto completo. Se conservan y no se habilita otra copia del escritor.',
  RECOVERY_ORIGINAL_USER_REQUIRED:'Inicia sesión con el usuario que creó esos pendientes. No se enviarán con la identidad de otra persona.',
  RECOVERY_SOURCE_NOT_ACTIVE:'El origen ya está retirado o cambió de identidad. Conserva el intento y revisa qué instalación recibió su continuidad.',
  RECOVERY_SNAPSHOT_EXPIRED:'La captura de este intento caducó. Cancélalo conservando el respaldo y prepara uno nuevo; si el retiro ya se aplicó se recuperará su recibo.',
  RECOVERY_CONFIRMATION_REQUIRED:'Confirma primero que el equipo anterior dejó de usarse.',
  RECOVERY_CONTEXT:'Cambió la cuenta durante la recuperación. Vuelve a su negocio y usuario para continuar.',
  RECOVERY_ID_CONFLICT:'El intento pertenece a otro respaldo o contexto. Se conservó el original.',
  RECOVERY_RECEIPT_CONFLICT:'El resultado recibido difiere del guardado. Se conservó el primero para revisión.',
  RECOVERY_STORAGE:'No se pudo guardar la recuperación. Conserva el mismo intento y vuelve a consultarlo.',
  RECOVERY_MIGRATION_REQUIRED:'El servidor necesita habilitar la continuidad de respaldos. La copia cifrada y los datos activos se conservan.',
  RECOVERY_INVALID:'El respaldo o su comprobación no pasó la validación. Los datos activos se conservan.',
  RECOVERY_TOO_LARGE:'Este respaldo supera el límite de recuperación automática. La copia sigue disponible para consulta.',
  BACKUP_ARCHIVE_READ_ONLY:'El respaldo permite consulta. No puede cobrar, sincronizar, cambiar datos ni emitir comprobantes.',
  BACKUP_TOO_MANY_CANDIDATES:'Cierra y abre VentaRD para verificar más copias. Los archivos se conservan.',
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

export interface BackupSummary {backupId:string;state:string;capturedAtMs?:string;databaseBytes?:string;counts?:Record<string,string>;handle?:string}
export interface BackupView {rows:BackupSummary[];canCreate:boolean;archive?:BackupSummary}
export interface RecoveryPlan {recoveryId:string;backupId:string;capturedAtMs:string;state:'REVIEW'|'BLOCKED'|'PREPARED'|'ACTIVE'|'ABANDONED';review:{total:string;verified:string;unresolved:string;canTransfer:boolean;replay:false;issues:{operationId:string;code:string;pendingInBackup:boolean}[]}}
export interface WebMigrationSummary {exportId:string;tenantId:string;origin:string;profileAlias:string;capturedAtMs:string;state:'PRESERVED_REVIEW_REQUIRED';writersStopped:false;counts:Record<string,number>;pendingRows:number;remoteUnverifiedRows:number;unknownScopeRows:number;foreignTenantRows:number;unknownTenantRows:number;missingReferences:number;externalImageReferences:number;canActivate:false}
export interface WebReconcileReport {reportId:string;exportId:string;state:'PENDING'|'PENDING_ERROR'|'REVIEW_REQUIRED';lastError:string|null;totalBatches:number;completedBatches:number;createdAtMs:string;counts:Record<string,number>;inventoryEffectCounts?:Record<string,number>;canActivate:false;coverage:'REQUESTED_IDS_ONLY_WINDOWED';effectStatus:'UNKNOWN_LEGACY'}
export interface WebInventoryEvidence {status:'PENDING_LOOKUP'|'APPLIED_VERIFIED'|'UNKNOWN_LEGACY'|'CONFLICT';code:string;receipt?:{operationId:string;payloadHash:string;authority:'GLOBAL'|'BRANCH';sucursalId:string|null;stockBefore:string;stockAfter:string;remoteSequence:string;appliedAt:string}}
export interface WebComparisonRow {id:string;table:string;status:string;effectStatus:'UNKNOWN_LEGACY';matchedFields?:string[];differentFields?:string[];unverifiableFields?:string[];reviewFields?:{field:string;local:string;remote:string}[];limitations:string[];observedAtMs?:string;inventoryEvidence?:WebInventoryEvidence;inventoryReceivedAtMs?:string}
export const backupPort={
 recoveryArchivedList:()=>call<{rows:{recoveryId:string;backupId:string;capturedAtMs:string}[]}>('native_backup',{command:{action:'RECOVERY_ARCHIVED_LIST'}}),
 recoveryOpenNested:(recoveryId:string)=>call('native_backup',{command:{action:'RECOVERY_OPEN_NESTED',recoveryId}}),
 recoveryList:()=>call<{rows:RecoveryPlan[]}>('native_backup',{command:{action:'RECOVERY_LIST'}}),
 recoveryPrepare:(handle:string,recoveryId:string)=>call<RecoveryPlan>('native_backup',{command:{action:'RECOVERY_PREPARE',handle,recoveryId}}),
 recoveryReview:(recoveryId:string)=>call<RecoveryPlan>('native_backup',{command:{action:'RECOVERY_REVIEW',recoveryId}}),
 recoverySendPending:(recoveryId:string,originalStopped:boolean)=>call<RecoveryPlan>('native_backup',{command:{action:'RECOVERY_SEND_PENDING',recoveryId,originalStopped}}),
 recoveryConfirm:(recoveryId:string,originalStopped:boolean)=>call<RecoveryPlan>('native_backup',{command:{action:'RECOVERY_CONFIRM',recoveryId,originalStopped}}),
 recoveryRecover:(recoveryId:string)=>call<RecoveryPlan>('native_backup',{command:{action:'RECOVERY_RECOVER',recoveryId}}),
 recoveryAbandon:(recoveryId:string)=>call<RecoveryPlan>('native_backup',{command:{action:'RECOVERY_ABANDON',recoveryId}}),
 recoveryOpen:(recoveryId:string)=>call('native_backup',{command:{action:'RECOVERY_OPEN',recoveryId}}),
 transitionView:()=>call<{report:TransitionReport|null;capture:{captureId:string;capturedAtMs:string}|null}>('native_backup',{command:{action:'TRANSITION_VIEW'}}),
 transitionCutoverView:(runId:string)=>call<CutoverView>('native_backup',{command:{action:'TRANSITION_CUTOVER_VIEW',runId}}),
 transitionCutover:(input:CutoverInput)=>call<CutoverStatus>('native_backup',{command:{action:'TRANSITION_CUTOVER',input}}),
 transitionCutoverRecover:(cutoverId:string)=>call<CutoverStatus>('native_backup',{command:{action:'TRANSITION_CUTOVER_RECOVER',cutoverId}}),
 transitionCutoverAbandon:(cutoverId:string)=>call<CutoverStatus>('native_backup',{command:{action:'TRANSITION_CUTOVER_ABANDON',cutoverId}}),
 transitionCapture:(captureId:string)=>call<{captureId:string;capturedAtMs:string;counts:Record<string,number>}>('native_backup',{command:{action:'TRANSITION_CAPTURE',captureId}}),
 transitionPrepare:(runId:string,exportIds:string[],captureId:string|null)=>call<TransitionReport>('native_backup',{command:{action:'TRANSITION_PREPARE',runId,exportIds,captureId}}),
 transitionRows:(runId:string,table:string,page:number)=>call<{rows:TransitionRow[];total:number;page:number}>('native_backup',{command:{action:'TRANSITION_ROWS',runId,table,page}}),
 transitionResolve:(runId:string,table:string,rowId:string,variantId:string,revision:number,reason:string)=>call<TransitionReport>('native_backup',{command:{action:'TRANSITION_RESOLVE',runId,table,rowId,variantId,revision,reason}}),
 transitionResolveDocument:(runId:string,saleId:string,sourceId:string,revision:number,reason:string)=>call<TransitionReport>('native_backup',{command:{action:'TRANSITION_RESOLVE_DOCUMENT',runId,saleId,sourceId,revision,reason}}),
 transitionPublish:(runId:string,revision:number)=>call<TransitionReport>('native_backup',{command:{action:'TRANSITION_PUBLISH',runId,revision}}),
 legacyHistory:(filter:PosHistoryFilter)=>call<LegacyHistoryPage>('native_backup',{command:{action:'LEGACY_HISTORY',filter}}),
 legacyTicket:(saleId:string)=>call<LegacyTicket>('native_backup',{command:{action:'LEGACY_TICKET',saleId}}),
 webReport:(exportId:string)=>call<{report:WebReconcileReport|null}>('native_backup',{command:{action:'WEB_RECONCILE_VIEW',exportId}}),
 webReportPrepare:(exportId:string,reportId:string)=>call<WebReconcileReport>('native_backup',{command:{action:'WEB_RECONCILE_PREPARE',exportId,reportId}}),
 webReportStep:(reportId:string)=>call<WebReconcileReport>('native_backup',{command:{action:'WEB_RECONCILE_STEP',reportId}}),
 webReportRows:(reportId:string,table:string,page:number)=>call<{rows:WebComparisonRow[];total:number;page:number}>('native_backup',{command:{action:'WEB_RECONCILE_ROWS',reportId,table,page}}),
 webStatus:()=>call<{rows:WebMigrationSummary[]}>('native_backup',{command:{action:'WEB_STATUS'}}),
 webImport:()=>call<WebMigrationSummary|{state:'CANCELLED'}>('native_backup',{command:{action:'WEB_IMPORT'}}),
 webRows:(exportId:string,table:string,page:number)=>call<{rows:Record<string,unknown>[];total:number;page:number}>('native_backup',{command:{action:'WEB_ROWS',exportId,table,page}}),
 settingsRead:()=>call<import('./management').BusinessSettingsView>('native_backup',{command:{action:'SETTINGS_READ'}}),
 printLayoutRead:()=>call<{layout:import('./management').PrintLayout;canWrite:boolean;coverage:string}>('native_backup',{command:{action:'PRINT_LAYOUT_READ'}}),
 repairsRead:()=>call<import('./management').RepairsView>('native_backup',{command:{action:'REPAIRS_READ'}}),
 layawaysRead:()=>call<import('./management').LayawaysView>('native_backup',{command:{action:'LAYAWAYS_READ'}}),
 warrantiesRead:()=>call<import('./management').WarrantiesView>('native_backup',{command:{action:'WARRANTIES_READ'}}),
 report:(fromMs:string,toMs:string)=>call<import('./management').ManagementReport>('native_backup',{command:{action:'REPORT',fromMs,toMs}}),
 inventoryHistory:(productId:string,page:number)=>call<import('./management').InventoryHistory>('native_backup',{command:{action:'INVENTORY_HISTORY',productId,page}}),
 document:<T>(family:'REPAIR'|'LAYAWAY'|'WARRANTY'|'CUT',operationId:string)=>call<T>('native_backup',{command:{action:'DOCUMENT',family,operationId}}),
 status:()=>call<BackupView>('native_backup',{command:{action:'STATUS'}}),
 abandon:(operationId:string)=>call('native_backup',{command:{action:'ABANDON',operationId}}),
 create:(operationId:string)=>call<BackupSummary>('native_backup',{command:{action:'CREATE',operationId}}),
 inspect:()=>call<BackupSummary>('native_backup',{command:{action:'INSPECT'}}),
 open:(handle:string)=>call('native_backup',{command:{action:'OPEN',handle}}),
 close:()=>call('native_backup',{command:{action:'CLOSE'}}),
 recoverKey:(handle:string,pin:string)=>call<{state:string;databaseReplaced:boolean}>('native_backup',{command:{action:'RECOVER_KEY',handle,pin}}),
 read:()=>call<PosSnapshot>('native_backup',{command:{action:'READ'}}),
 historyRead:(filter:PosHistoryFilter)=>call<PosHistoryPage>('native_backup',{command:{action:'HISTORY_READ',filter}}),
 ticket:(operationId:string)=>call<PosTicket>('native_backup',{command:{action:'TICKET',operationId}}),
 customerActivity:(customerId:string)=>call<import('./management').CustomerActivity>('native_backup',{command:{action:'CUSTOMER_ACTIVITY',customerId}}),
 managementRead:()=>call<import('./management').ManagementView>('native_backup',{command:{action:'MANAGEMENT_READ'}}),
 reportExport:(kind:import('./management').ExportKind,fromMs:string,toMs:string)=>call<import('./management').ReportBundle>('native_backup',{command:{action:'REPORT_EXPORT',kind,fromMs,toMs}}),
};
export interface TransitionReport {runId:string;revision:number;historyPublished:boolean;createdAtMs:string;sources:{id:string;kind:'BROWSER'|'CLOUD';sha256:string}[];counts:Record<string,number>;conflicts:number;issues:{code:string;table:string;id:string;field:string}[];sales:{totalCents:string|null;byMethodCents:Record<string,string>};debts:{customerId:string;name:string|null;balanceCents:string|null;observedBalanceCents:string;coverage:string}[];cash:{id:string;state:string|null;openingCents:string|null;movementsCents:string;expectedCents:string|null;observedExpectedCents:string|null;coverage:string}[];payments:{id:string;table:string;documentId:string;montoCents:string;method:string|null;cajaId:string|null}[];cloudCoverage:string;effectStatus:'UNKNOWN_LEGACY';canActivate:false}
export interface CutoverInput {cutoverId:string;runId:string;revision:number;backupId:string;confirmation:'WEB_WRITERS_CLOSED_BALANCES_REVIEWED';freeTax:'0'|'0.18';serviceReservationsConfirmed?:boolean;legacyCashHistoryConfirmed?:boolean}
export interface CutoverStatus {cutoverId:string;runId:string;backupId:string;state:'UNKNOWN'|'ADOPTED'|'ACTIVE'|'ABANDONED'}
export interface CutoverView {legacyCashHistoryWarnings?:{code:string;id:string;table:string}[];serviceHistoryWarnings?:{code:string;id:string;table:string}[];services?:{table:string;id:string;folio:string}[];runId:string;revision:number;canPrepare:boolean;blockers:{code:string;id?:string;table?:string}[];pending:CutoverStatus|null;backups:string[];coverage:string;legacyReplay:false}
// A refresh hint carries no authority; the router rereads the native status.
export const nativeAccessChanged = () => window.dispatchEvent(new Event('ventard:access-changed'));
export interface TransitionRow {id:string;variants:{variantId:string;sourceIds:string[];row:Record<string,unknown>}[];selected:Record<string,unknown>|null;selectedVariant:string|null;excluded?:boolean;document?:{state:'CONFLICT'|'CONSENSUS'|'CHOSEN';chosenSource:string|null;variants:{sourceId:string;sale:Record<string,unknown>;details:Record<string,unknown>[];charges:Record<string,unknown>[];inventory:Record<string,unknown>[];journals:Record<string,unknown>[]}[]}}
export interface LegacyHistoryRow {id:string;ticket:string;dateMs:string|null;method:string|null;totalCents:string|null;ncf:string|null;customerName:string|null;effectStatus:'UNKNOWN_LEGACY'}
export interface LegacyHistoryPage {rows:LegacyHistoryRow[];total:string;page:number;pageSize:number;coverage:'PUBLISHED_LEGACY_HISTORY'}
export interface LegacyTicket {id:string;ticket:string;ncf:string|null;dateMs:string|null;customerName:string|null;actorName:string|null;method:string|null;totalCents:string|null;subtotalCents:string|null;itbisCents:string|null;discountCents:string|null;receivedCents?:string|null;changeCents?:string|null;business?:import('./management').BusinessHeader|null;lines:{id:string;name:string|null;quantity:string|null;unitPriceCents:string|null;subtotalCents:string|null;serial?:string|null;location?:string|null}[];coverage:'PRESERVED_LEGACY_FIELDS'|'HASH_MATCHED_LOCAL_CHECKOUT';effectStatus:'UNKNOWN_LEGACY'}
export interface ImportRow {row:number;name:string;code?:string|null;price?:string|null;cost?:string|null;stock?:string|null;minimum?:string|null;location?:string|null}
export interface ImportBatch {operationId:string;fileName:string;duplicatePolicy:'SKIP'|'UPDATE';newTaxPercent:'0'|'18';rows:ImportRow[]}
export interface ImportResult {operationId:string;fileName:string;state:'PREPARED'|'FINISHED';ready:string;remaining:string;created:string;updated:string;invalid:string;skipped:string;rows:{row:number;name:string;state:'READY'|'DONE'|'INVALID'|'SKIPPED'|'ERROR';error:string|null;created:boolean;definition:import('./management').ProductDefinition|null;stock:string|null}[]}
export const inventoryImportPort={
 list:()=>call<{rows:ImportResult[]}>('native_sales',{command:{action:'IMPORT_LIST'}}),
 prepare:(batch:ImportBatch)=>call<ImportResult>('native_sales',{command:{action:'IMPORT_PREPARE',batch}}),
 run:(operationId:string)=>call<ImportResult>('native_sales',{command:{action:'IMPORT_RUN',operationId}}),
 stop:(operationId:string)=>call<ImportResult>('native_sales',{command:{action:'IMPORT_STOP',operationId}}),
};
export interface FiscalSettingsInput {operationId:string;expectedRevision:string;type:'B01'|'B02';first:string;last:string;enabled:boolean}
export interface FiscalSettingsView {configuration:{type:'B01'|'B02';first:string;last:string;next:string;enabled:boolean;revision:string}|null;capturedAtMs:string|null;pending:({requestId:string}&Omit<FiscalSettingsInput,'operationId'>)|null;lastStatus:'UNKNOWN'|'RECEIVED'|'ABANDONED'|null;canWrite:boolean;remoteError?:string}
export const fiscalSettingsPort={
 read:()=>call<FiscalSettingsView>('native_sales',{command:{action:'FISCAL_SETTINGS_READ'}}),
 save:(request:FiscalSettingsInput)=>call<FiscalSettingsView>('native_sales',{command:{action:'FISCAL_SETTINGS_SAVE',request}}),
 recover:(operationId:string)=>call<FiscalSettingsView>('native_sales',{command:{action:'FISCAL_SETTINGS_RECOVER',operationId}}),
 abandon:(operationId:string)=>call<FiscalSettingsView>('native_sales',{command:{action:'FISCAL_SETTINGS_ABANDON',operationId}}),
};

export const printerPort={
 read:()=>call<{probeAttempt?:{attemptId:string;state:string}|null;profile:import('./management').PrinterProfile;canWrite:boolean;queues:import('./management').PrinterQueue[]}>('native_sales',{command:{action:'PRINTER_READ'}}),
 save:(profile:import('./management').PrinterProfile)=>call<import('./management').PrinterProfile>('native_sales',{command:{action:'PRINTER_SAVE',profile}}),
 test:(attemptId:string)=>call<{status:string;submitted:boolean}>('native_sales',{command:{action:'PRINTER_TEST',attemptId}}),
};
