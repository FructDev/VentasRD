import {downloadResponse} from '@/lib/native-release/catalogue';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export function GET(){return downloadResponse(process.env)}
