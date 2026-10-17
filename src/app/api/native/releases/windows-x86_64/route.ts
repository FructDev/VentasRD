import {releaseResponse} from '@/lib/native-release/catalogue';
import {previewEnvironment} from '@/lib/native-release/local-preview';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export function GET(){return releaseResponse(previewEnvironment(process.env))}
