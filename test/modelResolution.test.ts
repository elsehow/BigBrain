import { expect, test } from 'bun:test';
import { modelsForRole } from '../lib/modelSelection';
import { choiceJournalFields, resolveModel, selectionProblem } from '../lib/modelResolution';
import { MODEL_ROLES, type ModelCapabilities } from '../lib/modelChoice';
import type { ModelProvider } from '../lib/modelCatalog';

test('menu eligibility and live role validation agree on per-model capabilities', () => {
  const capabilities: ModelCapabilities = { tools: false, streaming: true, structuredOutput: true, budget: true };
  const provider: ModelProvider = { id: 'pi/openai-codex', ready: true, label: 'ChatGPT', billing: 'subscription',
    models: [{ id: 'restricted', label: 'Restricted', capabilities }, { id: 'complete', label: 'Complete' }] };
  const choice = { adapter: 'pi', provider: 'openai-codex', model: 'restricted' };
  const observation = { available: true, transport: 'subscription' as const, modelCapabilities: capabilities };
  for (const role of MODEL_ROLES) {
    const problem = selectionProblem(choice, role, observation);
    expect(modelsForRole([provider], role)[0]!.models.some(m => m.id === choice.model)).toBe(!problem);
    if (problem) expect(() => resolveModel(choice, role, observation)).toThrow(problem);
    else expect(resolveModel(choice, role, observation).capabilities.tools).toBe(false);
  }
  expect(modelsForRole([provider], 'gardener')[0]!.ready).toBe(true);
});

test('runtime rechecks availability and reasoning after discovery without selecting a fallback', () => {
  const choice = { adapter: 'pi', provider: 'openai-codex', model: 'fixture', reasoning: 'high' };
  expect(resolveModel(choice, 'pilot', { available: true, transport: 'subscription', reasoning: ['high'] }).choice).toEqual(choice);
  expect(() => resolveModel(choice, 'pilot', { available: false, transport: 'subscription' })).toThrow('Connect ChatGPT');
  expect(() => resolveModel(choice, 'pilot', { available: true, transport: 'subscription', reasoning: ['low'] })).toThrow('reasoning level');
});

test('a model cannot promise an API spending limit its runtime cannot enforce', () => {
  const choice = { adapter: 'pi', provider: 'openai', model: 'fixture' };
  expect(() => resolveModel(choice, 'quick', { available: true, transport: 'api', modelCapabilities: { budget: true } })).toThrow('spending limit');
  expect(choiceJournalFields(choice)).toMatchObject({ engine: 'pi', sampling: 'pi-defaults', provider: 'openai' });
  expect(choiceJournalFields({ adapter: 'pi', provider: 'anthropic', model: 'claude-opus-5' })).toMatchObject({ engine: 'pi', sampling: 'pi-defaults', provider: 'anthropic' });
});
