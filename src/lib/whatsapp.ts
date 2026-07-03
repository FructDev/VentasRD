// src/lib/whatsapp.ts
// Enlaces a WhatsApp sin API (wa.me). En RD los números son de 10 dígitos y el
// código de país es 1; anteponemos "1" cuando falta. Si no hay teléfono válido
// se abre el selector de contacto de WhatsApp (solo con el texto).

/** Normaliza un teléfono dominicano a formato wa.me (solo dígitos, con país). */
export function telefonoWa(tel: string | null | undefined): string {
    const d = (tel || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.length === 10) return `1${d}`;        // 809/829/849 sin país
    if (d.length === 11 && d.startsWith('1')) return d; // ya trae el 1
    return d;                                    // internacional: dejar como viene
}

/** Arma el enlace wa.me con texto prellenado (y el destinatario si se conoce). */
export function linkWhatsApp(texto: string, tel?: string | null): string {
    const to = telefonoWa(tel);
    const base = to ? `https://wa.me/${to}` : 'https://wa.me/';
    return `${base}?text=${encodeURIComponent(texto)}`;
}
