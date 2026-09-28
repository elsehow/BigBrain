#!/usr/bin/env python3
"""Read nginx click/download JSONL from stdin. No install-completion claims."""
import collections
import datetime
import json
import sys

since = sys.argv[1] if len(sys.argv) > 1 else ''  # optional YYYY-MM-DD, UTC
requests = collections.Counter()
clicks = {'web': collections.Counter(), 'dev': collections.Counter()}
for line in sys.stdin:
    try:
        event = json.loads(line)
        timestamp = datetime.datetime.fromisoformat(event['time']).astimezone(datetime.timezone.utc)
    except (ValueError, KeyError, TypeError):
        continue
    if timestamp.date().isoformat() < since:
        continue
    if event.get('source') in clicks and event.get('event') in ('copy_install', 'download_dmg'):
        clicks[event['source']][event['event']] += 1
    if 'path' in event and event.get('method') == 'GET' and event.get('status') in (200, 206):
        path = event['path']
        bucket = 'installer' if path == '/install.sh' else 'dmg' if path.endswith('.dmg') else 'app_zip' if '/BigBrain_' in path and path.endswith('.zip') else None
        if bucket:
            requests[bucket] += 1
print(json.dumps({
    'since_utc': since or None,
    'button_clicks': {source: dict(counts) for source, counts in clicks.items()},
    'download_requests': dict(requests),
    'note': 'Clicks and successful GET requests, not confirmed installs or unique users. Retries/ranges count separately. Test clicks and legacy installer callbacks are excluded.',
}, indent=2))
