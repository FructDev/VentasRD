export interface CatalogWindow { key: string; limit: number }

/** Derivación pura: cambiar de búsqueda/tenant nunca reutiliza una ventana anterior. */
export function catalogWindow(prior: CatalogWindow, key: string, pageSize: number): CatalogWindow {
    return prior.key === key ? prior : { key, limit: pageSize };
}

/** Un callback del observer anterior no puede ampliar la búsqueda actual. */
export function extendCatalogWindow(prior: CatalogWindow, key: string, count: number, pageSize: number): CatalogWindow {
    if (prior.key !== key || prior.limit >= count) return prior;
    return { key, limit: Math.min(prior.limit + pageSize, count) };
}
