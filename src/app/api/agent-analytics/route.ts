import { query } from "@/lib/db";
import { json } from "@/lib/utils";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawDays = Number(url.searchParams.get("days") || 7);
  const days = Math.min(90, Math.max(1, Number.isFinite(rawDays) ? Math.round(rawDays) : 7));
  const projectId = url.searchParams.get("projectId") || null;
  const args = [days, projectId];

  const [summary, agents, tools, daily, recent, projects] = await Promise.all([
    query(
      `SELECT
         count(*)::int AS total_calls,
         count(*) FILTER (WHERE success)::int AS successful_calls,
         count(*) FILTER (WHERE NOT success)::int AS failed_calls,
         count(DISTINCT agent_name)::int AS active_agents,
         coalesce(round(avg(duration_ms))::int,0) AS avg_latency_ms,
         coalesce(max(duration_ms),0)::int AS max_latency_ms
       FROM mcp_usage_log
       WHERE created_at >= now() - make_interval(days => $1::int)
         AND ($2::uuid IS NULL OR project_id=$2::uuid)`,
      args,
    ),
    query(
      `SELECT agent_name,
         count(*)::int AS calls,
         count(*) FILTER (WHERE success)::int AS successes,
         count(*) FILTER (WHERE NOT success)::int AS failures,
         coalesce(round(avg(duration_ms))::int,0) AS avg_latency_ms,
         max(created_at) AS last_seen
       FROM mcp_usage_log
       WHERE created_at >= now() - make_interval(days => $1::int)
         AND ($2::uuid IS NULL OR project_id=$2::uuid)
       GROUP BY agent_name
       ORDER BY calls DESC, last_seen DESC
       LIMIT 30`,
      args,
    ),
    query(
      `SELECT tool_name,
         count(*)::int AS calls,
         count(*) FILTER (WHERE success)::int AS successes,
         count(*) FILTER (WHERE NOT success)::int AS failures,
         coalesce(round(avg(duration_ms))::int,0) AS avg_latency_ms,
         max(created_at) AS last_used
       FROM mcp_usage_log
       WHERE created_at >= now() - make_interval(days => $1::int)
         AND ($2::uuid IS NULL OR project_id=$2::uuid)
       GROUP BY tool_name
       ORDER BY calls DESC, last_used DESC
       LIMIT 40`,
      args,
    ),
    query(
      `SELECT date_trunc('day',created_at) AS day,
         count(*)::int AS calls,
         count(*) FILTER (WHERE success)::int AS successes,
         count(*) FILTER (WHERE NOT success)::int AS failures
       FROM mcp_usage_log
       WHERE created_at >= now() - make_interval(days => $1::int)
         AND ($2::uuid IS NULL OR project_id=$2::uuid)
       GROUP BY 1
       ORDER BY 1`,
      args,
    ),
    query(
      `SELECT u.id,u.tool_name,u.agent_name,u.success,u.duration_ms,u.error_code,u.input_summary,u.created_at,
              p.id project_id,p.name project_name,p.slug project_slug
       FROM mcp_usage_log u
       LEFT JOIN projects p ON p.id=u.project_id
       WHERE u.created_at >= now() - make_interval(days => $1::int)
         AND ($2::uuid IS NULL OR u.project_id=$2::uuid)
       ORDER BY u.created_at DESC
       LIMIT 80`,
      args,
    ),
    query(
      `SELECT p.id,p.name,p.slug,
         count(u.id)::int AS calls,
         count(u.id) FILTER (WHERE u.success)::int AS successes,
         coalesce(round(avg(u.duration_ms))::int,0) AS avg_latency_ms
       FROM projects p
       LEFT JOIN mcp_usage_log u
         ON u.project_id=p.id
        AND u.created_at >= now() - make_interval(days => $1::int)
       GROUP BY p.id,p.name,p.slug
       ORDER BY calls DESC,p.name`,
      [days],
    ),
  ]);

  const s = summary.rows[0] || {
    total_calls:0,successful_calls:0,failed_calls:0,active_agents:0,avg_latency_ms:0,max_latency_ms:0,
  };
  const successRate = s.total_calls ? Math.round((s.successful_calls / s.total_calls) * 1000) / 10 : 100;

  return json({
    range_days: days,
    project_id: projectId,
    summary: { ...s, success_rate: successRate },
    agents: agents.rows,
    tools: tools.rows,
    daily: daily.rows,
    recent: recent.rows,
    projects: projects.rows,
  });
}
