import { z } from 'zod';
import { ENTITY_NAMES, type ReconciliationInput, type ReconciliationReport } from './types';

const uuid = z.uuid();
const ms = z.number().int().nonnegative();
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const entity = z.enum(ENTITY_NAMES);
const scope = z.strictObject({ negocioId: uuid, sucursalId: uuid.optional(), desde: ms.optional(), hasta: ms.optional(), requestedIds: z.array(uuid).max(500).optional() });
const base = { id: uuid, negocioId: uuid, sucursalId: uuid.optional(), sourceId: z.string().min(1).max(120), observedAt: ms };
const syncFlag = z.union([z.literal(0), z.literal(1)]).optional();
const payment = z.strictObject({ monto: decimal, fecha: ms, metodo: z.string().max(32) });
const records = z.strictObject({
    ventas: z.array(z.strictObject({ ...base, fecha: ms, total: decimal, metodoPago: z.string().max(32), cajaCodigo: z.string().max(80).optional(), clienteId: uuid.optional(), montoEfectivo: decimal.optional(), montoTransferencia: decimal.optional(), syncFlag, historicalTotalFactsComplete: z.boolean().optional(), historicalDiscount: decimal.optional(), historicalTax: decimal.optional() })),
    ventaDetalles: z.array(z.strictObject({ ...base, ventaId: uuid, productoId: uuid, cantidad: decimal, precioUnitario: decimal, subtotal: decimal, fecha: ms.optional(), syncFlag, serialId: uuid.optional(), stockEffectRequiredAtSale: z.boolean().optional(), serialRequiredAtSale: z.boolean().optional() })),
    productos: z.array(z.strictObject({ ...base, stockMaterializado: decimal, fechaActualizacion: ms.optional(), syncFlag, tipo: z.enum(['simple', 'insumo', 'combo']).optional(), serializable: z.boolean().optional(), eliminado: z.boolean().optional(), pendingEditEvidence: z.strictObject({ intendedValue: decimal, priorValue: decimal, currentValue: decimal, versionComparable: z.boolean() }).optional() })),
    movimientosStock: z.array(z.strictObject({ ...base, productoId: uuid, delta: decimal.optional(), valorAbsoluto: decimal.optional(), tipo: z.string().max(40), referenciaOperacionId: uuid.optional(), fecha: ms, syncFlag, causalOrder: z.number().int().nonnegative().optional(), duplicateEffectVerified: z.boolean().optional() }).refine(v => v.delta !== undefined || v.valorAbsoluto !== undefined)),
    transaccionesFiado: z.array(z.strictObject({ ...base, ventaId: uuid.optional(), clienteId: uuid.optional(), tipo: z.string().max(32), monto: decimal, fecha: ms })),
    seriales: z.array(z.strictObject({ ...base, productoId: uuid, ventaId: uuid.optional(), estado: z.string().max(32), fechaVenta: ms.optional() })),
    devoluciones: z.array(z.strictObject({ ...base, ventaId: uuid, monto: decimal, fecha: ms })),
    cajas: z.array(z.strictObject({ ...base, estado: z.string().max(32), fechaApertura: ms, fechaCierre: ms.optional() })),
    cortesCaja: z.array(z.strictObject({ ...base, cajaId: uuid, tipo: z.enum(['X', 'Z']), fecha: ms })),
    gastos: z.array(z.strictObject({ ...base, monto: decimal, fecha: ms, metodo: z.string().max(32) })),
    reparaciones: z.array(z.strictObject({ ...base, fecha: ms, pagos: z.array(payment) })),
    apartados: z.array(z.strictObject({ ...base, fecha: ms, abonos: z.array(payment) })),
    reportes: z.array(z.strictObject({ ...base, tipo: z.string().max(64), total: decimal, desde: ms, hasta: ms })),
});
const coverage = z.strictObject({ entity, scope, status: z.enum(['COMPLETE', 'PARTIAL', 'UNAVAILABLE', 'DENIED']), startedAt: ms, finishedAt: ms, rowsRead: z.number().int().nonnegative(), pagesRead: z.number().int().nonnegative().optional(), exhausted: z.boolean().optional(), retentionHorizon: ms.optional(), concurrentChangePossible: z.boolean(), reason: z.string().max(120).optional() }).refine(v => v.startedAt <= v.finishedAt);
const snapshot = z.strictObject({
    contractVersion: z.literal('1.0'),
    source: z.strictObject({ sourceId: z.string().min(1).max(120), kind: z.enum(['LOCAL', 'REMOTE']), deviceLabel: z.string().min(1).max(120).optional(), negocioId: uuid, sucursalId: uuid.optional(), serverIdentityVerified: z.boolean().optional() }),
    capture: z.strictObject({ startedAt: ms, finishedAt: ms, asOf: ms, temporalConsistency: z.enum(['COHERENT', 'WINDOWED', 'UNKNOWN']), connectivityObserved: z.boolean().optional() }),
    coverage: z.array(coverage), records,
}).superRefine((value, ctx) => {
    if (value.capture.startedAt > value.capture.finishedAt) ctx.addIssue({ code: 'custom', message: 'capture window inverted' });
    const seen = new Set<string>();
    for (const c of value.coverage) {
        if (seen.has(c.entity)) ctx.addIssue({ code: 'custom', message: 'duplicate coverage' });
        seen.add(c.entity);
        if (c.scope.negocioId !== value.source.negocioId) ctx.addIssue({ code: 'custom', message: 'coverage tenant mismatch' });
    }
    for (const name of ENTITY_NAMES) {
        if (!seen.has(name)) ctx.addIssue({ code: 'custom', message: `missing coverage ${name}` });
        for (const row of value.records[name]) {
            if (row.negocioId !== value.source.negocioId || row.sourceId !== value.source.sourceId) ctx.addIssue({ code: 'custom', message: `row scope mismatch ${name}` });
        }
    }
});
const requestSchema = z.strictObject({ negocioId: uuid, sucursalId: uuid.optional(), desde: ms, hasta: ms, asOf: ms, pendingThresholdMs: z.number().int().positive(), selectedIds: z.strictObject({ ventas: z.array(uuid).max(500).optional(), productos: z.array(uuid).max(500).optional(), operaciones: z.array(uuid).max(500).optional() }).optional() }).refine(value => value.desde <= value.hasta && value.hasta <= value.asOf && value.hasta - value.desde <= 366 * 86_400_000, 'invalid period');
const inputSchema = z.strictObject({
    contractVersion: z.literal('1.0'),
    request: requestSchema,
    snapshots: z.array(snapshot).min(1).max(3),
}).superRefine((value, ctx) => {
    if (value.request.desde > value.request.hasta || value.request.hasta - value.request.desde > 366 * 86_400_000) ctx.addIssue({ code: 'custom', message: 'invalid period' });
    const locals = value.snapshots.filter(s => s.source.kind === 'LOCAL');
    if (locals.length < 1 || locals.length > 2 || value.snapshots.filter(s => s.source.kind === 'REMOTE').length > 1) ctx.addIssue({ code: 'custom', message: 'invalid sources' });
    if (locals.length === 2 && (locals.some(s => !s.source.deviceLabel) || locals[0].source.deviceLabel === locals[1].source.deviceLabel)) ctx.addIssue({ code: 'custom', message: 'second local source needs distinct label' });
    const sources = new Set<string>();
    for (const s of value.snapshots) {
        if (sources.has(s.source.sourceId)) ctx.addIssue({ code: 'custom', message: 'duplicate sourceId' });
        sources.add(s.source.sourceId);
        if (s.source.negocioId !== value.request.negocioId || (value.request.sucursalId && s.source.sucursalId && s.source.sucursalId !== value.request.sucursalId)) ctx.addIssue({ code: 'custom', message: 'source scope mismatch' });
        if (s.capture.asOf !== value.request.asOf) ctx.addIssue({ code: 'custom', message: 'asOf mismatch' });
    }
});

export function parseReconciliationInput(value: unknown): ReconciliationInput {
    return inputSchema.parse(value) as ReconciliationInput;
}

export function parseReconciliationRequest(value: unknown): ReconciliationInput['request'] {
    return requestSchema.parse(value) as ReconciliationInput['request'];
}

const severity = z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL']);
const category = z.enum(['SALE', 'INVENTORY', 'SYNC', 'PAYMENT', 'CASH', 'REPORTING', 'COMPATIBILITY', 'UNKNOWN']);
const findingCode = z.enum([
    'SALE_ORPHAN_LINE', 'SALE_MISSING_REQUIRED_EFFECT', 'SALE_TOTAL_MISMATCH', 'SALE_TOTAL_UNVERIFIABLE',
    'STOCK_BASE_UNVERIFIABLE', 'STOCK_MATERIALIZED_MISMATCH', 'STOCK_PRODUCT_MISSING',
    'MOVEMENT_DUPLICATE_SUSPECTED', 'MOVEMENT_DOUBLE_APPLIED', 'SYNC_PENDING', 'SYNC_PENDING_AGED',
    'SYNC_FALSE_CONFIRMED', 'SYNC_REMOTE_UNVERIFIABLE', 'PRODUCT_PENDING_EDIT_CONFLICT',
    'DEVICE_PROPAGATION_GAP', 'PAYMENT_CASH_MISMATCH', 'CASH_CONTEXT_MISMATCH', 'CASH_CUT_INCOMPLETE',
    'REFUND_SETTLEMENT_UNVERIFIABLE', 'REPORT_TAX_UNVERIFIABLE', 'REPORT_REFUND_GAP', 'REPORT_HISTORY_PARTIAL',
    'SNAPSHOT_SCOPE_CONFLICT', 'SNAPSHOT_INCOMPLETE',
]);
const evidence = z.strictObject({ sourceId: z.string(), entity, id: z.string(), field: z.string().optional(), observedValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(), capturedAt: ms, coverageStatus: z.enum(['COMPLETE', 'PARTIAL', 'UNAVAILABLE', 'DENIED']) });
const finding = z.strictObject({
    findingId: z.string().min(1), code: findingCode, severity, category, entity,
    ids: z.strictObject({ saleId: z.string().optional(), productId: z.string().optional(), movementId: z.string().optional(), cashId: z.string().optional(), refundId: z.string().optional(), operationId: z.string().optional() }),
    sources: z.array(z.string()), explanation: z.string(), localEvidence: z.array(evidence), remoteEvidence: z.array(evidence), missingEvidence: z.array(z.string()),
    interpretedSyncState: z.enum(['PENDING', 'PENDING_AGED', 'APPLIED_VERIFIED', 'RECOVERABLE_ERROR', 'INTERVENTION_REQUIRED', 'FALSE_CONFIRMED', 'UNKNOWN']).optional(),
    verificability: z.enum(['VERIFIED', 'DISCREPANT', 'UNVERIFIABLE']), diagnosticRecommendation: z.string(),
});
const reportSchema = z.strictObject({
    contractVersion: z.literal('1.0'), asOf: ms,
    scope: z.strictObject({ negocioId: uuid, sucursalId: uuid.optional(), desde: ms, hasta: ms, deviceLabels: z.array(z.string()) }),
    overall: z.enum(['CONSISTENT_WITH_EVIDENCE', 'FINDINGS_PRESENT', 'INCOMPLETE_EVIDENCE']),
    sources: z.array(z.strictObject({ sourceId: z.string(), kind: z.enum(['LOCAL', 'REMOTE']), captureWindow: z.strictObject({ startedAt: ms, finishedAt: ms }), coverageSummary: z.enum(['COMPLETE', 'PARTIAL', 'UNAVAILABLE', 'DENIED']) })),
    coverage: z.array(coverage),
    counts: z.strictObject({ bySeverity: z.strictObject({ INFO: z.number().int().nonnegative(), WARNING: z.number().int().nonnegative(), ERROR: z.number().int().nonnegative(), CRITICAL: z.number().int().nonnegative() }), byCategory: z.strictObject({ SALE: z.number().int().nonnegative(), INVENTORY: z.number().int().nonnegative(), SYNC: z.number().int().nonnegative(), PAYMENT: z.number().int().nonnegative(), CASH: z.number().int().nonnegative(), REPORTING: z.number().int().nonnegative(), COMPATIBILITY: z.number().int().nonnegative(), UNKNOWN: z.number().int().nonnegative() }), unverifiable: z.number().int().nonnegative() }),
    findings: z.array(finding),
});

export function parseReconciliationReport(value: unknown): ReconciliationReport {
    return reportSchema.parse(value) as ReconciliationReport;
}
