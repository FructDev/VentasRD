// src/components/TicketCorte.tsx
import { forwardRef } from 'react';
import { CorteCajaLocal } from '@/types/database';
import { useConfigStore } from '@/store/useConfigStore';

export interface ProductoCorte {
    nombre: string;
    cantidad: number;
    subtotal: number;
}

interface TicketCorteProps {
    corte: CorteCajaLocal;
    productos: ProductoCorte[];
    nombreNegocio?: string;
    rnc?: string;
    direccion?: string;
    telefono?: string;
}

export const TicketCorte = forwardRef<HTMLDivElement, TicketCorteProps>(({
    corte, productos, nombreNegocio = 'Mi Negocio', rnc, direccion, telefono,
}, ref) => {
    const { impresion } = useConfigStore();
    const fecha = new Date(corte.fecha_creacion).toLocaleString('es-DO');
    const esZ = corte.tipo === 'Z';
    const es58 = impresion.anchoPapel === '58mm';
    const claseTicket = [
        impresion.tamanoLetra === 'grande' ? 'ticket-grande' : '',
        impresion.densidad === 'compacta' ? 'ticket-compacto' : '',
    ].join(' ');

    const fmtDOP = (n: number) =>
        n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const metodos: { label: string; valor: number }[] = [
        { label: 'Efectivo',      valor: corte.efectivo       },
        { label: 'Tarjeta',       valor: corte.tarjeta        },
        { label: 'Transferencia', valor: corte.transferencia  },
        { label: 'Fiado',         valor: corte.fiado          },
        { label: 'Mixto',         valor: corte.mixto          },
    ].filter(l => l.valor > 0);

    return (
        <div className={`hidden print:block font-mono text-sm text-black ${claseTicket}`} ref={ref} style={{ width: impresion.anchoPapel, padding: es58 ? '4px' : '10px' }}>

            {/* Cabecera */}
            <div className="text-center mb-3">
                <h1 className="text-lg font-bold uppercase">{nombreNegocio}</h1>
                {rnc && <p className="text-xs">RNC: {rnc}</p>}
                {direccion && <p className="text-xs">{direccion}</p>}
                {telefono && <p className="text-xs">Tel: {telefono}</p>}
                <p className="text-xs mt-1">{fecha}</p>
            </div>

            <div className="border-b border-dashed border-black mb-2" />

            {/* Tipo */}
            <div className="text-center mb-3">
                <p className="text-base font-bold uppercase tracking-widest">
                    {esZ ? 'CIERRE DE CAJA' : 'CORTE PARCIAL'}
                </p>
            </div>

            <div className="border-b border-dashed border-black mb-2" />

            {/* Productos vendidos */}
            <p className="text-xs font-bold uppercase tracking-wider mb-1">Productos vendidos</p>
            {productos.length === 0 ? (
                <p className="text-xs text-gray-500 mb-2 text-center">Sin ventas en este turno</p>
            ) : (
                <table className="w-full text-xs mb-2">
                    <thead>
                        <tr className="border-b border-dashed border-black">
                            <th className="py-0.5 text-left font-bold">Producto</th>
                            <th className="py-0.5 text-center font-bold">Cant</th>
                            <th className="py-0.5 text-right font-bold">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {productos.map((p, i) => (
                            <tr key={i}>
                                <td className="py-0.5 pr-1 break-words">{p.nombre}</td>
                                <td className="py-0.5 text-center">{p.cantidad}</td>
                                <td className="py-0.5 text-right">{fmtDOP(p.subtotal)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            <div className="border-b border-dashed border-black mb-2" />

            {/* Desglose por método */}
            <p className="text-xs font-bold uppercase tracking-wider mb-1">Por método de pago</p>
            <table className="w-full text-xs mb-2">
                <tbody>
                    {metodos.map(m => (
                        <tr key={m.label}>
                            <td className="py-0.5">{m.label}</td>
                            <td className="py-0.5 text-right font-bold">RD$ {fmtDOP(m.valor)}</td>
                        </tr>
                    ))}
                    {metodos.length === 0 && (
                        <tr><td colSpan={2} className="text-center py-1 text-gray-500">—</td></tr>
                    )}
                </tbody>
            </table>

            <div className="border-b border-dashed border-black mb-2" />

            {/* Total y conteo */}
            <div className="flex justify-between font-bold text-sm mb-0.5">
                <span>TOTAL VENTAS</span>
                <span>RD$ {fmtDOP(corte.total_ventas)}</span>
            </div>
            <div className="flex justify-between text-xs text-gray-600 mb-3">
                <span>Transacciones</span>
                <span>{corte.cantidad_transacciones}</span>
            </div>

            {/* Cuadre — solo en cierre */}
            {esZ && corte.monto_apertura != null && (
                <>
                    <div className="border-b border-dashed border-black mb-2" />
                    <p className="text-xs font-bold uppercase tracking-wider mb-1">Cuadre de caja</p>
                    <table className="w-full text-xs mb-2">
                        <tbody>
                            <tr>
                                <td className="py-0.5">Apertura</td>
                                <td className="py-0.5 text-right">RD$ {fmtDOP(corte.monto_apertura!)}</td>
                            </tr>
                            <tr>
                                <td className="py-0.5">Efectivo esperado</td>
                                <td className="py-0.5 text-right">RD$ {fmtDOP(corte.monto_esperado ?? 0)}</td>
                            </tr>
                            <tr>
                                <td className="py-0.5">Efectivo contado</td>
                                <td className="py-0.5 text-right font-bold">RD$ {fmtDOP(corte.monto_contado ?? 0)}</td>
                            </tr>
                        </tbody>
                    </table>
                    <div className="text-center font-bold text-sm py-1 border border-dashed border-black">
                        {(corte.diferencia ?? 0) === 0
                            ? '✓ CUADRE PERFECTO'
                            : (corte.diferencia ?? 0) > 0
                                ? `↑ SOBRANTE: RD$ ${fmtDOP(Math.abs(corte.diferencia ?? 0))}`
                                : `↓ FALTANTE: RD$ ${fmtDOP(Math.abs(corte.diferencia ?? 0))}`}
                    </div>
                </>
            )}

            <div className="text-center mt-4 text-xs text-gray-500">
                <p>VentaRD POS</p>
            </div>
        </div>
    );
});

TicketCorte.displayName = 'TicketCorte';
