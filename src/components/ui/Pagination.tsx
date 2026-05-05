// src/components/ui/Pagination.tsx

interface PaginationProps {
    pagina: number;
    totalPaginas: number;
    onCambiar: (p: number) => void;
    totalItems: number;
    itemsPorPagina: number;
}

export default function Pagination({ pagina, totalPaginas, onCambiar, totalItems, itemsPorPagina }: PaginationProps) {
    if (totalPaginas <= 1) return null;

    const desde = (pagina - 1) * itemsPorPagina + 1;
    const hasta = Math.min(pagina * itemsPorPagina, totalItems);

    // Genera rangos de páginas con elipsis
    const pages: (number | '...')[] = [];
    if (totalPaginas <= 7) {
        for (let i = 1; i <= totalPaginas; i++) pages.push(i);
    } else {
        pages.push(1);
        if (pagina > 3) pages.push('...');
        for (let i = Math.max(2, pagina - 1); i <= Math.min(totalPaginas - 1, pagina + 1); i++) pages.push(i);
        if (pagina < totalPaginas - 2) pages.push('...');
        pages.push(totalPaginas);
    }

    return (
        <div className="flex items-center justify-between px-4 py-3 border-t border-navy-3">
            <p className="text-xs text-vr-gray">
                Mostrando <span className="font-bold text-white">{desde}–{hasta}</span> de <span className="font-bold text-white">{totalItems}</span>
            </p>
            <div className="flex items-center gap-1">
                <button
                    onClick={() => onCambiar(pagina - 1)}
                    disabled={pagina === 1}
                    className="px-3 py-1.5 rounded-lg text-sm font-bold text-vr-gray hover:text-white hover:bg-navy-3 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                    ‹
                </button>
                {pages.map((p, i) =>
                    p === '...' ? (
                        <span key={`ellipsis-${i}`} className="px-2 text-vr-gray text-sm">…</span>
                    ) : (
                        <button
                            key={p}
                            onClick={() => onCambiar(p as number)}
                            className={`w-8 h-8 rounded-lg text-sm font-bold transition-all ${
                                p === pagina
                                    ? 'bg-gold/15 text-gold border border-gold/30'
                                    : 'text-vr-gray hover:text-white hover:bg-navy-3'
                            }`}
                        >
                            {p}
                        </button>
                    )
                )}
                <button
                    onClick={() => onCambiar(pagina + 1)}
                    disabled={pagina === totalPaginas}
                    className="px-3 py-1.5 rounded-lg text-sm font-bold text-vr-gray hover:text-white hover:bg-navy-3 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                    ›
                </button>
            </div>
        </div>
    );
}
