const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePresets, PresetStore, RoleSwitcher, sameSelection, validateSelection, currentMainSession, shortcutFor } = require('../src/core.cjs');
const A = { provider: 'provider-a', model: 'model-1', reasoningEffort: 'high' };
const B = { provider: 'provider-b', model: 'model-1' };
const groups = [
  { id: 'provider-a', name: 'A', models: [{ id: 'model-1', name: 'Planner', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: '高' }, { id: 'low', name: '低' }] } }] },
  { id: 'provider-b', name: 'B', models: [{ id: 'model-1', name: 'Executor' }] }
];
function storage(initial = null) {
  let raw = initial;
  return { getItem: () => raw, setItem: (_key, value) => { raw = value; } };
}
function fixture(options = {}) {
  const presets = new PresetStore(storage());
  presets.save({ planning: A, execution: B }, null);
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
  return { controller, presets, directory, calls, notices, setState: patch => { state = { ...state, ...patch }; } };
}

test('strict versioned presets round trip; invalid docs are not accepted', () => {
  assert.deepEqual(parsePresets(null), { planning: null, execution: null });
  const document = { version: 1, presets: { planning: A, execution: B } };
  assert.deepEqual(parsePresets(JSON.stringify(document)), document.presets);
  for (const value of ['null', '[]', '{}', '{', JSON.stringify({ ...document, version: 2 }),
    JSON.stringify({ version: 1, presets: { planning: A } }),
    JSON.stringify({ version: 1, presets: { planning: { provider: 'x', model: '' }, execution: null } }),
    JSON.stringify({ version: 1, presets: { planning: { ...A, extra: 'no' }, execution: B } })]) {
    assert.throws(() => parsePresets(value));
  }
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

test('save detects stale cross-tab edits; does not overwrite', () => {
  const adapter = storage();
  const first = new PresetStore(adapter);
  const second = new PresetStore(adapter);
  first.save({ planning: A, execution: null }, null);
  assert.throws(() => second.save({ planning: null, execution: B }, null), /其他窗口/);
  second.reload();
  assert.deepEqual(second.getSnapshot().presets, { planning: A, execution: null });
});

test('storage failure preserves accepted presets and surfaces errors', () => {
  const adapter = storage();
  const store = new PresetStore(adapter);
  store.save({ planning: A, execution: B }, null);
  const before = store.getSnapshot();
  adapter.setItem = () => { throw new Error('quota'); };
  assert.throws(() => store.save({ planning: null, execution: null }, before.revision), /quota/);
  assert.equal(store.getSnapshot(), before);
  adapter.getItem = () => { throw new Error('read denied'); };
  store.reload();
  assert.equal(store.getSnapshot().error, 'read denied');
  assert.deepEqual(store.getSnapshot().presets, before.presets);
});

test('saves verify readback and reject malformed stored data', () => {
  const store = new PresetStore({ getItem: () => null, setItem: () => {} });
  assert.throws(() => store.save({ planning: A, execution: B }, null), /读回不一致/);
  const corrupt = new PresetStore(storage('invalid'));
  assert.ok(corrupt.getSnapshot().error);
  assert.throws(() => corrupt.save({ planning: A, execution: B }, 'invalid'));
});

test('planning and execution switch preserve exact complete selection', async () => {
  const f = fixture();
  await f.controller.switchTo('planning', 's1');
  await f.controller.switchTo('execution', 's1');
  assert.deepEqual(f.calls, [A, B]);
  assert.equal(f.notices.length, 2);
  assert.ok(f.notices.every(([, success]) => success));
});

test('selecting current preset avoids repeated host write', async () => {
  const f = fixture();
  await f.controller.switchTo('execution', 's1');
  assert.equal(f.calls.length, 0);
  assert.match(f.notices[0][0], /当前已是执行/);
});

test('missing preset and unavailable route never fall back or submit', async () => {
  const f = fixture();
  f.presets.save({ planning: null, execution: B }, f.presets.getSnapshot().revision);
  await f.controller.switchTo('planning', 's1');
  assert.match(f.notices[0][0], /先点击/);
  f.setState({ groups: [] });
  await f.controller.switchTo('execution', 's1');
  assert.match(f.notices[1][0], /不可用/);
  assert.equal(f.calls.length, 0);
});

test('host rejection and unconfirmed sync never show success', async () => {
  const rejected = fixture();
  rejected.directory.select = async () => ({ ok: false, error: { code: 'denied', message: 'writer held' } });
  await rejected.controller.switchTo('planning', 's1');
  assert.deepEqual(rejected.notices, [['writer held', false]]);
  const unconfirmed = fixture();
  unconfirmed.directory.select = async () => ({ ok: true });
  await unconfirmed.controller.switchTo('planning', 's1');
  assert.match(unconfirmed.notices[0][0], /尚未同步/);
  assert.equal(unconfirmed.notices[0][1], false);
});

test('pending host switch and unsupported session refuse write', async () => {
  const pending = fixture();
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
  f.directory.load = async () => { available = false; return f.directory.store.getSnapshot(); };
  await f.controller.switchTo('planning', 's1');
  assert.equal(f.calls.length, 0);
  const unloaded = fixture({ isAlive: () => false });
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

test('shortcut resolves immutable target; no arbitrary DOM key listener or permissions writes', () => {
  let current = 'first';
  const calls = [];
  const shortcut = shortcutFor('planning', () => current, (...args) => calls.push(args));
  assert.deepEqual(shortcut.defaults['web:macos'], { code: 'Digit1', modifiers: ['primary', 'alt'] });
  assert.deepEqual(shortcut.regions, ['page', 'editable']);
  assert.deepEqual(shortcut.modals, []);
  const action = shortcut.resolve();
  current = 'second';
  action.run();
  assert.deepEqual(calls, [['planning', 'first']]);
  current = undefined;
  assert.equal(shortcut.resolve().status, 'pass');
});
