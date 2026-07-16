// src/lib/asistente.ts
// Motor del "Asistente del Negocio": reglas puras sobre los datos locales que
// generan insights en lenguaje de colmado. Sin IA de pago, sin servidor —
// corre en el dispositivo y funciona offline. El objetivo: decirle al dueño
// cosas que no sabía de su propio negocio.
import { formatDOP } from '@/lib/utils';

const DIA = 24 * 60 * 60 * 1000;
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export interface Insight {
    emoji: string;
    texto: string;
    /** menor = más importante */
    prioridad: number;
    tipo: 'ventas' | 'stock' | 'fiados' | 'patron' | 'estancado' | 'ganancia' | 'quincena' | 'compra' | 'anomalia' | 'horapico';
}

export interface DatosAsistente {
    /** Ventas de los últimos ~28 días (fecha_creacion en ms, total) */
    ventas: { total: number; fecha_creacion: number }[];
    /** Detalles de esas ventas (para velocidad de productos y ganancia) */
    detalles: { producto_id: string; cantidad: number; fecha_creacion: number; precio_unitario?: number }[];
    /** Catálogo actual (costo para márgenes y lista de compras) */
    productos: { id: string; nombre: string; stock_actual: number; tipo: string; eliminado?: boolean; costo?: number }[];
    /** Clientes con nombre */
    clientes: { id: string; nombre: string }[];
    /** Transacciones de fiado completas */
    transacciones: { cliente_id: string; tipo: string; monto: number; fecha_creacion: number }[];
    /** Reloj inyectado (testeable) */
    ahora: number;
}

const esMismoDia = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** Genera los insights del día, ordenados por prioridad. */
export function generarInsights(d: DatosAsistente): Insight[] {
    const out: Insight[] = [];
    const { ahora } = d;

    // ── 1. Ventas de ayer vs el mismo día de la semana pasada ────────────────
    const ayer = ahora - DIA;
    const mismoDiaSemPasada = ahora - 8 * DIA;
    const totalAyer = d.ventas.filter(v => esMismoDia(v.fecha_creacion, ayer)).reduce((s, v) => s + v.total, 0);
    const totalComparable = d.ventas.filter(v => esMismoDia(v.fecha_creacion, mismoDiaSemPasada)).reduce((s, v) => s + v.total, 0);
    if (totalAyer > 0 && totalComparable > 0) {
        const cambio = Math.round(((totalAyer - totalComparable) / totalComparable) * 100);
        if (Math.abs(cambio) >= 10) {
            out.push({
                emoji: cambio > 0 ? '📈' : '📉',
                texto: `Ayer vendiste ${formatDOP(totalAyer)} — ${Math.abs(cambio)}% ${cambio > 0 ? 'más' : 'menos'} que el ${DIAS_SEMANA[new Date(ayer).getDay()]} pasado.`,
                prioridad: cambio < 0 ? 2 : 3,
                tipo: 'ventas',
            });
        }
    } else if (totalAyer > 0) {
        out.push({ emoji: '💰', texto: `Ayer vendiste ${formatDOP(totalAyer)}.`, prioridad: 5, tipo: 'ventas' });
    }

    // ── 2. Productos por agotarse (velocidad de los últimos 14 días) ─────────
    const hace14d = ahora - 14 * DIA;
    const vendidoPorProducto = new Map<string, number>();
    for (const det of d.detalles) {
        if (det.fecha_creacion < hace14d) continue;
        vendidoPorProducto.set(det.producto_id, (vendidoPorProducto.get(det.producto_id) || 0) + det.cantidad);
    }
    const porAgotarse: { nombre: string; dias: number }[] = [];
    for (const p of d.productos) {
        if (p.eliminado || p.tipo === 'combo' || p.stock_actual <= 0) continue;
        const vendido14 = vendidoPorProducto.get(p.id) || 0;
        if (vendido14 < 3) continue; // sin velocidad real, no hay pronóstico serio
        const porDia = vendido14 / 14;
        const dias = p.stock_actual / porDia;
        if (dias <= 5) porAgotarse.push({ nombre: p.nombre, dias: Math.max(1, Math.round(dias)) });
    }
    porAgotarse.sort((a, b) => a.dias - b.dias);
    for (const p of porAgotarse.slice(0, 3)) {
        out.push({
            emoji: '⚠️',
            texto: `${p.nombre} se acaba en ~${p.dias} día${p.dias !== 1 ? 's' : ''} al ritmo actual. Repón a tiempo.`,
            prioridad: 1,
            tipo: 'stock',
        });
    }

    // ── 3. Fiados fríos: deuda con 30+ días sin ningún abono ─────────────────
    const porCliente = new Map<string, { deuda: number; ultimoMovimiento: number }>();
    for (const t of d.transacciones) {
        const acc = porCliente.get(t.cliente_id) || { deuda: 0, ultimoMovimiento: 0 };
        acc.deuda += t.tipo === 'cargo' ? t.monto : -t.monto;
        acc.ultimoMovimiento = Math.max(acc.ultimoMovimiento, t.fecha_creacion);
        porCliente.set(t.cliente_id, acc);
    }
    const frios: { nombre: string; deuda: number; dias: number }[] = [];
    for (const [clienteId, acc] of porCliente) {
        if (acc.deuda <= 0) continue;
        const dias = Math.floor((ahora - acc.ultimoMovimiento) / DIA);
        if (dias < 30) continue;
        const nombre = d.clientes.find(c => c.id === clienteId)?.nombre;
        if (nombre) frios.push({ nombre, deuda: acc.deuda, dias });
    }
    frios.sort((a, b) => b.deuda - a.deuda);
    if (frios.length === 1) {
        const f = frios[0];
        out.push({ emoji: '💸', texto: `${f.nombre} lleva ${f.dias} días sin moverse con una deuda de ${formatDOP(f.deuda)}. Mándale el recordatorio.`, prioridad: 2, tipo: 'fiados' });
    } else if (frios.length > 1) {
        const total = frios.reduce((s, f) => s + f.deuda, 0);
        out.push({
            emoji: '💸',
            texto: `${frios.length} clientes llevan 30+ días sin abonar — ${formatDOP(total)} en la calle. Los más grandes: ${frios.slice(0, 2).map(f => `${f.nombre} (${formatDOP(f.deuda)})`).join(', ')}.`,
            prioridad: 2,
            tipo: 'fiados',
        });
    }

    // ── 4. Tu mejor día de la semana (últimas 4 semanas) ─────────────────────
    const hace28d = ahora - 28 * DIA;
    const porDiaSemana = new Map<number, { total: number; dias: Set<string> }>();
    for (const v of d.ventas) {
        if (v.fecha_creacion < hace28d) continue;
        const fecha = new Date(v.fecha_creacion);
        const acc = porDiaSemana.get(fecha.getDay()) || { total: 0, dias: new Set<string>() };
        acc.total += v.total;
        acc.dias.add(fecha.toDateString());
        porDiaSemana.set(fecha.getDay(), acc);
    }
    let mejor: { dia: number; promedio: number } | null = null;
    for (const [dia, acc] of porDiaSemana) {
        const promedio = acc.total / acc.dias.size;
        if (acc.dias.size >= 2 && (!mejor || promedio > mejor.promedio)) mejor = { dia, promedio };
    }
    if (mejor && porDiaSemana.size >= 4) {
        out.push({
            emoji: '🏆',
            texto: `El ${DIAS_SEMANA[mejor.dia]} es tu mejor día — promedias ${formatDOP(Math.round(mejor.promedio))}. Prepárate con inventario y cambio.`,
            prioridad: 4,
            tipo: 'patron',
        });
    }

    // ── 5. Productos estancados: con stock y 21+ días sin venderse ───────────
    const hace21d = ahora - 21 * DIA;
    const vendidosReciente = new Set(d.detalles.filter(x => x.fecha_creacion >= hace21d).map(x => x.producto_id));
    // Solo si el negocio tiene historial suficiente (evita falsos positivos en cuentas nuevas)
    const tieneHistorial = d.ventas.some(v => v.fecha_creacion < hace21d);
    if (tieneHistorial) {
        const estancados = d.productos.filter(p =>
            !p.eliminado && p.tipo !== 'insumo' && p.stock_actual > 0 && !vendidosReciente.has(p.id)
        );
        if (estancados.length >= 3) {
            out.push({
                emoji: '🔻',
                texto: `${estancados.length} productos llevan 3+ semanas sin venderse (ej: ${estancados.slice(0, 2).map(p => p.nombre).join(', ')}). Una oferta los mueve.`,
                prioridad: 6,
                tipo: 'estancado',
            });
        }
    }

    // ── 6. Anomalía de HOY: vas muy por debajo de tu ritmo normal ────────────
    const horaActual = new Date(ahora).getHours();
    if (horaActual >= 12) { // con media mañana no hay señal seria
        const hoyStr = new Date(ahora).toDateString();
        const diaSemanaHoy = new Date(ahora).getDay();
        const ventasHoy = d.ventas
            .filter(v => esMismoDia(v.fecha_creacion, ahora) && new Date(v.fecha_creacion).getHours() <= horaActual)
            .reduce((s, v) => s + v.total, 0);
        // Mismos días de semana previos, acumulado hasta la misma hora
        const parciales: number[] = [];
        for (let semana = 1; semana <= 4; semana++) {
            const fecha = ahora - semana * 7 * DIA;
            if (new Date(fecha).getDay() !== diaSemanaHoy) continue;
            const parcial = d.ventas
                .filter(v => esMismoDia(v.fecha_creacion, fecha) && new Date(v.fecha_creacion).getHours() <= horaActual)
                .reduce((s, v) => s + v.total, 0);
            if (parcial > 0) parciales.push(parcial);
        }
        if (parciales.length >= 2) {
            const promedio = parciales.reduce((s, x) => s + x, 0) / parciales.length;
            if (promedio >= 1000 && ventasHoy < promedio * 0.5) {
                out.push({
                    emoji: '🚨',
                    texto: `Hoy llevas ${formatDOP(ventasHoy)} — normalmente a esta hora un ${DIAS_SEMANA[diaSemanaHoy]} llevas ~${formatDOP(Math.round(promedio))}. ¿Todo bien en el negocio?`,
                    prioridad: 0,
                    tipo: 'anomalia',
                });
            }
        }
        void hoyStr;
    }

    // ── 7. Ganancia y margen de la semana (necesita costos registrados) ──────
    const hace7d = ahora - 7 * DIA;
    const costoPorProducto = new Map(d.productos.map(p => [p.id, p.costo ?? 0]));
    const calcSemana = (desde: number, hasta: number) => {
        let venta = 0, ganancia = 0, conCosto = 0, lineas = 0;
        for (const det of d.detalles) {
            if (det.fecha_creacion < desde || det.fecha_creacion >= hasta || det.precio_unitario == null) continue;
            const costo = costoPorProducto.get(det.producto_id) ?? 0;
            venta += det.precio_unitario * det.cantidad;
            ganancia += (det.precio_unitario - costo) * det.cantidad;
            lineas++;
            if (costo > 0) conCosto++;
        }
        return { venta, ganancia, margen: venta > 0 ? ganancia / venta : 0, lineas, conCosto };
    };
    const estaSemana = calcSemana(hace7d, ahora);
    const semanaPasada = calcSemana(ahora - 14 * DIA, hace7d);
    // Solo si la mayoría de lo vendido tiene costo registrado (si no, el margen es mentira)
    if (estaSemana.lineas >= 10 && estaSemana.conCosto / estaSemana.lineas >= 0.6) {
        if (semanaPasada.venta > 0) {
            const puntosMargen = Math.round((estaSemana.margen - semanaPasada.margen) * 100);
            if (Math.abs(puntosMargen) >= 3) {
                out.push({
                    emoji: puntosMargen < 0 ? '📉' : '💚',
                    texto: `Tu ganancia de la semana: ${formatDOP(Math.round(estaSemana.ganancia))} (margen ${Math.round(estaSemana.margen * 100)}%) — ${Math.abs(puntosMargen)} punto${Math.abs(puntosMargen) !== 1 ? 's' : ''} ${puntosMargen < 0 ? 'menos' : 'más'} que la semana pasada.`,
                    prioridad: puntosMargen < 0 ? 2 : 4,
                    tipo: 'ganancia',
                });
            } else {
                out.push({
                    emoji: '💚',
                    texto: `Ganancia de la semana: ${formatDOP(Math.round(estaSemana.ganancia))} (margen ${Math.round(estaSemana.margen * 100)}%).`,
                    prioridad: 5,
                    tipo: 'ganancia',
                });
            }
        }
    }

    // ── 8. Quincena dominicana: los días 15 y 30 la gente cobra ──────────────
    const manana = new Date(ahora + DIA);
    const diaManana = manana.getDate();
    const ultimoDiaMes = new Date(manana.getFullYear(), manana.getMonth() + 1, 0).getDate();
    const esQuincenaManana = diaManana === 15 || diaManana === 30 || (diaManana === ultimoDiaMes && ultimoDiaMes < 30);
    if (esQuincenaManana) {
        // Comparar venta de días de quincena (15/30±1) vs días normales del historial
        let ventaQ = 0, diasQ = new Set<string>(), ventaN = 0, diasN = new Set<string>();
        for (const v of d.ventas) {
            const f = new Date(v.fecha_creacion);
            const dd = f.getDate();
            const esQ = dd >= 15 && dd <= 16 || dd >= 30 || dd === 1;
            if (esQ) { ventaQ += v.total; diasQ.add(f.toDateString()); }
            else { ventaN += v.total; diasN.add(f.toDateString()); }
        }
        const promQ = diasQ.size > 0 ? ventaQ / diasQ.size : 0;
        const promN = diasN.size > 0 ? ventaN / diasN.size : 0;
        const uplift = promN > 0 ? Math.round(((promQ - promN) / promN) * 100) : 0;
        out.push({
            emoji: '🗓️',
            texto: uplift >= 15
                ? `Mañana es quincena — esos días vendes ~${uplift}% más de lo normal. Prepara inventario y cambio.`
                : 'Mañana es quincena: día de cobro. Prepara inventario y cambio en caja.',
            prioridad: 2,
            tipo: 'quincena',
        });
    }

    // ── 9. Lista de compras sugerida (para cubrir los próximos 15 días) ──────
    const compras: { nombre: string; cantidad: number; costo: number }[] = [];
    for (const p of d.productos) {
        if (p.eliminado || p.tipo === 'combo') continue;
        const vendido14 = vendidoPorProducto.get(p.id) || 0;
        if (vendido14 < 3) continue;
        const necesidad = Math.ceil((vendido14 / 14) * 15 - p.stock_actual);
        if (necesidad <= 0) continue;
        compras.push({ nombre: p.nombre, cantidad: necesidad, costo: (p.costo ?? 0) * necesidad });
    }
    if (compras.length >= 2) {
        compras.sort((a, b) => b.costo - a.costo);
        const totalCompra = compras.reduce((s, c) => s + c.costo, 0);
        const top = compras.slice(0, 3).map(c => `${c.cantidad} ${c.nombre}`).join(', ');
        out.push({
            emoji: '🛒',
            texto: `Compra sugerida para 15 días: ${top}${compras.length > 3 ? ` y ${compras.length - 3} más` : ''}${totalCompra > 0 ? ` — inversión estimada ${formatDOP(Math.round(totalCompra))}` : ''}.`,
            prioridad: 3,
            tipo: 'compra',
        });
    }

    // ── 10. Tu hora fuerte del día ────────────────────────────────────────────
    if (d.ventas.length >= 40) {
        const porHora = new Map<number, number>();
        for (const v of d.ventas) {
            const h = new Date(v.fecha_creacion).getHours();
            porHora.set(h, (porHora.get(h) || 0) + v.total);
        }
        const totalGlobal = d.ventas.reduce((s, v) => s + v.total, 0);
        let mejorHora = -1, mejorMonto = 0;
        for (const [h, monto] of porHora) {
            if (monto > mejorMonto) { mejorHora = h; mejorMonto = monto; }
        }
        // Ventana de 2 horas alrededor de la mejor
        const ventana = mejorMonto + (porHora.get(mejorHora + 1) || 0);
        if (mejorHora >= 0 && ventana / totalGlobal >= 0.3) {
            const fmt12 = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
            out.push({
                emoji: '⏰',
                texto: `Tu hora fuerte es de ${fmt12(mejorHora)} a ${fmt12(mejorHora + 2)} — ahí se concentra ${Math.round((ventana / totalGlobal) * 100)}% de tu venta. No la cubras corto de personal.`,
                prioridad: 5,
                tipo: 'horapico',
            });
        }
    }

    return out.sort((a, b) => a.prioridad - b.prioridad);
}

/** Formatea los insights como texto para compartir por WhatsApp. */
export function insightsParaWhatsApp(insights: Insight[], negocioNombre: string, ahora: number): string {
    const fecha = new Date(ahora).toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long' });
    return `🧠 *Tu día — ${negocioNombre}*\n_${fecha}_\n\n` +
        insights.map(i => `${i.emoji} ${i.texto}`).join('\n\n') +
        '\n\n_Generado por VentaRD_';
}
