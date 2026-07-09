// src/app/terminos/page.tsx — Términos de Servicio (página pública)
import PaginaLegal from '@/components/shared/PaginaLegal';

export const metadata = { title: 'Términos de Servicio — VentaRD' };

export default function TerminosPage() {
    return (
        <PaginaLegal titulo="Términos de Servicio" actualizado="julio 2026">
            <section>
                <h2>1. Qué es VentaRD</h2>
                <p>VentaRD es un sistema de punto de venta (POS) para negocios, que funciona en el navegador y como aplicación instalable, con capacidad de operar sin conexión a internet. Al crear una cuenta aceptas estos términos.</p>
            </section>
            <section>
                <h2>2. Tu cuenta y tu negocio</h2>
                <ul>
                    <li>Eres responsable de la veracidad de los datos de tu negocio y de mantener segura tu contraseña y tu PIN de administrador.</li>
                    <li>Puedes invitar empleados (cajeros, vendedores) bajo tu responsabilidad; lo que ellos registren cuenta como actividad de tu negocio.</li>
                    <li>Una cuenta corresponde a un negocio. Está prohibido crear cuentas múltiples para evadir los períodos de prueba.</li>
                </ul>
            </section>
            <section>
                <h2>3. Período de prueba y pago</h2>
                <ul>
                    <li>Toda cuenta nueva incluye un período de prueba gratis, sin tarjeta de crédito.</li>
                    <li>Al terminar la prueba, el acceso se activa mediante pago acordado directamente con nosotros (vía WhatsApp). No hay cobros automáticos ni cargos ocultos.</li>
                    <li>Si el acceso vence, la aplicación se bloquea pero <b>tus datos no se borran</b>: al reactivar, todo sigue donde lo dejaste.</li>
                </ul>
            </section>
            <section>
                <h2>4. Tus datos son tuyos</h2>
                <ul>
                    <li>Las ventas, productos, clientes y demás información que registras pertenecen a tu negocio, no a VentaRD.</li>
                    <li>Puedes exportar tu información (por ejemplo, tu inventario a Excel) mientras tu cuenta esté activa.</li>
                    <li>Si decides irte, puedes solicitar la eliminación definitiva de los datos de tu negocio escribiéndonos por WhatsApp.</li>
                </ul>
            </section>
            <section>
                <h2>5. Funcionamiento sin internet</h2>
                <p>VentaRD guarda información en tu dispositivo para operar sin conexión y la sincroniza con la nube cuando hay señal. Eres responsable de <b>no borrar los datos del navegador/app</b> mientras tengas ventas sin sincronizar, y de conectar el dispositivo a internet periódicamente.</p>
            </section>
            <section>
                <h2>6. Uso aceptable</h2>
                <p>No puedes usar VentaRD para actividades ilegales, intentar acceder a datos de otros negocios, ni manipular el sistema para evadir el pago del servicio. Nos reservamos el derecho de suspender cuentas que violen estos términos.</p>
            </section>
            <section>
                <h2>7. Disponibilidad y responsabilidad</h2>
                <p>Trabajamos para que el servicio esté disponible siempre, pero no garantizamos disponibilidad ininterrumpida del componente en la nube (la venta local funciona sin internet precisamente por eso). VentaRD es una herramienta de gestión: la responsabilidad fiscal y contable de tu negocio (incluyendo comprobantes NCF y reportes a la DGII) sigue siendo tuya.</p>
            </section>
            <section>
                <h2>8. Cambios a estos términos</h2>
                <p>Podemos actualizar estos términos; los cambios importantes se anunciarán dentro de la aplicación. El uso continuado del servicio después de un cambio constituye aceptación.</p>
            </section>
            <section>
                <h2>9. Contacto</h2>
                <p>Soporte y consultas: WhatsApp <a href="https://wa.me/18294515303" target="_blank" rel="noopener noreferrer">1 (829) 451-5303</a>. República Dominicana.</p>
            </section>
        </PaginaLegal>
    );
}
