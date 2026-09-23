import type { EvidenceRef, Finding, FindingDraft, ReconciliationReport } from './types';

const REDACTED = '[REDACTED]';
const SAFE_EVIDENCE_FIELDS = new Set([
    'cantidad', 'causalOrder', 'delta', 'diferencia', 'estado', 'fecha', 'metodoPago',
    'monto', 'montoContado', 'montoEsperado', 'montoEsperadoContextual',
    'montoEsperadoObservable', 'refundsIncluded', 'stockMaterializado', 'subtotal',
    'syncFlag', 'taxFormula', 'taxTotal', 'tipo', 'total', 'valorAbsoluto',
]);
const SENSITIVE_FIELD = /(?:^|[_\s-])(authorization|bearer|clave|contrase(?:n|ñ)a|correo|email|imei|nota|notes?|password|phone|pin|secret|secreto|tel(?:e?fono)?|token)(?:$|[_\s-])/i;
const LABELED_SECRET = /\b(access[_\s-]?token|api[_\s-]?key|authorization|bearer|clave|contrase(?:n|ñ)a|correo|email|imei|notas?|notes?|password|phone|pin|refresh[_\s-]?token|secret|secreto|tel(?:e?fono)?|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^;\n]*)/giu;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const IMEI = /\b\d{15}\b/g;
const PHONE = /(?<!\d)(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}(?!\d)/g;
const EXECUTABLE_REPAIR = /\b(?:ALTER\s+TABLE|DELETE\s+FROM|DROP\s+TABLE|INSERT\s+INTO|TRUNCATE\s+TABLE|UPDATE\s+[A-Za-z_][\w.]*(?:\s+SET)?|UPSERT\s+INTO)\b[^;\n]*/gi;
const CODE_ACTION = /\b(?:curl|wget|npm|pnpm|yarn)\s+[^;\n]+|\b(?:db|supabase)\.(?:from|rpc|insert|update|upsert|delete)\s*\([^\n]*|\b(?:retry|sync)\s*\([^\n]*/gi;

/** Removes unnecessary secrets and PII without consulting time, randomness or external state. */
export function sanitizeText(value: string): string {
    return value
        .replace(LABELED_SECRET, (_match, label: string) => `${label}=${REDACTED}`)
        .replace(BEARER, REDACTED)
        .replace(JWT, REDACTED)
        .replace(EMAIL, REDACTED)
        .replace(IMEI, REDACTED)
        .replace(PHONE, REDACTED);
}

/** Coverage reasons are protocol codes, never operator-authored notes. */
export function sanitizeCoverageReason(value: string): string {
    return /^[A-Z][A-Z0-9_]{1,119}$/.test(value) ? value : 'REDACTED_REASON';
}

function sanitizeDiagnosticText(value: string): string {
    return sanitizeText(value)
        .replace(EXECUTABLE_REPAIR, '[REPAIR_COMMAND_OMITTED]')
        .replace(CODE_ACTION, '[REPAIR_COMMAND_OMITTED]');
}

function sanitizeIdentifier(value: string): string {
    return sanitizeText(value);
}

function stableMissingEvidence(value: string): string {
    if (SENSITIVE_FIELD.test(value)) return 'REDACTED_EVIDENCE';
    const stable = sanitizeText(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return stable || 'UNSPECIFIED_EVIDENCE';
}

export function sanitizeEvidence(reference: EvidenceRef): EvidenceRef {
    const safeField = reference.field && SAFE_EVIDENCE_FIELDS.has(reference.field) && !SENSITIVE_FIELD.test(reference.field)
        ? reference.field
        : undefined;
    const safeValue = safeField && reference.observedValue !== undefined
        ? typeof reference.observedValue === 'string' ? sanitizeText(reference.observedValue) : reference.observedValue
        : undefined;
    return {
        sourceId: sanitizeIdentifier(reference.sourceId),
        entity: reference.entity,
        id: sanitizeIdentifier(reference.id),
        ...(safeField && { field: safeField }),
        ...(safeValue !== undefined && { observedValue: safeValue }),
        capturedAt: reference.capturedAt,
        coverageStatus: reference.coverageStatus,
    };
}

const idOrder: ReadonlyArray<keyof FindingDraft['ids']> = ['saleId', 'productId', 'movementId', 'cashId', 'refundId', 'operationId'];

function sanitizeIds(ids: FindingDraft['ids']): FindingDraft['ids'] {
    return Object.fromEntries(idOrder.flatMap(key => ids[key] ? [[key, sanitizeIdentifier(ids[key]!)] as const] : []));
}

export function sanitizeFindingDraft(draft: FindingDraft): FindingDraft {
    return {
        code: draft.code,
        severity: draft.severity,
        category: draft.category,
        entity: draft.entity,
        ids: sanitizeIds(draft.ids),
        sources: draft.sources.map(sanitizeIdentifier),
        explanation: sanitizeDiagnosticText(draft.explanation),
        localEvidence: draft.localEvidence.map(sanitizeEvidence),
        remoteEvidence: draft.remoteEvidence.map(sanitizeEvidence),
        missingEvidence: draft.missingEvidence.map(stableMissingEvidence),
        ...(draft.interpretedSyncState && { interpretedSyncState: draft.interpretedSyncState }),
        ...(draft.stage && { stage: draft.stage }),
        verificability: draft.verificability,
        diagnosticRecommendation: sanitizeDiagnosticText(draft.diagnosticRecommendation),
    };
}

function sanitizeFinding(finding: Finding): Finding {
    return {
        ...sanitizeFindingDraft(finding),
        findingId: sanitizeIdentifier(finding.findingId),
    };
}

/** Defense in depth for externally supplied reports immediately before rendering. */
export function sanitizeReconciliationReport(report: ReconciliationReport): ReconciliationReport {
    return {
        contractVersion: '1.0',
        asOf: report.asOf,
        scope: {
            negocioId: report.scope.negocioId,
            ...(report.scope.sucursalId && { sucursalId: report.scope.sucursalId }),
            desde: report.scope.desde,
            hasta: report.scope.hasta,
            deviceLabels: report.scope.deviceLabels.map(sanitizeText),
        },
        overall: report.overall,
        sources: report.sources.map(source => ({
            ...source,
            sourceId: sanitizeIdentifier(source.sourceId),
            captureWindow: { ...source.captureWindow },
        })),
        coverage: report.coverage.map(item => ({
            ...item,
            scope: { ...item.scope, ...(item.scope.requestedIds && { requestedIds: [...item.scope.requestedIds] }) },
            ...(item.reason && { reason: sanitizeCoverageReason(item.reason) }),
        })),
        counts: {
            bySeverity: { ...report.counts.bySeverity },
            byCategory: { ...report.counts.byCategory },
            unverifiable: report.counts.unverifiable,
        },
        findings: report.findings.map(sanitizeFinding),
    };
}
