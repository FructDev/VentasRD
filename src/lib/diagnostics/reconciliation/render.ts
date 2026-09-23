import { sanitizeReconciliationReport } from './privacy';
import { renderReportHumanCore, stableJsonStringify } from './render-core.mjs';
import { parseReconciliationReport } from './schema';
import type { ReconciliationReport } from './types';

function safeReport(report: ReconciliationReport): ReconciliationReport {
    return parseReconciliationReport(sanitizeReconciliationReport(parseReconciliationReport(report)));
}

export function renderReportJson(report: ReconciliationReport): string {
    return stableJsonStringify(safeReport(report));
}

export function renderReportHuman(report: ReconciliationReport): string {
    return renderReportHumanCore(safeReport(report));
}
