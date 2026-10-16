interface RemotePage<T> {
    data: T[] | null;
    error: unknown;
    count: number | null;
}

/** Require ordered queries with count: 'exact'; never return partial coverage. */
export async function readCompletePages<T>(
    readPage: (from: number, to: number) => PromiseLike<RemotePage<T>>,
    identity: (row: T) => string,
    pageSize = 500,
): Promise<T[]> {
    if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('remote_page_size_invalid');
    const rows: T[] = [];
    const seen = new Set<string>();
    let expectedCount: number | undefined;
    for (let page = 0; page < 10_000; page++) {
        const response = await readPage(rows.length, rows.length + pageSize - 1);
        if (response.error || !response.data || response.count === null
            || !Number.isSafeInteger(response.count) || response.count < 0) {
            throw new Error('remote_catalog_incomplete');
        }
        expectedCount ??= response.count;
        if (response.count !== expectedCount) throw new Error('remote_catalog_incomplete');
        for (const row of response.data) {
            const id = identity(row);
            if (!id || seen.has(id)) throw new Error('remote_catalog_incomplete');
            seen.add(id);
            rows.push(row);
        }
        if (rows.length === expectedCount) return rows;
        if (rows.length > expectedCount || response.data.length === 0) throw new Error('remote_catalog_incomplete');
    }
    throw new Error('remote_catalog_incomplete');
}
