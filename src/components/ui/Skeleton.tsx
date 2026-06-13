// src/components/ui/Skeleton.tsx

/** Fila de tabla con celdas pulsantes — usar dentro de un <tbody> */
export function SkeletonTableRow({ cols = 5 }: { cols?: number }) {
    return (
        <tr>
            {Array.from({ length: cols }).map((_, i) => (
                <td key={i} className="p-4">
                    <div
                        className="h-4 bg-navy-3 rounded-md animate-pulse"
                        style={{ width: `${60 + ((i * 13) % 31)}%` }}
                    />
                </td>
            ))}
        </tr>
    );
}

/** Filas de skeleton para una tabla completa */
export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
    return (
        <>
            {Array.from({ length: rows }).map((_, i) => (
                <SkeletonTableRow key={i} cols={cols} />
            ))}
        </>
    );
}

/** Tarjeta de KPI pulsante */
export function SkeletonCard() {
    return (
        <div className="p-5 rounded-2xl border border-navy-3 bg-navy-2 animate-pulse">
            <div className="h-3 bg-navy-3 rounded w-1/2 mb-3" />
            <div className="h-7 bg-navy-3 rounded w-3/4 mb-1" />
            <div className="h-3 bg-navy-3 rounded w-1/3 mt-2" />
        </div>
    );
}

/** Grid de tarjetas de KPI skeleton */
export function SkeletonKPIGrid({ count = 4 }: { count?: number }) {
    return (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            {Array.from({ length: count }).map((_, i) => (
                <SkeletonCard key={i} />
            ))}
        </div>
    );
}

/** Producto card skeleton para el grid del POS */
export function SkeletonProductCard() {
    return (
        <div className="bg-navy-2 p-4 rounded-xl border border-navy-3 h-28 animate-pulse flex flex-col justify-between">
            <div className="h-4 bg-navy-3 rounded w-3/4" />
            <div className="flex justify-between items-end">
                <div className="h-5 bg-navy-3 rounded w-16" />
                <div className="h-3 bg-navy-3 rounded w-10" />
            </div>
        </div>
    );
}

/** Grid de product cards skeleton */
export function SkeletonProductGrid({ count = 12 }: { count?: number }) {
    return (
        <>
            {Array.from({ length: count }).map((_, i) => (
                <SkeletonProductCard key={i} />
            ))}
        </>
    );
}
