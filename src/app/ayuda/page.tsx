// src/app/ayuda/page.tsx — Centro de ayuda (página pública).
// Cada pregunta que se responde sola es un WhatsApp de soporte que no llega.
'use client';

import { useState } from 'react';
import PaginaLegal from '@/components/shared/PaginaLegal';

interface Faq { q: string; a: React.ReactNode; }
interface Seccion { titulo: string; emoji: string; faqs: Faq[]; }

const SECCIONES: Seccion[] = [
    {
        titulo: 'Primeros pasos', emoji: '🚀',
        faqs: [
            { q: '¿Cómo instalo VentaRD en mi celular o computadora?', a: <>Entra a la app desde Chrome y te aparecerá un aviso <b>&quot;📲 Instala VentaRD&quot;</b> — un toque y listo. En iPhone: abre la app en Safari, toca el botón Compartir ⬆️ y elige &quot;Añadir a pantalla de inicio&quot;.</> },
            { q: '¿Cómo agrego mis productos?', a: <>Ve a <b>Inventario → + Nuevo producto</b>. Si tienes muchos, usa <b>Inventario → 📥 Importar</b>: descarga la plantilla de Excel, llénala y súbela — cientos de productos en minutos.</> },
            { q: '¿Cómo hago mi primera venta?', a: <>En la pantalla principal busca el producto, tócalo para agregarlo al carrito, toca <b>Cobrar Venta</b>, elige cómo paga el cliente y confirma. Eso es todo.</> },
            { q: '¿Cómo invito a mi cajero o vendedor?', a: <>Ajustes → <b>Mi Equipo → + Agregar</b>. Se genera un link que le envías por WhatsApp; él pone su contraseña y entra con su propio usuario y permisos limitados.</> },
        ],
    },
    {
        titulo: 'Sin internet y sincronización', emoji: '📶',
        faqs: [
            { q: '¿Qué pasa si se va la luz o el internet?', a: <>Nada: sigues vendiendo normal. Todo se guarda en tu equipo y cuando vuelve la señal se sincroniza solo con la nube. Verás un contador de &quot;pendientes&quot; arriba mientras tanto.</> },
            { q: 'Tengo ventas pendientes de sincronizar hace rato, ¿qué hago?', a: <>Verifica que el dispositivo tenga internet de verdad (abre una página cualquiera). Si tiene y no baja el contador, ve a <b>Ajustes → 🩺 Estado del Sistema → 📋 Copiar diagnóstico</b> y envíanoslo por WhatsApp.</> },
            { q: '¿Puedo borrar los datos del navegador?', a: <><b>No lo hagas</b> si tienes ventas pendientes de sincronizar (contador arriba en cero = seguro). Borrar datos locales con pendientes puede perder esas ventas.</> },
            { q: '¿Puedo usar VentaRD en dos aparatos a la vez?', a: <>Sí. Inicia sesión en ambos y elige la sucursal. Cada caja tiene su propio código de tickets y el inventario se sincroniza entre ellas sin descuadrarse.</> },
        ],
    },
    {
        titulo: 'Fiados y clientes', emoji: '💰',
        faqs: [
            { q: '¿Cómo vendo fiao’?', a: <>En el cobro elige el método <b>Fiado</b> y selecciona el cliente. El sistema lleva su saldo solo. Los abonos se registran en <b>Clientes → el cliente → Registrar abono</b>.</> },
            { q: '¿Cómo le recuerdo a un cliente lo que debe?', a: <>En <b>Clientes</b>, abre el cliente y toca el botón de WhatsApp: se abre el chat con su estado de cuenta listo para enviar.</> },
            { q: '¿Puedo ponerle precio especial a un cliente?', a: <>Sí. Al editar el cliente asígnale <b>Precio 2 o Precio 3</b> (o márcalo &quot;al por mayor&quot;). Cuando lo elijas en el carrito, sus precios se aplican solos.</> },
        ],
    },
    {
        titulo: 'Caja e impresión', emoji: '🖨️',
        faqs: [
            { q: '¿Cómo abro y cierro la caja?', a: <>En la pantalla de ventas toca <b>💰 Caja</b>. Abre con el monto inicial (puede ser 0) y al cerrar cuenta el efectivo: el sistema te dice si sobra o falta, e imprime el corte.</> },
            { q: '¿Sirve con impresora térmica?', a: <>Sí, de 58mm y 80mm. Configúrala en <b>Ajustes → 🖨️ Impresión</b>: papel, letra grande, copias, corte automático e impresión directa. Usa &quot;Imprimir prueba&quot; para verificar.</> },
            { q: 'El logo no sale en el ticket', a: <>Sube el logo en Ajustes, activa &quot;mostrar logo&quot; en Impresión, y abre la app <b>una vez con internet</b> para que se guarde en el equipo. Después imprime con o sin señal.</> },
            { q: '¿Cómo pauso una venta para atender a otro cliente?', a: <>Con productos en el carrito toca <b>⏸ En espera</b>. El carrito queda libre para el siguiente; retomas la venta pausada tocándola en la lista de arriba.</> },
        ],
    },
    {
        titulo: 'Cuenta y pagos', emoji: '🔑',
        faqs: [
            { q: 'Olvidé mi contraseña', a: <>En la pantalla de inicio de sesión toca <b>¿Olvidaste tu contraseña?</b> y sigue el enlace que llega a tu correo. Si no llega, escríbenos por WhatsApp.</> },
            { q: '¿Cuánto cuesta VentaRD?', a: <>Plan <b>Básico: RD$900/mes</b> o RD$9,000/año (2 meses gratis). Plan <b>Pro</b> (reparaciones, garantías por IMEI y apartados): <b>RD$1,200/mes</b> o RD$12,000/año. La prueba inicial es gratis y sin tarjeta.</> },
            { q: '¿Cómo renuevo mi acceso?', a: <>Escríbenos por WhatsApp al <b>1 (829) 451-5303</b> — la reactivación toma menos de 5 minutos. Tus datos nunca se borran por vencimiento.</> },
            { q: '¿Cómo gano días gratis?', a: <>Ajustes → <b>🎁 Invita y Gana</b>: comparte tu link con otro negocio. Cuando complete su registro, ambos ganan <b>15 días</b>. Sin límite.</> },
        ],
    },
];

export default function AyudaPage() {
    const [abierta, setAbierta] = useState<string | null>(null);

    return (
        <PaginaLegal titulo="Centro de Ayuda">
            <p className="-mt-6 mb-2">Respuestas a las preguntas más comunes. ¿No encuentras la tuya? <a href="https://wa.me/18294515303?text=Hola%2C%20tengo%20una%20pregunta%20sobre%20VentaRD" target="_blank" rel="noopener noreferrer">Escríbenos por WhatsApp</a>.</p>
            {SECCIONES.map(sec => (
                <section key={sec.titulo}>
                    <h2>{sec.emoji} {sec.titulo}</h2>
                    <div className="space-y-2">
                        {sec.faqs.map(f => {
                            const abiertaEsta = abierta === f.q;
                            return (
                                <div key={f.q} className="bg-navy-2 border border-navy-3 rounded-xl overflow-hidden">
                                    <button
                                        onClick={() => setAbierta(abiertaEsta ? null : f.q)}
                                        className="w-full text-left px-4 py-3.5 flex items-center justify-between gap-3 hover:bg-navy-3/40 transition-colors"
                                    >
                                        <span className="text-sm font-bold text-white">{f.q}</span>
                                        <span className={`text-gold shrink-0 transition-transform ${abiertaEsta ? 'rotate-45' : ''}`}>＋</span>
                                    </button>
                                    {abiertaEsta && (
                                        <div className="px-4 pb-4 text-sm leading-relaxed animate-fade-in">{f.a}</div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </section>
            ))}
        </PaginaLegal>
    );
}
