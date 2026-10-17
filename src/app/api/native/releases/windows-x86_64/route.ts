import {releaseResponse} from '@/lib/native-release/catalogue';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export function GET(){return releaseResponse(process.env)}
