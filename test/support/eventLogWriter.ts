import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventLog } from "../../lib/eventLog";

const [root, writer] = process.argv.slice(2) as [string, string];
const log = eventLog<{ id: string; value: string }>({
  name: "test", dir: "log/events", when: () => "2026-09-04", validate: () => {},
});
writeFileSync(join(root, `ready-${writer}`), "");
while (!existsSync(join(root, "go"))) await Bun.sleep(1);
try {
  log.append(root, { id: "one-event", value: writer });
  console.log(JSON.stringify({ writer, accepted: true }));
} catch (error) {
  console.log(JSON.stringify({ writer, accepted: false, error: String(error) }));
}
