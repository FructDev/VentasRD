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

/** Inline photo accepted by the existing native PNG contract (96 KiB/480px).
 * Re-encode smaller until it fits; never drop a selected offline photo. */
export async function comprimirImagenCompartida(file:File):Promise<string>{
 const url=URL.createObjectURL(file);
 try{const img=await new Promise<HTMLImageElement>((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(Error('SHARED_PHOTO_INVALID'));image.src=url});
  for(const size of [360,280,220,160,128]){const scale=Math.min(1,size/Math.max(img.width,img.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));const ctx=canvas.getContext('2d');if(!ctx)throw Error('SHARED_PHOTO_INVALID');ctx.drawImage(img,0,0,canvas.width,canvas.height);const result=canvas.toDataURL('image/png');if(result.startsWith('data:image/png;base64,')&&(result.length-22)*3/4<=98304)return result}
  throw Error('SHARED_PHOTO_TOO_LARGE');
 }finally{URL.revokeObjectURL(url)}
}
