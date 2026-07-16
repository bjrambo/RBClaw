import { timingSafeEqual } from 'crypto';

import { listAvailableGroups } from './available-groups.js';
import type { RegisteredGroup } from './types.js';

type JsonResponse = (
  value: unknown,
  init?: ResponseInit,
  request?: Request,
) => Response;

interface AvailableGroupsRouteContext {
  url: URL;
  request: Request;
  jsonResponse: JsonResponse;
  loadRoomBindings?: () => Record<string, RegisteredGroup>;
  authToken?: string;
  now?: () => string;
}

function extractDashboardAuthToken(request: Request): string {
  const authorization = request.headers.get('authorization')?.trim() ?? '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1]!.trim();
  return request.headers.get('x-rbclaw-dashboard-token')?.trim() ?? '';
}

function safeTokenEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

function isAuthorized(request: Request, authToken: string): boolean {
  const actual = extractDashboardAuthToken(request);
  return Boolean(actual) && safeTokenEquals(actual, authToken);
}

export function handleAvailableGroupsRoute({
  url,
  request,
  jsonResponse,
  loadRoomBindings,
  authToken,
  now,
}: AvailableGroupsRouteContext): Response | null {
  if (url.pathname !== '/api/available-groups') return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
  }
  if (!authToken) {
    return jsonResponse(
      { error: 'WEB_DASHBOARD_TOKEN is required for available groups route' },
      { status: 503 },
    );
  }
  if (!isAuthorized(request, authToken)) {
    return jsonResponse(
      { error: 'Unauthorized' },
      {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      },
    );
  }

  const roomBindings = loadRoomBindings?.() ?? {};
  return jsonResponse({
    groups: listAvailableGroups(roomBindings),
    lastSync: now?.() ?? new Date().toISOString(),
  });
}
