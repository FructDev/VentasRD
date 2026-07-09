// src/app/privacidad/page.tsx — Política de Privacidad (página pública)
import PaginaLegal from '@/components/shared/PaginaLegal';

export const metadata = { title: 'Política de Privacidad — VentaRD' };

export default function PrivacidadPage() {
    return (
        <PaginaLegal titulo="Política de Privacidad" actualizado="julio 2026">
            <section>
                <h2>1. Qué información guardamos</h2>
                <ul>
                    <li><b>De tu cuenta:</b> correo electrónico, nombre del negocio, teléfono y datos que completas en la configuración (RNC, dirección, logo).</li>
                    <li><b>De tu operación:</b> productos, ventas, gastos, clientes y sus saldos de crédito, reparaciones y apartados — lo que tu negocio registra para funcionar.</li>
                    <li><b>Técnica:</b> errores de la aplicación (para arreglarlos) y un identificador del dispositivo al registrarte (para prevenir abuso de los períodos de prueba).</li>
                </ul>
            </section>
            <section>
                <h2>2. Dónde se guarda</h2>
                <ul>
                    <li><b>En tu dispositivo:</b> una copia local para que la app funcione sin internet.</li>
                    <li><b>En la nube:</b> una copia sincronizada en servidores seguros (Supabase), para respaldo y para que varios dispositivos de tu negocio compartan la información.</li>
                    <li>Las imágenes (logo, fotos de productos) se almacenan en Cloudinary.</li>
                </ul>
            </section>
            <section>
                <h2>3. Datos de tus clientes finales</h2>
                <p>Si registras clientes (nombre, teléfono, saldo de fiado), tú eres el responsable de esa información frente a ellos. VentaRD solo la almacena para que tu negocio la gestione; <b>nunca la usamos para contactarlos ni la compartimos con terceros</b>.</p>
            </section>
            <section>
                <h2>4. Lo que NO hacemos</h2>
                <ul>
                    <li>No vendemos tu información ni la de tus clientes a nadie.</li>
                    <li>No usamos tus datos de ventas para nada distinto a operar el servicio.</li>
                    <li>No enviamos publicidad a tus clientes finales.</li>
                </ul>
            </section>
            <section>
                <h2>5. Catálogo público (opcional)</h2>
                <p>Si activas el catálogo público, los nombres, precios y fotos de tus productos serán visibles para cualquiera que tenga el link. Nunca se exponen tus costos, existencias ni datos de clientes. Puedes desactivarlo cuando quieras en Ajustes.</p>
            </section>
            <section>
                <h2>6. Seguridad</h2>
                <p>Usamos conexiones cifradas (HTTPS), aislamiento por negocio en la base de datos (un negocio jamás puede ver datos de otro) y controles de acceso por rol para tus empleados.</p>
            </section>
            <section>
                <h2>7. Tus derechos</h2>
                <p>Puedes pedir una copia de tus datos o su eliminación definitiva en cualquier momento escribiendo a nuestro WhatsApp de soporte. La eliminación es irreversible.</p>
            </section>
            <section>
                <h2>8. Contacto</h2>
                <p>WhatsApp <a href="https://wa.me/18294515303" target="_blank" rel="noopener noreferrer">1 (829) 451-5303</a>. República Dominicana.</p>
            </section>
        </PaginaLegal>
    );
}
