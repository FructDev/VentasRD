// src/lib/imagen.ts
// Compresión de imágenes en el navegador antes de subirlas a Cloudinary.

/**
 * Devuelve una versión miniatura optimizada de una URL de Cloudinary.
 * Inserta transformaciones (ancho fijo, formato y calidad automáticos) para
 * servir imágenes ~10x más livianas en WebP/AVIF. Si la URL no es de
 * Cloudinary, la devuelve tal cual.
 *
 * @param url   URL original (secure_url de Cloudinary)
 * @param ancho Ancho deseado en px (la altura se ajusta sola)
 */
export function miniatura(url: string | undefined, ancho = 120): string | undefined {
    if (!url) return url;
    const marca = '/upload/';
    const i = url.indexOf(marca);
    if (i === -1) return url; // no es una URL estándar de Cloudinary
    // Evitar duplicar transformaciones si ya las tiene
    const resto = url.slice(i + marca.length);
    if (resto.startsWith('w_') || resto.startsWith('c_') || resto.startsWith('f_')) return url;
    const t = `c_fill,w_${ancho},h_${ancho},f_auto,q_auto,dpr_2.0/`;
    return url.slice(0, i + marca.length) + t + resto;
}

/** Redimensiona y comprime una imagen a un data URL JPEG pequeño */
export function comprimirImagen(file: File, maxDim = 480): Promise<string> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            const escala = Math.min(1, maxDim / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * escala);
            canvas.height = Math.round(img.height * escala);
            const ctx = canvas.getContext('2d');
            if (!ctx) { reject(new Error('canvas')); return; }
            // Fondo blanco para PNGs transparentes
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img')); };
        img.src = url;
    });
}
