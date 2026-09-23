#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderReportHumanCore, stableJsonStringify } from '../../src/lib/diagnostics/reconciliation/render-core.mjs';

function usage() {
    throw new Error('Uso: node scripts/diagnostics/render-report.mjs <informe.json> [--human|--json]');
}

function assertGeneratedReport(value) {
    if (!value || typeof value !== 'object' || value.contractVersion !== '1.0') throw new Error('UNSUPPORTED_REPORT_CONTRACT');
    if (!Number.isSafeInteger(value.asOf) || !value.scope || !Array.isArray(value.sources) || !Array.isArray(value.coverage) || !value.counts || !Array.isArray(value.findings)) throw new Error('INVALID_GENERATED_REPORT');
    const serialized = JSON.stringify(value);
    if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(serialized)
        || /\b\d{15}\b/.test(serialized)
        || /(?<!\d)(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}(?!\d)/.test(serialized)
        || /"(?:authorization|password|pin|token|imei|email|phone|notes?)"\s*:/i.test(serialized)) throw new Error('UNSANITIZED_REPORT');
    return value;
}

const [, , inputPath, format = '--human', ...extra] = process.argv;
if (!inputPath || extra.length || !['--human', '--json'].includes(format)) usage();

const raw = await readFile(resolve(inputPath), 'utf8');
const report = assertGeneratedReport(JSON.parse(raw));
process.stdout.write(format === '--json' ? stableJsonStringify(report) : renderReportHumanCore(report));
