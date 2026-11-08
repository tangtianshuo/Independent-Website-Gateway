import type { Pool } from "pg";
import {
  authenticateSiteService,
  serviceScopeErrorResponse,
} from "./service-scope";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function readPublishOperation(
  request: Request,
  siteId: string,
  operationId: string,
  pool: Pool,
): Promise<Response> {
  let principal;
  try {
    principal = await authenticateSiteService(request, siteId, pool);
  } catch (error) {
    return serviceScopeErrorResponse(error);
  }
  if (
    !uuid.test(siteId) ||
    !uuid.test(operationId) ||
    !uuid.test(principal.workspaceId)
  )
    return Response.json({ error: "invalid_request" }, { status: 400 });
  try {
    const result = await pool.query(
      `SELECT operation."id", operation."status", operation."failureCode",
      operation."lastFailureCode", operation."nextAttemptAt", operation."attempts", operation."releaseId", operation."desiredRevision" AS "revision"
      FROM "PublishOperation" operation JOIN "Site" site ON site."id" = operation."siteId" AND site."workspaceId" = operation."workspaceId"
      WHERE operation."id" = $1 AND operation."siteId" = $2 AND operation."workspaceId" = $3`,
      [operationId, siteId, principal.workspaceId],
    );
    if (!result.rowCount)
      return Response.json(
        { error: "publish_operation_not_found" },
        { status: 404 },
      );
    return Response.json(result.rows[0], {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "publish_operation_unavailable" },
      { status: 503 },
    );
  }
}
