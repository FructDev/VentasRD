import {createProvisionHandler} from '@/lib/native-access/provision-handler';
import {stagingDependencies} from '@/lib/native-access/staging-dependencies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return createProvisionHandler(stagingDependencies(process.env))(request);
}
