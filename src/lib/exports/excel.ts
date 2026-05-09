// src/lib/exports/excel.ts
import * as XLSX from 'xlsx';

export interface ExcelSheet {
    nombre: string;
    columnas: string[];
    filas: (string | number | null)[][];
}

/**
 * Genera y descarga un archivo .xlsx con múltiples hojas.
 */
export function descargarExcel(nombreArchivo: string, hojas: ExcelSheet[]) {
    const wb = XLSX.utils.book_new();

    for (const hoja of hojas) {
        const data = [hoja.columnas, ...hoja.filas];
        const ws = XLSX.utils.aoa_to_sheet(data);

        // Ancho de columnas automático
        const colWidths = hoja.columnas.map((col, i) => {
            const maxContent = Math.max(
                col.length,
                ...hoja.filas.map(f => String(f[i] ?? '').length)
            );
            return { wch: Math.min(maxContent + 2, 40) };
        });
        ws['!cols'] = colWidths;

        // Estilo de encabezado (negrita)
        hoja.columnas.forEach((_, i) => {
            const cellRef = XLSX.utils.encode_cell({ r: 0, c: i });
            if (ws[cellRef]) {
                ws[cellRef].s = { font: { bold: true } };
            }
        });

        XLSX.utils.book_append_sheet(wb, ws, hoja.nombre.slice(0, 31));
    }

    XLSX.writeFile(wb, `${nombreArchivo}.xlsx`);
}
