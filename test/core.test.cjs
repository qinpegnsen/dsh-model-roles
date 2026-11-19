const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STORAGE_KEY, rolesFor, roleLabel, addPreset, removePreset, removeTeamPreset, syncShortcuts,
  parseDocument, parsePresets, PresetStore, RoleSwitcher, sameSelection, validateSelection, currentMainSession,
  shortcutFor } = require('../src/core.cjs');
const A = { provider: 'provider-a', model: 'model-1', reasoningEffort: 'high' };
const B = { provider: 'provider-b', model: 'model-1' };
const C = { provider: 'provider-a', model: 'model-1' };
const groups = [
  { id: 'provider-a', name: 'A', models: [{ id: 'model-1', name: 'Planner', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: '高' }, { id: 'low', name: '低' }] } }] },
  { id: 'provider-b', name: 'B', models: [{ id: 'model-1', name: 'Executor' }] }
];
const plain = value => JSON.parse(JSON.stringify(value));
const preset = n => `preset${n}`;
const many = count => {
  const presets = {};
  for (let n = 1; n <= count; n++) presets[preset(n)] = n % 3 === 1 ? A : n % 2 ? B : C;
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

test('first run and version 1 documents migrate into a flat preset list', () => {
  assert.equal(STORAGE_KEY, 'dsh.model-roles.v1');
  assert.deepEqual(plain(parsePresets(null)), { preset1: null, preset2: null, preset3: null });
  assert.deepEqual(Array.from(rolesFor(parsePresets(null))), ['preset1', 'preset2', 'preset3']);
  assert.equal(roleLabel('preset1'), '预设模型1');
  assert.equal(roleLabel('preset3'), '预设模型3');
  const two = { version: 1, presets: { planning: A, execution: B } };
  assert.deepEqual(plain(parsePresets(JSON.stringify(two))), { preset1: A, preset2: B, preset3: null });
  const three = { version: 1, presets: { planning: A, execution: B, execution2: C } };
  assert.deepEqual(plain(parsePresets(JSON.stringify(three))), { preset1: A, preset2: B, preset3: C });
});

test('version 2 and 3 documents migrate without losing order or team flags', () => {
  const legacy = { version: 3, presets: { planning: A, execution: B, execution2: C },
    team: { planning: true, execution: false, execution2: true } };
  const parsed = parseDocument(JSON.stringify(legacy));
  assert.deepEqual(plain(parsed.presets), { preset1: A, preset2: B, preset3: C });
  assert.deepEqual(plain(parsed.team), { preset1: true, preset2: false, preset3: true });
  const noTeam = { version: 2, presets: { planning: A, execution: B, execution2: null } };
  assert.deepEqual(plain(parseDocument(JSON.stringify(noTeam)).team), {});
});

test('invalid or unsupported documents are rejected instead of silently fixed', () => {
  for (const value of ['null', '[]', '{}', '{',
    JSON.stringify({ version: 4, presets: {} }),
    JSON.stringify({ version: 4, presets: { preset2: A } }),
    JSON.stringify({ version: 4, presets: { preset1: A, preset3: B } }),
    JSON.stringify({ version: 4, presets: { planning: A } }),
    JSON.stringify({ version: 4, presets: { preset1: null }, team: { planning: true } }),
    JSON.stringify({ version: 4, presets: { preset1: null }, team: { preset1: 'yes' } }),
    JSON.stringify({ version: 4, presets: { preset1: null }, team: { preset1: null } }),
    JSON.stringify({ version: 4, presets: { preset1: null }, team: [] }),
    JSON.stringify({ version: 4, presets: { preset1: null }, team: { preset2: true } }),
    JSON.stringify({ version: 4, presets: { preset1: null }, team: {}, extra: true }),
    JSON.stringify({ version: 4, presets: { preset1: { ...A, extra: 'no' } } }),
    JSON.stringify({ version: 4, presets: [] }),
    JSON.stringify({ version: 3, presets: { planning: null }, team: { unknown: true } }),
    JSON.stringify({ version: 3, presets: { planning: null }, team: { planning: 'yes' } }),
    JSON.stringify({ version: 3, presets: { planning: null }, team: { execution: true } }),
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
    JSON.stringify({ version: 1, presets: { planning: A, preset2: B } }),
    JSON.stringify({ version: 2, presets: { planning: { provider: 'x', model: '' } } })]) {
    assert.throws(() => parsePresets(value));
  }
});

test('adding and removing presets never mutates input and renumbers by position', () => {
  const original = Object.freeze(many(4));
  const before = JSON.stringify(original);
  const added = addPreset(original);
  assert.equal(added.preset5, null);
  for (const role of Object.keys(original)) assert.deepEqual(plain(added[role]), plain(original[role]));
  const removed = removePreset(original, 'preset2');
  assert.deepEqual(Array.from(rolesFor(removed)), ['preset1', 'preset2', 'preset3']);
  assert.deepEqual(plain(removed.preset1), plain(original.preset1));
  assert.deepEqual(plain(removed.preset2), plain(original.preset3));
  assert.deepEqual(plain(removed.preset3), plain(original.preset4));
  assert.deepEqual(plain(removePreset({ preset1: A, preset2: B }, 'preset1')), { preset1: B });
  assert.throws(() => removePreset({ preset1: A }, 'preset1'), /至少保留/);
  assert.throws(() => removePreset(original, 'preset9'), /不存在/);
  assert.throws(() => removePreset(original, 'planning'), /不存在/);
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

test('save writes version 4 and detects stale cross-tab edits', () => {
  const adapter = storage();
  const first = new PresetStore(adapter);
  const second = new PresetStore(adapter);
  first.save({ preset1: A, preset2: null, preset3: null, preset4: B }, null);
  assert.equal(JSON.parse(adapter.read()).version, 4);
  assert.deepEqual(plain(new PresetStore(adapter).getSnapshot().presets),
    { preset1: A, preset2: null, preset3: null, preset4: B });
  assert.throws(() => second.save({ preset1: null, preset2: B, preset3: null }, null), /其他窗口/);
  second.reload();
  assert.deepEqual(plain(second.getSnapshot().presets), { preset1: A, preset2: null, preset3: null, preset4: B });
});

test('storage failure preserves accepted presets and surfaces errors', () => {
  const adapter = storage();
  const store = new PresetStore(adapter);
  const presets = { preset1: A, preset2: B, preset3: null };
  store.save(presets, null);
  const before = store.getSnapshot();
  adapter.setItem = () => { throw new Error('quota'); };
  assert.throws(() => store.save({ preset1: null, preset2: null, preset3: null }, before.revision), /quota/);
  assert.equal(store.getSnapshot(), before);
  adapter.getItem = () => { throw new Error('read denied'); };
  store.reload();
  assert.equal(store.getSnapshot().error, 'read denied');
  assert.deepEqual(plain(store.getSnapshot().presets), plain(before.presets));
});

test('saves verify readback and reject malformed stored data', () => {
  const store = new PresetStore({ getItem: () => null, setItem: () => {} });
  assert.throws(() => store.save({ preset1: A, preset2: B, preset3: null }, null), /读回不一致/);
  const corrupt = new PresetStore(storage('invalid'));
  assert.ok(corrupt.getSnapshot().error);
  assert.throws(() => corrupt.save({ preset1: A, preset2: B, preset3: null }, 'invalid'));
});

test('any preset switches with its own exact selection', async () => {
  const f = fixture();
  const presets = many(12);
  f.presets.save(presets, f.presets.getSnapshot().revision);
  await f.controller.switchTo('preset1', 's1');
  await f.controller.switchTo('preset12', 's1');
  assert.deepEqual(f.calls, [A, presets.preset12]);
  assert.ok(f.notices.every(([, success]) => success));
  assert.match(f.notices[1][0], /预设模型12/);
});

test('selecting current preset avoids repeated host write', async () => {
  const f = fixture();
  f.presets.save({ preset1: A, preset2: B, preset3: null }, null);
  await f.controller.switchTo('preset2', 's1');
  assert.equal(f.calls.length, 0);
  assert.match(f.notices[0][0], /当前已是预设模型2/);
});

test('missing, deleted and unavailable presets never fall back or submit', async () => {
  const f = fixture();
  f.presets.save({ preset1: null, preset2: B, preset3: null }, null);
  await f.controller.switchTo('preset1', 's1');
  assert.match(f.notices[0][0], /配置模型预设/);
  await f.controller.switchTo('preset9', 's1');
  assert.match(f.notices[1][0], /已删除/);
  f.setState({ groups: [] });
  await f.controller.switchTo('preset2', 's1');
  assert.match(f.notices[2][0], /不可用/);
  assert.equal(f.calls.length, 0);
});

test('host rejection and unconfirmed sync never show success', async () => {
  const rejected = fixture();
  rejected.presets.save({ preset1: A, preset2: B, preset3: null }, null);
  rejected.directory.select = async () => ({ ok: false, error: { code: 'denied', message: 'writer held' } });
  await rejected.controller.switchTo('preset1', 's1');
  assert.deepEqual(rejected.notices, [['writer held', false]]);
  const unconfirmed = fixture();
  unconfirmed.presets.save({ preset1: A, preset2: B, preset3: null }, null);
  unconfirmed.directory.select = async () => ({ ok: true });
  await unconfirmed.controller.switchTo('preset1', 's1');
  assert.match(unconfirmed.notices[0][0], /尚未同步/);
  assert.equal(unconfirmed.notices[0][1], false);
});

test('pending host switch and unsupported session refuse write', async () => {
  const pending = fixture();
  pending.presets.save({ preset1: A, preset2: B, preset3: null }, null);
  pending.setState({ pending: A });
  await pending.controller.switchTo('preset1', 's1');
  assert.equal(pending.calls.length, 0);
  const child = fixture({ isAvailable: () => false });
  await child.controller.switchTo('preset1', 'child');
  assert.equal(child.calls.length, 0);
  assert.match(child.notices[0][0], /不支持/);
});

test('repeat presses serialize per session, capture target before await', async () => {
  const f = fixture();
  f.presets.save({ preset1: A, preset2: B, preset3: null }, null);
  let release;
  f.directory.load = () => new Promise(resolve => { release = () => resolve(f.directory.store.getSnapshot()); });
  const first = f.controller.switchTo('preset1', 's1');
  await f.controller.switchTo('preset2', 's1');
  release();
  await first;
  assert.deepEqual(f.calls, [A]);
  assert.equal(f.controller.busy.size, 0);
});

test('closed session or unloaded plugin cannot submit late selection', async () => {
  let available = true;
  const f = fixture({ isAvailable: () => available });
  f.presets.save({ preset1: A, preset2: B, preset3: null }, null);
  f.directory.load = async () => { available = false; return f.directory.store.getSnapshot(); };
  await f.controller.switchTo('preset1', 's1');
  assert.equal(f.calls.length, 0);
  const unloaded = fixture({ isAlive: () => false });
  unloaded.presets.save({ preset1: A, preset2: B, preset3: null }, null);
  await unloaded.controller.switchTo('preset1', 's1');
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
  const first = shortcutFor('preset1', () => current, (...args) => calls.push(args));
  assert.equal(first.id, 'model-roles.preset1');
  assert.deepEqual(first.defaults['web:macos'], { code: 'Digit1', modifiers: ['primary', 'alt'] });
  assert.deepEqual(first.regions, ['page', 'editable']);
  assert.deepEqual(first.modals, []);
  const action = first.resolve();
  current = 'second';
  action.run();
  assert.deepEqual(calls, [['preset1', 'first']]);
  current = undefined;
  assert.equal(first.resolve().status, 'pass');
  for (let n = 1; n <= 9; n++) {
    assert.equal(shortcutFor(preset(n), () => undefined, () => {}).defaults['web:windows'].code, `Digit${n}`);
  }
  assert.equal(shortcutFor('preset10', () => undefined, () => {}).defaults['web:windows'].code, 'Digit0');
  assert.deepEqual(shortcutFor('preset11', () => undefined, () => {}).defaults, {});
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
  assert.deepEqual([...active], ['model-roles.preset1', 'model-roles.preset2', 'model-roles.preset3']);
  presets.save(many(5), presets.getSnapshot().revision);
  assert.equal(active.size, 5);
  presets.save({ preset1: A }, presets.getSnapshot().revision);
  assert.deepEqual([...active], ['model-roles.preset1']);
  dispose();
  assert.equal(active.size, 0);
  assert.equal(disposed, 5);
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

test('version 4 documents carry per-preset team flags and reject unknown roles', () => {
  const doc = { version: 4, presets: { preset1: A, preset2: B, preset3: null },
    team: { preset1: true, preset2: false } };
  const parsed = parseDocument(JSON.stringify(doc));
  assert.deepEqual(plain(parsed.presets), doc.presets);
  assert.deepEqual(plain(parsed.team), { preset1: true, preset2: false });
  assert.deepEqual(plain(parseDocument(null).team), {});
  assert.deepEqual(plain(parseDocument(JSON.stringify({ version: 4, presets: { preset1: null } })).team), {});
  assert.throws(() => parseDocument(JSON.stringify({ version: 4, presets: { preset1: null }, team: { planning: true } })), /格式不正确/);
  assert.throws(() => parseDocument(JSON.stringify({ version: 4, presets: { preset1: null }, team: 'yes' })), /格式不正确/);
});

test('team flags follow their preset when another preset is removed', () => {
  const presets = many(3);
  const team = { preset1: true, preset2: false, preset3: true };
  const after = removeTeamPreset(presets, team, 'preset1');
  assert.deepEqual(after, { preset1: false, preset2: true });
  assert.deepEqual(removeTeamPreset(presets, team, 'preset2'), { preset1: true, preset2: true });
  assert.deepEqual(removeTeamPreset({ preset1: A, preset2: B }, { preset1: true }, 'preset1'), {});
});

test('saving presets stores team flags and switching applies them', async () => {
  const adapter = storage();
  const store = new PresetStore(adapter);
  store.save({ preset1: A, preset2: B, preset3: null }, null, { preset1: true, unknown: true, preset2: 'yes' });
  assert.deepEqual(plain(JSON.parse(adapter.read()).team), { preset1: true });
  assert.deepEqual(plain(store.getSnapshot().team), { preset1: true });
  const applied = [];
  const f = fixture({ setTeam: async (sessionId, enabled) => { applied.push([sessionId, enabled]); return null; } });
  f.presets.save({ preset1: A, preset2: B, preset3: null }, null, { preset1: true, preset2: false });
  await f.controller.switchTo('preset1', 's1');
  await f.controller.switchTo('preset2', 's1');
  assert.deepEqual(applied, [['s1', true], ['s1', false]]);
  assert.ok(f.notices.every(([, success]) => success));
});

test('team switch failures surface without claiming a clean switch', async () => {
  const failing = fixture({ setTeam: async () => 'root required' });
  failing.presets.save({ preset1: A, preset2: B, preset3: null }, null, { preset1: true });
  await failing.controller.switchTo('preset1', 's1');
  assert.match(failing.notices[0][0], /团队协作开关设置失败：root required/);
  assert.equal(failing.notices[0][1], false);
  assert.equal(failing.calls.length, 1);
  const skipped = fixture();
  skipped.presets.save({ preset1: A, preset2: B, preset3: null }, null, {});
  await skipped.controller.switchTo('preset1', 's1');
  assert.equal(skipped.notices[0][1], true);
});
