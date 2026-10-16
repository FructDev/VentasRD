export interface CatalogItemIdentity {
    id: string;
}

/**
 * Fuse conserva la referencia al objeto con el que se construyo el indice.
 * El indice puede seguir siendo valido aunque cambie stock/precio, pero la UI
 * siempre debe recibir la version mas reciente del producto.
 */
export function resolveCurrentCatalogMatches<T extends CatalogItemIdentity>(
    indexedMatches: readonly T[],
    currentItems: readonly T[],
): T[] {
    const currentById = new Map(currentItems.map(item => [item.id, item]));

    return indexedMatches.flatMap(item => {
        const current = currentById.get(item.id);
        return current ? [current] : [];
    });
}
