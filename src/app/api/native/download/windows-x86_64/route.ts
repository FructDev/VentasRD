import {downloadResponse} from '@/lib/native-release/catalogue';
import {localDownload} from '@/lib/native-release/local-preview';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){return await localDownload(process.env,request)??downloadResponse(process.env)}
