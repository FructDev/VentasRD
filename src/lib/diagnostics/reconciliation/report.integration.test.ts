import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeReconciliation } from './analyze';
import { id, tenant } from './fixtures/local';
import { twoDevices } from './fixtures/two-devices';
import { createRemoteSnapshotHandler, type RemoteHandlerDeps } from './readers/remote-handler';
import { renderReportHuman, renderReportJson } from './render';

const temporaryDirectories: string[] = [];
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('T046 — aceptación del informe y runner de soporte', () => {
    it('genera el mismo informe sin mutar capturas y el runner solo renderiza el JSON existente', () => {
        const input = twoDevices({ remote: 'APPLIED', b: 'OLD' });
        input.snapshots[0].source.deviceLabel = 'PC dueno@tienda.example +1 809-555-0199';
        input.snapshots[0].coverage[0].reason = 'notas: cliente debe dinero';
        const before = JSON.stringify(input);
        const reportA = analyzeReconciliation(input);
        const reportB = analyzeReconciliation(input);
        const jsonA = renderReportJson(reportA);
        const jsonB = renderReportJson(reportB);

        expect(jsonA).toBe(jsonB);
        expect(JSON.stringify(input)).toBe(before);
        expect(jsonA).not.toMatch(/dueno@tienda\.example|809-555-0199|cliente debe dinero/);
        expect(jsonA).toContain('REDACTED_REASON');

        const directory = mkdtempSync(join(tmpdir(), 'ventard-report-'));
        temporaryDirectories.push(directory);
        const reportPath = join(directory, 'report.json');
        writeFileSync(reportPath, jsonA, 'utf8');
        const runnerPath = resolve('scripts/diagnostics/render-report.mjs');
        const output = execFileSync(process.execPath, [runnerPath, reportPath, '--human'], { encoding: 'utf8' });
        expect(output).toBe(renderReportHuman(reportA));

        const runnerSource = readFileSync(runnerPath, 'utf8');
        expect(runnerSource).not.toMatch(/from\s+['"][^'"]*(dexie|supabase|worker|sync)[^'"]*['"]/i);
        expect(runnerSource).not.toMatch(/\bfetch\s*\(/);
        expect(runnerSource).not.toMatch(/\b(writeFile|appendFile)\w*\s*\(/);
    });

    it('trata acceso remoto denegado como denegado y nunca ejecuta la consulta', async () => {
        let queryCalls = 0;
        const deps: RemoteHandlerDeps = {
            authenticate: async () => ({ id: id(90) }),
            role: async () => 'cajero',
            branchBelongs: async () => true,
            queryPage: async () => { queryCalls += 1; return { records: [], hasMore: false }; },
            rateLimited: () => false,
            now: () => 1_800_000_000_000,
            cursorSecret: 'test-only-secret',
        };
        const handler = createRemoteSnapshotHandler(deps);
        const request = new Request(`https://local.invalid/api/diagnostics?negocioId=${tenant}&entity=ventas&id=${id(20)}&asOf=1800000000000`, { headers: { authorization: 'Bearer fixture-token' } });

        const response = await handler(request);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'FORBIDDEN' });
        expect(queryCalls).toBe(0);
    });
});
