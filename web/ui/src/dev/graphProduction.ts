// Testing entry: initialize fabricated APIs, then load the exact shipped entry.
import { installGraphFixture } from './graphFixture';
import { setChoice, type BuiltIn } from '../lib/theme';
await installGraphFixture();
const theme = new URLSearchParams(location.search).get('graphTheme');
if (['default', 'dusk', 'phosphor'].includes(theme ?? '')) setChoice(theme as BuiltIn);
await import('../main');
