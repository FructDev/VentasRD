import Link from 'next/link';
import {Download,ShoppingCart} from 'lucide-react';
import {readDesktopRelease} from '@/lib/native-release/catalogue';
import {previewEnvironment} from '@/lib/native-release/local-preview';
export const dynamic='force-dynamic';
export default function DownloadPage(){
 const local=process.env.VENTARD_DESKTOP_LOCAL_PREVIEW==='1',release=readDesktopRelease(previewEnvironment(process.env));
 return <main className="min-h-screen bg-navy text-white px-6 py-12"><div className="max-w-2xl mx-auto">
  <Link href="/landing" className="inline-flex items-center gap-2 text-gold font-display font-extrabold text-xl"><ShoppingCart size={24}/>VentaRD</Link>
  <h1 className="font-display text-3xl font-extrabold mt-12">VentaRD para Windows</h1>
  {local&&<p role="note" className="mt-5 border border-gold/30 bg-gold/10 rounded-xl p-4 text-gold">Revisión local en este PC. El instalador aún no está publicado y Pica Chicken todavía no está habilitado para entrar desde esta entrega.</p>}
  <p className="text-vr-gray mt-4">Instala VentaRD en tu PC e inicia sesión con tu cuenta. Si ya tienes un negocio, utiliza esa misma cuenta para preparar sus datos en este equipo.</p>
  {release?<section className="mt-8 rounded-2xl border border-navy-3 bg-navy-2 p-6">
   <p className="font-bold">Versión {release.version} · Windows de 64 bits</p>
   <p className="text-vr-gray text-sm mt-3">{release.channel==='production'?'Entrega piloto: el acceso está limitado a los negocios habilitados para esta versión.':'Versión de pruebas: utiliza exclusivamente cuentas de Staging.'}</p>
   <a href="/api/native/download/windows-x86_64" className="inline-flex items-center gap-2 bg-gold text-navy font-bold rounded-xl px-6 py-3 mt-5"><Download size={20}/>Descargar VentaRD</a>
   <p className="text-vr-gray text-sm mt-4">Para actualizar una instalación existente, cierra VentaRD y ejecuta este instalador sin desinstalar antes. Conserva la instalación y sus datos.</p>
  </section>:<p role="status" className="mt-8 rounded-xl border border-gold/30 bg-gold/10 p-5 text-gold">La descarga para Windows todavía no está publicada. Puedes continuar usando VentaRD en la web.</p>}
  {!local&&<div className="flex flex-wrap gap-6 mt-8"><Link href="/login" className="text-gold font-bold">Entrar a mi cuenta</Link><Link href="/registro" className="text-vr-gray">Crear cuenta</Link></div>}
 </div></main>;
}
