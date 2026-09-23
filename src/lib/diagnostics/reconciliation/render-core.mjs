function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    }
    return value;
}

export function stableJsonStringify(value) {
    return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function idsText(ids) {
    const order = ['saleId', 'productId', 'movementId', 'cashId', 'refundId', 'operationId'];
    const entries = order.flatMap(key => Object.hasOwn(ids, key) ? [[key, ids[key]]] : []);
    return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(', ') : 'sin identificadores';
}

function evidenceText(item) {
    const field = item.field ? ` | ${item.field}${Object.hasOwn(item, 'observedValue') ? `=${String(item.observedValue)}` : ''}` : '';
    return `${item.sourceId} | ${item.entity}/${item.id}${field} | ${item.coverageStatus} | captura=${item.capturedAt}`;
}

export function renderReportHumanCore(report) {
    const lines = [
        'INFORME DIAGNÓSTICO VENTARD — contrato 1.0',
        `asOf: ${report.asOf}`,
        `Ámbito: negocio=${report.scope.negocioId} | sucursal=${report.scope.sucursalId ?? 'todas'} | desde=${report.scope.desde} | hasta=${report.scope.hasta}`,
        `Dispositivos conocidos: ${report.scope.deviceLabels.length ? report.scope.deviceLabels.join(', ') : 'no identificados'}`,
        `Resultado: ${report.overall}`,
        '',
        'FUENTES',
        ...report.sources.map(source => `- ${source.sourceId} (${source.kind}) | ${source.captureWindow.startedAt}..${source.captureWindow.finishedAt} | cobertura=${source.coverageSummary}`),
        '',
        'RESUMEN',
        `- Severidad: CRITICAL=${report.counts.bySeverity.CRITICAL}, ERROR=${report.counts.bySeverity.ERROR}, WARNING=${report.counts.bySeverity.WARNING}, INFO=${report.counts.bySeverity.INFO}`,
        `- No verificables: ${report.counts.unverifiable}`,
        `- Cobertura: COMPLETE=${report.coverage.filter(item => item.status === 'COMPLETE').length}, PARTIAL=${report.coverage.filter(item => item.status === 'PARTIAL').length}, UNAVAILABLE=${report.coverage.filter(item => item.status === 'UNAVAILABLE').length}, DENIED=${report.coverage.filter(item => item.status === 'DENIED').length}`,
        '',
        'HALLAZGOS',
    ];

    if (!report.findings.length) lines.push('- Ninguno con la evidencia disponible.');
    report.findings.forEach((finding, index) => {
        lines.push(
            `${index + 1}. [${finding.severity}] ${finding.code} — ${finding.entity}`,
            `   findingId: ${finding.findingId}`,
            `   Identificadores: ${idsText(finding.ids)}`,
            `   Estado: ${finding.verificability}${finding.interpretedSyncState ? ` | sync=${finding.interpretedSyncState}` : ''}${finding.stage ? ` | etapa=${finding.stage}` : ''}`,
            `   Explicación: ${finding.explanation}`,
        );
        for (const item of finding.localEvidence) lines.push(`   Evidencia local: ${evidenceText(item)}`);
        for (const item of finding.remoteEvidence) lines.push(`   Evidencia remota: ${evidenceText(item)}`);
        lines.push(`   Evidencia faltante: ${finding.missingEvidence.length ? finding.missingEvidence.join(', ') : 'ninguna declarada'}`);
        lines.push(`   Siguiente verificación diagnóstica: ${finding.diagnosticRecommendation}`);
    });

    lines.push(
        '',
        'LÍMITES',
        '- Este informe describe únicamente las capturas y coberturas incluidas.',
        '- Un estado no verificable no confirma ausencia remota ni inconsistencia definitiva.',
        '- El informe no ejecuta correcciones, sincronización ni reintentos.',
        '',
    );
    return lines.join('\n');
}
