// src/lib/exports/pdf.ts
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export interface PdfTabla {
    titulo: string;
    columnas: string[];
    filas: (string | number | null)[][];
    pieTabla?: string;
}

interface InfoNegocio {
    nombre: string;
    rnc?: string | null;
    direccion?: string | null;
}

/**
 * Genera y descarga un PDF con una o varias tablas.
 * Incluye encabezado del negocio y pie de página con fecha.
 */
export function descargarPdf(
    nombreArchivo: string,
    tablas: PdfTabla[],
    negocio: InfoNegocio,
    subtitulo?: string
) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margen = 14;
    const fecha = new Date().toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' });

    // ── Encabezado ───────────────────────────────────────────────────────────
    doc.setFillColor(15, 23, 42); // navy
    doc.rect(0, 0, pageW, 28, 'F');

    doc.setTextColor(212, 160, 23); // gold
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text(negocio.nombre.toUpperCase(), margen, 12);

    doc.setTextColor(148, 163, 184); // vr-gray
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    const infoLines = [
        negocio.rnc ? `RNC: ${negocio.rnc}` : null,
        negocio.direccion || null,
    ].filter(Boolean) as string[];
    if (infoLines.length) doc.text(infoLines.join('  ·  '), margen, 18);

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(9);
    doc.text(fecha, pageW - margen, 12, { align: 'right' });

    if (subtitulo) {
        doc.setFontSize(8);
        doc.setTextColor(212, 160, 23);
        doc.text(subtitulo, pageW - margen, 18, { align: 'right' });
    }

    // ── Tablas ───────────────────────────────────────────────────────────────
    let cursorY = 36;

    for (const tabla of tablas) {
        // Título de la tabla
        doc.setTextColor(15, 23, 42);
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.text(tabla.titulo, margen, cursorY);
        cursorY += 5;

        autoTable(doc, {
            startY: cursorY,
            head: [tabla.columnas],
            body: tabla.filas.map(f => f.map(v => v ?? '—')),
            margin: { left: margen, right: margen },
            styles: {
                fontSize: 8,
                cellPadding: 2.5,
                textColor: [15, 23, 42],
            },
            headStyles: {
                fillColor: [15, 23, 42],
                textColor: [212, 160, 23],
                fontStyle: 'bold',
                fontSize: 8,
            },
            alternateRowStyles: {
                fillColor: [248, 250, 252],
            },
            tableLineColor: [226, 232, 240],
            tableLineWidth: 0.1,
            didDrawPage: () => {
                // Pie de página en cada hoja
                doc.setFontSize(7);
                doc.setTextColor(148, 163, 184);
                doc.text(
                    `VentaRD POS · Generado el ${fecha} · Página ${doc.getCurrentPageInfo().pageNumber}`,
                    pageW / 2, pageH - 6, { align: 'center' }
                );
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cursorY = (doc as any).lastAutoTable.finalY + 10;

        if (tabla.pieTabla) {
            doc.setFontSize(8);
            doc.setFont('helvetica', 'italic');
            doc.setTextColor(100, 116, 139);
            doc.text(tabla.pieTabla, margen, cursorY);
            cursorY += 8;
        }
    }

    doc.save(`${nombreArchivo}.pdf`);
}
