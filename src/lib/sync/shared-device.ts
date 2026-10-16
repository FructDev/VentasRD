import type {SharedContext} from './shared-journal';
let current:SharedContext|null=null;
export function setSharedDeviceContext(context:SharedContext|null){current=context?structuredClone(context):null}
export function sharedTicketPrefix(tenantId:string|null,actorId:string|null,branchId:string|null):string|null{
 return current&&current.tenantId===tenantId&&current.actorId===actorId&&current.branchId===branchId?'N'+current.installationId.replaceAll('-',''):null;
}
