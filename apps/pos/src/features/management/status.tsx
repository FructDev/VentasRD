import type {ManagementCommand} from '../../platform/management';
export function ManagementStatus({available,error,notice,busy,pending,retry}:{available:boolean;error:string;notice:string;busy:boolean;pending:ManagementCommand|null;retry:()=>Promise<unknown>}){
 return <>{!available&&<p role="status" className="bg-gold/5 text-vr-orange p-3 rounded-xl mb-4">La cuenta requiere preparación operativa para este módulo. Los datos de consulta o de prueba no habilitan escrituras.</p>}{error&&<p role="alert" className="text-vr-red p-3 mb-3 bg-vr-red/5 rounded-xl">{error}</p>}{notice&&<p role="status" className="text-vr-green text-sm mb-3">{notice}</p>}{pending&&<button disabled={busy} onClick={()=>void retry()} className="text-gold mb-3">Recuperar el mismo intento</button>}</>;
}
