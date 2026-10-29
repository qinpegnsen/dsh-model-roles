const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STORAGE_KEY, rolesFor, roleLabel, addExecution, removeExecution, syncShortcuts, parsePresets,
  PresetStore, RoleSwitcher, sameSelection, validateSelection, currentMainSession, shortcutFor } = require('../src/core.cjs');
const A = { provider: 'provider-a', model: 'model-1', reasoningEffort: 'high' };
const B = { provider: 'provider-b', model: 'model-1' };
const C = { provider: 'provider-a', model: 'model-1' };
const groups = [
  { id: 'provider-a', name: 'A', models: [{ id: 'model-1', name: 'Planner', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: '高' }, { id: 'low', name: '低' }] } }] },
  { id: 'provider-b', name: 'B', models: [{ id: 'model-1', name: 'Executor' }] }
];
const plain = value => JSON.parse(JSON.stringify(value));
const execution = n => (n === 1 ? 'execution' : `execution${n}`);
const many = count => {
  const presets = { planning: A };
  for (let n = 1; n <= count; n++) presets[execution(n)] = n % 2 ? B : C;
  return presets;
};
function storage(initial = null) {
  let raw = initial;
  return {
    getItem: () => raw,
    setItem: (_key, value) => { raw = value; },
    replace: value => { raw = value; },
    read: () => raw
  };
}
function fixture(options = {}) {
  const adapter = storage();
  const presets = new PresetStore(adapter);
  let state = { groups, current: B, pending: null };
  const calls = [];
  const notices = [];
  const directory = {
    store: { getSnapshot: () => state },
    load: async () => state,
    select: async selection => { calls.push(selection); state = { ...state, current: selection }; return { ok: true }; }
  };
  const controller = new RoleSwitcher({ presets, directoryFor: () => directory,
    isAvailable: () => true, notify: (...args) => notices.push(args), ...options });
  return { controller, presets, adapter, directory, calls, notices, setState: patch => { state = { ...state, ...patch }; } };
}

test('first run and version 1 documents migrate without losing selections', () => {
  assert.equal(STORAGE_KEY, 'dsh.model-roles.v1');
  assert.deepEqual(plain(parsePresets(null)), { planning: null, execution: null, execution2: null });
  assert.deepEqual(Array.from(rolesFor(parsePresets(null))), ['planning', 'execution', 'execution2']);
  assert.equal(roleLabel('planning'), '规划模型');
  assert.equal(roleLabel('execution'), '执行模型1');
  assert.equal(roleLabel('execution3'), '执行模型3');
  const two = { version: 1, presets: { planning: A, execution: B } };
  assert.deepEqual(plain(parsePresets(JSON.stringify(two))), { planning: A, execution: B, execution2: null });
  const three = { version: 1, presets: { planning: A, execution: B, execution2: C } };
  assert.deepEqual(plain(parsePresets(JSON.stringify(three))), three.presets);
});

test('invalid or unsupported documents are rejected instead of silently fixed', () => {
  for (const value of ['null', '[]', '{}', '{',
    JSON.stringify({ version: 3, presets: { planning: null } }),
    JSON.stringify({ version: 2, presets: { planning: null }, extra: true }),
    JSON.stringify({ version: 2, presets: [] }),
    JSON.stringify({ version: 2, presets: null }),
    JSON.stringify({ version: 2, presets: { execution: null } }),
    JSON.stringify({ version: 2, presets: { planning: null, unknown: null } }),
    JSON.stringify({ version: 2, presets: { planning: null, execution1: null } }),
    JSON.stringify({ version: 2, presets: { planning: null, execution2: null } }),
    JSON.stringify({ version: 2, presets: { planning: null, execution: null, execution3: null } }),
    JSON.stringify({ version: 2, presets: { planning: null, execution: null, execution02: null } }),
    JSON.stringify({ version: 1, presets: { planning: A } }),
    JSON.stringify({ version: 1, presets: { planning: A, execution: B, execution3: C } }),
    JSON.stringify({ version: 2, presets: { planning: { provider: 'x', model: '' } } }),
    JSON.stringify({ version: 2, presets: { planning: { ...A, extra: 'no' } } })]) {
    assert.throws(() => parsePresets(value));
  }
});

test('adding and removing slots never mutates input and renumbers by position', () => {
  const original = Object.freeze(many(4));
  const before = JSON.stringify(original);
  const added = addExecution(original);
  assert.equal(added.execution5, null);
  for (const role of Object.keys(original)) assert.deepEqual(plain(added[role]), plain(original[role]));
  const removed = removeExecution(original, 'execution2');
  assert.deepEqual(Array.from(rolesFor(removed)), ['planning', 'execution', 'execution2', 'execution3']);
  assert.deepEqual(plain(removed.execution), plain(original.execution));
  assert.deepEqual(plain(removed.execution2), plain(original.execution3));
  assert.deepEqual(plain(removed.execution3), plain(original.execution4));
  assert.deepEqual(plain(removeExecution({ planning: A, execution: B }, 'execution')), { planning: A });
  assert.throws(() => removeExecution(original, 'planning'), /执行模型/);
  assert.throws(() => removeExecution(original, 'execution9'), /执行模型/);
  assert.equal(JSON.stringify(original), before);
});

test('exact provider, model and reasoning, not name or model-only match', () => {
  assert.equal(sameSelection(A, B), false);
  assert.equal(sameSelection(A, { ...A, reasoningEffort: 'low' }), false);
  assert.equal(sameSelection(null, null), false);
  assert.equal(sameSelection(A, { ...A }), true);
  validateSelection(groups, A);
  validateSelection(groups, B);
  assert.throws(() => validateSelection(groups, { ...A, reasoningEffort: 'max' }), /推理强度/);
  assert.throws(() => validateSelection(groups, { ...B, provider: 'missing' }), /不可用/);
});

test('save writes version 2 and detects stale cross-tab edits', () => {
  const adapter = storage();
  const first = new PresetStore(adapter);
  const second = new PresetStore(adapter);
  first.save({ planning: A, execution: null, execution2: null, execution3: B }, null);
  assert.equal(JSON.parse(adapter.read()).version, 2);
  assert.deepEqual(plain(new PresetStore(adapter).getSnapshot().presets),
    { planning: A, execution: null, execution2: null, execution3: B });
  assert.throws(() => second.save({ planning: null, execution: B, execution2: null }, null), /其他窗口/);
  second.reload();
  assert.deepEqual(plain(second.getSnapshot().presets), { planning: A, execution: null, execution2: null, execution3: B });
});

test('storage failure preserves accepted presets and surfaces errors', () => {
  const adapter = storage();
  const store = new PresetStore(adapter);
  const presets = { planning: A, execution: B, execution2: null };
  store.save(presets, null);
  const before = store.getSnapshot();
  adapter.setItem = () => { throw new Error('quota'); };
  assert.throws(() => store.save({ planning: null, execution: null, execution2: null }, before.revision), /quota/);
  assert.equal(store.getSnapshot(), before);
  adapter.getItem = () => { throw new Error('read denied'); };
  store.reload();
  assert.equal(store.getSnapshot().error, 'read denied');
  assert.deepEqual(plain(store.getSnapshot().presets), plain(before.presets));
});

test('saves verify readback and reject malformed stored data', () => {
  const store = new PresetStore({ getItem: () => null, setItem: () => {} });
  assert.throws(() => store.save({ planning: A, execution: B, execution2: null }, null), /读回不一致/);
  const corrupt = new PresetStore(storage('invalid'));
  assert.ok(corrupt.getSnapshot().error);
  assert.throws(() => corrupt.save({ planning: A, execution: B, execution2: null }, 'invalid'));
});

test('any execution slot switches with its own exact selection', async () => {
  const f = fixture();
  const presets = many(12);
  f.presets.save(presets, f.presets.getSnapshot().revision);
  await f.controller.switchTo('planning', 's1');
  await f.controller.switchTo('execution12', 's1');
  assert.deepEqual(f.calls, [A, presets.execution12]);
  assert.ok(f.notices.every(([, success]) => success));
  assert.match(f.notices[1][0], /执行模型12/);
});

test('selecting current preset avoids repeated host write', async () => {
  const f = fixture();
  f.presets.save({ planning: A, execution: B, execution2: null }, null);
  await f.controller.switchTo('execution', 's1');
  assert.equal(f.calls.length, 0);
  assert.match(f.notices[0][0], /当前已是执行模型1/);
});

test('missing, deleted and unavailable presets never fall back or submit', async () => {
  const f = fixture();
  f.presets.save({ planning: null, execution: B, execution2: null }, null);
  await f.controller.switchTo('planning', 's1');
  assert.match(f.notices[0][0], /配置模型预设/);
  await f.controller.switchTo('execution3', 's1');
  assert.match(f.notices[1][0], /已删除/);
  f.setState({ groups: [] });
  await f.controller.switchTo('execution', 's1');
  assert.match(f.notices[2][0], /不可用/);
  assert.equal(f.calls.length, 0);
});

test('host rejection and unconfirmed sync never show success', async () => {
  const rejected = fixture();
  rejected.presets.save({ planning: A, execution: B, execution2: null }, null);
  rejected.directory.select = async () => ({ ok: false, error: { code: 'denied', message: 'writer held' } });
  await rejected.controller.switchTo('planning', 's1');
  assert.deepEqual(rejected.notices, [['writer held', false]]);
  const unconfirmed = fixture();
  unconfirmed.presets.save({ planning: A, execution: B, execution2: null }, null);
  unconfirmed.directory.select = async () => ({ ok: true });
  await unconfirmed.controller.switchTo('planning', 's1');
  assert.match(unconfirmed.notices[0][0], /尚未同步/);
  assert.equal(unconfirmed.notices[0][1], false);
});

test('pending host switch and unsupported session refuse write', async () => {
  const pending = fixture();
  pending.presets.save({ planning: A, execution: B, execution2: null }, null);
  pending.setState({ pending: A });
  await pending.controller.switchTo('planning', 's1');
  assert.equal(pending.calls.length, 0);
  const child = fixture({ isAvailable: () => false });
  await child.controller.switchTo('planning', 'child');
  assert.equal(child.calls.length, 0);
  assert.match(child.notices[0][0], /不支持/);
});

test('repeat presses serialize per session, capture target before await', async () => {
  const f = fixture();
  f.presets.save({ planning: A, execution: B, execution2: null }, null);
  let release;
  f.directory.load = () => new Promise(resolve => { release = () => resolve(f.directory.store.getSnapshot()); });
  const first = f.controller.switchTo('planning', 's1');
  await f.controller.switchTo('execution', 's1');
  release();
  await first;
  assert.deepEqual(f.calls, [A]);
  assert.equal(f.controller.busy.size, 0);
});

test('closed session or unloaded plugin cannot submit late selection', async () => {
  let available = true;
  const f = fixture({ isAvailable: () => available });
  f.presets.save({ planning: A, execution: B, execution2: null }, null);
  f.directory.load = async () => { available = false; return f.directory.store.getSnapshot(); };
  await f.controller.switchTo('planning', 's1');
  assert.equal(f.calls.length, 0);
  const unloaded = fixture({ isAlive: () => false });
  unloaded.presets.save({ planning: A, execution: B, execution2: null }, null);
  await unloaded.controller.switchTo('planning', 's1');
  assert.equal(unloaded.calls.length, 0);
  assert.equal(unloaded.notices.length, 0);
});

test('main-view targeting ignores other panels, side sessions and addressed children', () => {
  let byId = { main: { id: 'main', retainedBy: { mainView: 1 } }, side: { id: 'side', retainedBy: { sidebar: 1 } } };
  let panel = null;
  let child;
  const sessions = { list: { getSnapshot: () => ({ byId }) }, binding: () => ({}), subagentAddress: () => child };
  const layout = { panelInfo: { getSnapshot: () => ({ activePanelId: panel }) } };
  assert.equal(currentMainSession(sessions, layout), 'main');
  panel = 'plugins';
  assert.equal(currentMainSession(sessions, layout), undefined);
  panel = null;
  child = {};
  assert.equal(currentMainSession(sessions, layout), undefined);
  child = undefined;
  byId.second = { id: 'second', retainedBy: { mainView: 1 } };
  assert.equal(currentMainSession(sessions, layout), undefined);
});

test('shortcuts keep stable ids and sequential digit defaults', () => {
  let current = 'first';
  const calls = [];
  const planning = shortcutFor('planning', () => current, (...args) => calls.push(args));
  assert.equal(planning.id, 'model-roles.planning');
  assert.deepEqual(planning.defaults['web:macos'], { code: 'Digit1', modifiers: ['primary', 'alt'] });
  assert.deepEqual(planning.regions, ['page', 'editable']);
  assert.deepEqual(planning.modals, []);
  const action = planning.resolve();
  current = 'second';
  action.run();
  assert.deepEqual(calls, [['planning', 'first']]);
  current = undefined;
  assert.equal(planning.resolve().status, 'pass');
  for (let n = 1; n <= 8; n++) {
    assert.equal(shortcutFor(execution(n), () => undefined, () => {}).defaults['web:windows'].code, `Digit${n + 1}`);
  }
  assert.equal(shortcutFor('execution9', () => undefined, () => {}).defaults['web:windows'].code, 'Digit0');
  assert.deepEqual(shortcutFor('execution10', () => undefined, () => {}).defaults, {});
});

test('registered shortcuts follow saved additions and deletions and clean up on unload', () => {
  const adapter = storage();
  const presets = new PresetStore(adapter);
  const active = new Set();
  let disposed = 0;
  const dispose = syncShortcuts(presets, definition => {
    assert.equal(active.has(definition.id), false);
    active.add(definition.id);
    return () => { assert.equal(active.delete(definition.id), true); disposed++; };
  }, () => undefined, () => {});
  assert.deepEqual([...active], ['model-roles.planning', 'model-roles.execution', 'model-roles.execution2']);
  presets.save(many(5), presets.getSnapshot().revision);
  assert.equal(active.size, 6);
  presets.save({ planning: A }, presets.getSnapshot().revision);
  assert.deepEqual([...active], ['model-roles.planning']);
  dispose();
  assert.equal(active.size, 0);
  assert.equal(disposed, 6);
});

test('corrupt stored data surfaces an error and keeps the last good snapshot', () => {
  const adapter = storage();
  const presets = new PresetStore(adapter);
  presets.save(many(3), null);
  const good = presets.getSnapshot();
  adapter.replace('{');
  presets.reload();
  assert.ok(presets.getSnapshot().error);
  assert.deepEqual(plain(presets.getSnapshot().presets), plain(good.presets));
});
