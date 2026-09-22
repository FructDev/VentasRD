/** Transient, read-only diagnostic contract. No type here is a write command. */
export const ENTITY_NAMES = [
    'ventas', 'ventaDetalles', 'productos', 'movimientosStock', 'transaccionesFiado',
    'seriales', 'devoluciones', 'cajas', 'cortesCaja', 'gastos', 'reparaciones',
    'apartados', 'reportes',
] as const;
export type EntityName = typeof ENTITY_NAMES[number];
export type CoverageStatus = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE' | 'DENIED';
export type Severity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
export type Category = 'SALE' | 'INVENTORY' | 'SYNC' | 'PAYMENT' | 'CASH' | 'REPORTING' | 'COMPATIBILITY' | 'UNKNOWN';
export type Verificability = 'VERIFIED' | 'DISCREPANT' | 'UNVERIFIABLE';
export type SyncState = 'PENDING' | 'PENDING_AGED' | 'APPLIED_VERIFIED' | 'RECOVERABLE_ERROR' | 'INTERVENTION_REQUIRED' | 'FALSE_CONFIRMED' | 'UNKNOWN';
export type PropagationStage = 'UPLOAD' | 'REMOTE_APPLY' | 'DEVICE_RECEIVE' | 'DEVICE_UPDATE';
export type FindingCode =
    | 'SALE_ORPHAN_LINE' | 'SALE_MISSING_REQUIRED_EFFECT' | 'SALE_TOTAL_MISMATCH' | 'SALE_TOTAL_UNVERIFIABLE'
    | 'STOCK_BASE_UNVERIFIABLE' | 'STOCK_MATERIALIZED_MISMATCH' | 'STOCK_PRODUCT_MISSING'
    | 'MOVEMENT_DUPLICATE_SUSPECTED' | 'MOVEMENT_DOUBLE_APPLIED' | 'SYNC_PENDING' | 'SYNC_PENDING_AGED'
    | 'SYNC_FALSE_CONFIRMED' | 'SYNC_REMOTE_UNVERIFIABLE' | 'PRODUCT_PENDING_EDIT_CONFLICT'
    | 'DEVICE_PROPAGATION_GAP' | 'PAYMENT_CASH_MISMATCH' | 'CASH_CONTEXT_MISMATCH'
    | 'CASH_CUT_INCOMPLETE' | 'REFUND_SETTLEMENT_UNVERIFIABLE' | 'REPORT_TAX_UNVERIFIABLE'
    | 'REPORT_REFUND_GAP' | 'REPORT_HISTORY_PARTIAL' | 'SNAPSHOT_SCOPE_CONFLICT' | 'SNAPSHOT_INCOMPLETE';

export interface DiagnosticScope {
    negocioId: string;
    sucursalId?: string;
    desde?: number;
    hasta?: number;
    requestedIds?: string[];
}
export interface ReconciliationRequest extends DiagnosticScope {
    desde: number;
    hasta: number;
    asOf: number;
    pendingThresholdMs: number;
    selectedIds?: { ventas?: string[]; productos?: string[]; operaciones?: string[] };
}
export interface Coverage {
    entity: EntityName;
    scope: DiagnosticScope;
    status: CoverageStatus;
    startedAt: number;
    finishedAt: number;
    rowsRead: number;
    pagesRead?: number;
    exhausted?: boolean;
    retentionHorizon?: number;
    concurrentChangePossible: boolean;
    reason?: string;
}
export interface ObservedBase {
    id: string;
    negocioId: string;
    sucursalId?: string;
    sourceId: string;
    observedAt: number;
}
export interface ObservedSale extends ObservedBase {
    fecha: number;
    total: string;
    metodoPago: string;
    cajaCodigo?: string;
    clienteId?: string;
    montoEfectivo?: string;
    montoTransferencia?: string;
    syncFlag?: 0 | 1;
    /** Only explicit, immutable historical facts may enable exact reconstruction. */
    historicalTotalFactsComplete?: boolean;
    historicalDiscount?: string;
    historicalTax?: string;
}
export interface ObservedSaleLine extends ObservedBase {
    ventaId: string;
    productoId: string;
    cantidad: string;
    precioUnitario: string;
    subtotal: string;
    fecha?: number;
    syncFlag?: 0 | 1;
    serialId?: string;
    stockEffectRequiredAtSale?: boolean;
    serialRequiredAtSale?: boolean;
}
export interface ObservedProduct extends ObservedBase {
    stockMaterializado: string;
    fechaActualizacion?: number;
    syncFlag?: 0 | 1;
    tipo?: 'simple' | 'insumo' | 'combo';
    serializable?: boolean;
    eliminado?: boolean;
    /** Explicit proof supplied by a controlled capture; not inferred from current stock. */
    pendingEditEvidence?: { intendedValue: string; priorValue: string; currentValue: string; versionComparable: boolean };
}
export interface ObservedStockMovement extends ObservedBase {
    productoId: string;
    delta?: string;
    valorAbsoluto?: string;
    tipo: string;
    referenciaOperacionId?: string;
    fecha: number;
    syncFlag?: 0 | 1;
    /** Explicit causal order when independently preserved; timestamps are not one. */
    causalOrder?: number;
    duplicateEffectVerified?: boolean;
}
export interface ObservedCreditTransaction extends ObservedBase { ventaId?: string; clienteId?: string; tipo: string; monto: string; fecha: number; }
export interface ObservedSerial extends ObservedBase { productoId: string; ventaId?: string; estado: string; fechaVenta?: number; }
export interface ObservedRefund extends ObservedBase { ventaId: string; monto: string; fecha: number; /** Absent in the current local model. */ settlementMethod?: string; }
export interface ObservedCashRegister extends ObservedBase {
    estado: string; fechaApertura: number; fechaCierre?: number;
    montoApertura?: string; montoCierre?: string; montoEsperado?: string; diferencia?: string;
}
export interface ObservedCashCut extends ObservedBase {
    cajaId: string; tipo: 'X' | 'Z'; fecha: number;
    efectivo?: string; tarjeta?: string; transferencia?: string; fiado?: string; mixto?: string;
    totalVentas?: string; ingresoReparaciones?: string; ingresoApartados?: string;
    montoApertura?: string; montoEsperado?: string; montoContado?: string; diferencia?: string;
}
export interface ObservedExpense extends ObservedBase { monto: string; fecha: number; metodo: string; eliminado?: boolean; }
export interface ObservedPayment { monto: string; fecha: number; metodo: string; origin?: 'HISTORY' | 'LEGACY_PERSISTED' | 'LEGACY_DEFAULT'; }
export interface ObservedRepairPaymentSummary extends ObservedBase { fecha: number; total?: string; declaredPaid?: string; paymentHistoryComplete?: boolean; pagos: ObservedPayment[]; }
export interface ObservedLayawayPaymentSummary extends ObservedBase { fecha: number; total?: string; declaredPaid?: string; paymentHistoryComplete?: boolean; abonos: ObservedPayment[]; }
export interface ObservedReportValue extends ObservedBase {
    tipo: string; total: string; desde: number; hasta: number;
    taxTotal?: string; taxFormula?: 'HISTORICAL' | 'CURRENT_PRODUCT_RATE' | 'DEFAULT_RATE'; refundsIncluded?: boolean;
}
export interface SnapshotRecords {
    ventas: ObservedSale[];
    ventaDetalles: ObservedSaleLine[];
    productos: ObservedProduct[];
    movimientosStock: ObservedStockMovement[];
    transaccionesFiado: ObservedCreditTransaction[];
    seriales: ObservedSerial[];
    devoluciones: ObservedRefund[];
    cajas: ObservedCashRegister[];
    cortesCaja: ObservedCashCut[];
    gastos: ObservedExpense[];
    reparaciones: ObservedRepairPaymentSummary[];
    apartados: ObservedLayawayPaymentSummary[];
    reportes: ObservedReportValue[];
}
export interface SourceSnapshot {
    contractVersion: '1.0';
    source: { sourceId: string; kind: 'LOCAL' | 'REMOTE'; deviceLabel?: string; negocioId: string; sucursalId?: string; serverIdentityVerified?: boolean };
    capture: { startedAt: number; finishedAt: number; asOf: number; temporalConsistency: 'COHERENT' | 'WINDOWED' | 'UNKNOWN'; connectivityObserved?: boolean; /** Capture sequence asserted by the diagnostic operator/workflow, not inferred from PC clocks. */ observedAfterSourceIds?: string[] };
    coverage: Coverage[];
    records: SnapshotRecords;
}
export interface ReconciliationInput { contractVersion: '1.0'; request: ReconciliationRequest; snapshots: SourceSnapshot[]; }
export interface EvidenceRef { sourceId: string; entity: EntityName; id: string; field?: string; observedValue?: string | number | boolean | null; capturedAt: number; coverageStatus: CoverageStatus; }
export interface Finding {
    findingId: string;
    code: FindingCode;
    severity: Severity;
    category: Category;
    entity: EntityName;
    ids: { saleId?: string; productId?: string; movementId?: string; cashId?: string; refundId?: string; operationId?: string };
    sources: string[];
    explanation: string;
    localEvidence: EvidenceRef[];
    remoteEvidence: EvidenceRef[];
    missingEvidence: string[];
    interpretedSyncState?: SyncState;
    stage?: PropagationStage;
    verificability: Verificability;
    diagnosticRecommendation: string;
}
export type FindingDraft = Omit<Finding, 'findingId'>;
export interface ReconciliationReport {
    contractVersion: '1.0';
    asOf: number;
    scope: { negocioId: string; sucursalId?: string; desde: number; hasta: number; deviceLabels: string[] };
    overall: 'CONSISTENT_WITH_EVIDENCE' | 'FINDINGS_PRESENT' | 'INCOMPLETE_EVIDENCE';
    sources: { sourceId: string; kind: 'LOCAL' | 'REMOTE'; captureWindow: { startedAt: number; finishedAt: number }; coverageSummary: CoverageStatus }[];
    coverage: Coverage[];
    counts: { bySeverity: Record<Severity, number>; byCategory: Record<Category, number>; unverifiable: number };
    findings: Finding[];
}
