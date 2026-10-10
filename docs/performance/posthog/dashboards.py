"""Generate reviewable PostHog dashboard/insight payloads; never reads credentials.
Requires management access to apply. Public ingestion tokens cannot create charts.
Run: python3 docs/performance/posthog/dashboards.py > /tmp/bigbrain-dashboards.json
"""
import json

BASE = "timestamp >= now() - INTERVAL 30 DAY AND properties.release != 'development' AND toInt(properties.schema) = 1"

def insight(name, description, sql, x=None, y=None, breakdown=None):
    query = dict(kind='DataVisualizationNode', source=dict(kind='HogQLQuery', query=sql), display='ActionsTable')
    if x and y:
        query.update(display='ActionsLineGraph', chartSettings=dict(xAxis=dict(column=x), yAxis=[dict(column=y)]))
        if breakdown:
            query['chartSettings']['seriesBreakdownColumn'] = breakdown
    return dict(name=name, description=description, query=query, tags=['bigbrain-telemetry-v1'])

def build():
    perf = []
    for metric, title, unit in [('cpu_mean', 'Viewer CPU by release and window state', 'percent of one CPU core'), ('rss_mean_mb', 'Viewer RSS by release and window state', 'MiB')]:
        perf.append(insight(title, f'Last 30 days. Sample-weighted {unit}; viewer process only. Split by release, OS, foreground and gardening. Excludes development.', f"""SELECT toDate(timestamp) AS day,
concat(toString(properties.release), ' / ', toString(properties.platform), ' / foreground=', toString(properties.foreground), ' / gardening=', toString(properties.gardening)) AS segment,
sum(toFloat(properties.{metric}) * toFloat(properties.samples)) / nullIf(sum(toFloat(properties.samples)), 0) AS value
FROM events WHERE event = 'desktop_resources' AND {BASE} AND properties.scope = 'viewer_engine'
GROUP BY day, segment ORDER BY day, segment""", 'day', 'value', 'segment'))
    perf.append(insight('Viewer memory by engine age', 'Last 30 days. Sample-weighted RSS by hour of engine age, release and OS. Cross-sectional cohorts: this is not a per-session leak test.', f"""SELECT floor(toFloat(properties.age_minutes) / 60) AS engine_age_hours,
concat(toString(properties.release), ' / ', toString(properties.platform)) AS segment,
sum(toFloat(properties.rss_mean_mb) * toFloat(properties.samples)) / nullIf(sum(toFloat(properties.samples)), 0) AS rss_mb
FROM events WHERE event = 'desktop_resources' AND {BASE} AND properties.scope = 'viewer_engine'
GROUP BY engine_age_hours, segment ORDER BY engine_age_hours, segment""", 'engine_age_hours', 'rss_mb', 'segment'))
    perf.append(insight('Request latency and failures by release', 'Last 30 days. Request-weighted mean, worst reported maximum and failure rate. Operation suffix gives gardener state at request start. Pilot submit measures acceptance, not response generation. No request-level percentiles are available.', f"""SELECT properties.release AS release, properties.platform AS platform, properties.operation AS operation,
sum(toFloat(properties.count)) AS requests,
sum(toFloat(properties.mean_ms) * toFloat(properties.count)) / nullIf(sum(toFloat(properties.count)), 0) AS mean_ms,
max(toFloat(properties.max_ms)) AS worst_ms,
100 * sum(toFloat(properties.failures)) / nullIf(sum(toFloat(properties.count)), 0) AS failure_percent
FROM events WHERE event = 'desktop_operation' AND {BASE}
GROUP BY release, platform, operation ORDER BY release, platform, operation"""))
    perf.append(insight('Coarse timer delay by release and state', 'Last 30 days. Maximum of five-minute summary maxima; ten-second sampler omits gaps of 30 seconds or more. Not a renderer frame-time or event-loop percentile.', f"""SELECT toDate(timestamp) AS day,
concat(toString(properties.release), ' / ', toString(properties.platform), ' / foreground=', toString(properties.foreground), ' / gardening=', toString(properties.gardening)) AS segment,
max(toFloat(properties.timer_delay_max_ms)) AS delay_ms
FROM events WHERE event = 'desktop_resources' AND {BASE} AND properties.scope = 'viewer_engine'
GROUP BY day, segment ORDER BY day, segment""", 'day', 'delay_ms', 'segment'))
    usage = [insight('Weekly engaged installations', 'Last 30 days; first and last weeks may be partial. Distinct installations with an explicit note-open or accepted Pilot input. Opt-in sample only, not total users. Excludes development.', f"""SELECT toStartOfWeek(timestamp) AS week, count(DISTINCT distinct_id) AS installations
FROM events WHERE event = 'desktop_usage' AND {BASE} AND properties.action IN ('note_opened', 'pilot_input_accepted') AND toFloat(properties.count) > 0
GROUP BY week ORDER BY week""", 'week', 'installations'), insight('Explicit usage counts', 'Last 30 days. Sum action counts, not summary-event counts. Accepted Pilot inputs are not completed turns. Note-open instrumentation covers explicit navigation, not every rendered note.', f"""SELECT toDate(timestamp) AS day, properties.action AS action, sum(toFloat(properties.count)) AS actions
FROM events WHERE event = 'desktop_usage' AND {BASE} AND properties.action IN ('note_opened', 'pilot_input_accepted')
GROUP BY day, action ORDER BY day, action""", 'day', 'actions', 'action')]
    health = [insight('Installations with a failing integration', 'Last 30 days. Distinct installations whose hourly report found the integration failing, by integration and error code. A provider change that breaks every installation shows as one rising line. Excludes development.', f"""SELECT toDate(timestamp) AS day, concat(toString(properties.integration), ' / ', toString(properties.code)) AS segment, count(DISTINCT distinct_id) AS installations
FROM events WHERE event = 'integration_health' AND {BASE} AND properties.state = 'error'
GROUP BY day, segment ORDER BY day, segment""", 'day', 'installations', 'segment'), insight('Integrations failing for six hours or more', 'Last two hours of hourly reports: installations whose integration has failed every poll for at least six hours, by integration, code and release. The alert source: any row is an outage nobody has fixed.', """SELECT properties.integration AS integration, properties.code AS code, properties.release AS release,
count(DISTINCT distinct_id) AS installations, max(toFloat(properties.failing_hours)) AS longest_hours
FROM events WHERE event = 'integration_health' AND timestamp >= now() - INTERVAL 2 HOUR AND properties.release != 'development' AND toInt(properties.schema) = 1
AND properties.state = 'error' AND toFloat(properties.failing_hours) >= 6
GROUP BY integration, code, release ORDER BY installations DESC""")]
    return [dict(dashboard=dict(name='BigBrain · Performance', description='Opt-in viewer-engine diagnostics. Fixed trailing 30-day queries; development excluded. Means are weighted by sample/request counts. No GPU or whole-app totals.', tags=['bigbrain-telemetry-v1']), insights=perf), dict(dashboard=dict(name='BigBrain · Engagement', description='Explicit user actions among opted-in installations. Background work and uptime are excluded. Fixed trailing 30 days.', tags=['bigbrain-telemetry-v1']), insights=usage), dict(dashboard=dict(name='BigBrain · Integration health', description='Hourly poller health among opted-in installations: state, error code and how long polls have failed. No messages, accounts or meeting data.', tags=['bigbrain-telemetry-v1']), insights=health)]

if __name__ == '__main__':
    print(json.dumps(build(), indent=2))
