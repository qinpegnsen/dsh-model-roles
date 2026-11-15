const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PresetStore } = require('../src/core.cjs');

// 用最小 React/组件替身渲染配置窗口与按钮，只校验结构与交互契约，不替代实机 UI 验收。
function loadClient() {
  const source = fs.readFileSync(path.join(__dirname, '../src/client.cjs'), 'utf8');
  const buckets = new Map();
  const effects = [];
  let cursor = 0;
  let bucket = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat().filter(child => child !== null && child !== undefined) }),
    Fragment: 'Fragment',
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useState: initial => {
      const key = cursor++;
      if (!(key in bucket)) bucket[key] = typeof initial === 'function' ? initial() : initial;
      return [bucket[key], value => { bucket[key] = typeof value === 'function' ? value(bucket[key]) : value; }];
    },
    useEffect: effect => effects.push(effect)
  };
  const primitives = Object.fromEntries(['Button', 'Modal', 'Toast', 'Tooltip', 'IconDataOutlineRegular']
    .map(name => [name, name]));
  const module = { exports: {} };
  const factory = new Function('require', 'module', 'window', `${source}\nmodule.exports.__ui = { ConfigDialog, Toolbar, css, teamBridge };`);
  factory(name => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    if (name === './core.cjs') return require('../src/core.cjs');
    throw new Error(`Unexpected client import: ${name}`);
  }, module, { navigator: { platform: 'Win32' } });
  const ui = module.exports.__ui;
  const stateOf = name => {
    if (!buckets.has(name)) buckets.set(name, []);
    return buckets.get(name);
  };
  return {
    ui,
    stateOf,
    effects,
    render: (name, props) => { cursor = 0; bucket = stateOf(name); return ui[name](props); }
  };
}

function walk(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...(tree.children || []).flatMap(child => walk(child, predicate))];
}

function fixture() {
  const client = loadClient();
  let raw = JSON.stringify({ version: 1, presets: {
    planning: { provider: 'p', model: 'reasoning', reasoningEffort: 'high' },
    execution: { provider: 'p', model: 'plain' },
    execution2: null
  } });
  let writes = 0;
  let closes = 0;
  const applies = [];
  const stateRef = { current: null };
  const presets = new PresetStore({ getItem: () => raw, setItem: (_key, value) => { raw = value; writes++; } });
  const catalog = { groups: [{ id: 'p', name: 'Provider', models: [
    { id: 'reasoning', name: 'Reasoning', model: 'reasoning', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } },
    { id: 'plain', name: 'Plain' }
  ] }], failures: [] };
  const store = { subscribe: () => () => {}, getSnapshot: () => ({ ...catalog, current: stateRef.current }) };
  const props = {
    presets,
    directory: { store, load: async () => catalog },
    shortcuts: { catalog: { subscribe: () => () => {}, getSnapshot: () => [] } },
    controller: { notify: () => {} },
    sessionId: 'session',
    available: true,
    team: { available: true, apply: async (sessionId, enabled) => { applies.push([sessionId, enabled]); return null; } },
    onClose: () => { closes++; }
  };
  // 首次渲染后标记目录已加载，跳过异步载入等待。
  const render = name => {
    client.render(name, props);
    if (name === 'ConfigDialog') {
      const state = client.stateOf(name);
      // 0 initial · 1 draft · 2 teamDraft · 3 error · 4 loading · 5 loaded · 6 savedRevision
      if (state[4] !== undefined) { state[4] = false; state[5] = true; }
    }
    return client.render(name, props);
  };
  return { client, props, presets, stateRef, render, applies, writes: () => writes, closes: () => closes, raw: () => raw };
}

test('every slot has one model selector and an unlabelled reasoning selector in the same row', () => {
  const f = fixture();
  const tree = f.render('ConfigDialog');
  const rows = walk(tree, node => node.props.className === 'dsh-model-roles-row');
  assert.equal(rows.length, 3);
  const selects = row => walk(row, node => node.type === 'select');
  assert.deepEqual(selects(rows[0]).map(node => node.props.id),
    ['dsh-model-roles-planning', 'dsh-model-roles-planning-effort', 'dsh-model-roles-planning-team']);
  assert.deepEqual(selects(rows[1]).map(node => node.props.id),
    ['dsh-model-roles-execution', 'dsh-model-roles-execution-team']);
  assert.deepEqual(selects(rows[2]).map(node => node.props.id),
    ['dsh-model-roles-execution2', 'dsh-model-roles-execution2-team']);
  assert.equal(walk(tree, node => node.type === 'label' && node.children.join('') === '推理强度').length, 0);
  assert.equal(walk(tree, node => node.props['aria-label'] === '规划模型推理强度').length, 1);
  assert.match(f.client.ui.css, /\.dsh-model-roles-row\{display:flex;align-items:flex-end/);
});

test('dialog no longer renders the removed description and help paragraphs', () => {
  const f = fixture();
  const modal = f.render('ConfigDialog');
  assert.equal(modal.props.description, undefined);
  const paragraphs = walk(modal, node => node.type === 'p').map(node => node.children.join(''));
  assert.deepEqual(paragraphs, []);
});

test('new slots show their default shortcut and configured bindings still win', () => {
  const f = fixture();
  let tree = f.render('ConfigDialog');
  walk(tree, node => Object.hasOwn(node.props, 'data-model-roles-add'))[0].props.onClick();
  tree = f.render('ConfigDialog');
  const label = role => walk(tree, node => node.type === 'label' && node.props.htmlFor === `dsh-model-roles-${role}`)[0].children.join('');
  assert.equal(label('execution3'), '执行模型3 · Ctrl + Alt + 4');
  f.props.shortcuts.catalog.getSnapshot = () => [{ id: 'model-roles.execution', keys: ['Ctrl', '+', 'Shift', '+', 'X'] }];
  tree = f.render('ConfigDialog');
  const configured = role => walk(tree, node => node.type === 'label' && node.props.htmlFor === `dsh-model-roles-${role}`)[0].children.join('');
  assert.equal(configured('execution'), '执行模型1 · Ctrl+Shift+X');
});

test('add and delete only change the draft; cancel writes nothing', () => {
  const f = fixture();
  const before = f.raw();
  let tree = f.render('ConfigDialog');
  walk(tree, node => Object.hasOwn(node.props, 'data-model-roles-add'))[0].props.onClick();
  tree = f.render('ConfigDialog');
  assert.equal(walk(tree, node => node.props.className === 'dsh-model-roles-row').length, 4);
  walk(tree, node => node.props['aria-label'] === '删除执行模型1')[0].props.onClick();
  tree = f.render('ConfigDialog');
  assert.equal(walk(tree, node => node.props.className === 'dsh-model-roles-row').length, 3);
  assert.equal(walk(tree, node => node.props['aria-label'] === '删除规划模型').length, 0);
  walk(tree.props.footer, node => node.type === 'Button' && node.children.join('') === '取消')[0].props.onClick();
  assert.equal(f.closes(), 1);
  assert.equal(f.writes(), 0);
  assert.equal(f.raw(), before);
});

test('saving a new slot persists version 3; the toolbar button opens the dialog directly', () => {
  const f = fixture();
  let tree = f.render('ConfigDialog');
  walk(tree, node => Object.hasOwn(node.props, 'data-model-roles-add'))[0].props.onClick();
  tree = f.render('ConfigDialog');
  walk(tree, node => node.props.id === 'dsh-model-roles-execution3')[0]
    .props.onChange({ target: { value: JSON.stringify(['p', 'reasoning']) } });
  tree = f.render('ConfigDialog');
  walk(tree, node => node.props.id === 'dsh-model-roles-execution3-effort')[0]
    .props.onChange({ target: { value: '' } });
  tree = f.render('ConfigDialog');
  walk(tree.props.footer, node => Object.hasOwn(node.props, 'data-model-roles-save'))[0].props.onClick();
  assert.equal(f.writes(), 1);
  const saved = JSON.parse(f.raw());
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.presets.execution3, { provider: 'p', model: 'reasoning' });
  assert.equal(saved.presets.execution2, null);

  const toolbar = f.render('Toolbar');
  assert.equal(walk(toolbar, node => node.type === 'Menu').length, 0, '不再渲染中间菜单');
  const trigger = walk(toolbar, node => node.props && node.props['data-dsh-model-roles'] !== undefined)[0];
  assert.equal(trigger.type, 'Button');
  assert.equal(trigger.children.join(''), '模型预设');
  assert.equal(trigger.props['aria-haspopup'], 'dialog');
  trigger.props.onClick();
  const opened = f.render('Toolbar');
  assert.equal(walk(opened, node => node.type === f.client.ui.ConfigDialog).length, 1, '点击后直接挂载配置窗口');
  const dialog = f.render('ConfigDialog');
  assert.equal(walk(dialog.props.footer, node => Object.hasOwn(node.props, 'data-model-roles-save')).length, 1);
});

test('active preset is reflected in the button label and tooltip', () => {
  const f = fixture();
  f.stateRef.current = { provider: 'p', model: 'plain' };
  const toolbar = f.render('Toolbar');
  const trigger = walk(toolbar, node => node.props && node.props['data-dsh-model-roles'] !== undefined)[0];
  assert.equal(trigger.children.join(''), '执行模型1');
  assert.equal(trigger.props['data-dsh-model-role-active'], 'execution');
  const tooltip = walk(toolbar, node => node.type === 'Tooltip')[0];
  assert.match(String(tooltip.props.label), /执行模型1：Plain/);
});

test('toolbar tooltip escapes the composer containing block without changing its trigger', () => {
  const toolbar = fixture().render('Toolbar');
  const tooltip = walk(toolbar, node => node.type === 'Tooltip')[0];
  assert.equal(tooltip.props.portal, true, '气泡挂载到 body，避免 composer 的 will-change 定位和滚动反馈');
  assert.equal(tooltip.props.side, 'top', '优先显示在底部工具栏上方');
  assert.equal(tooltip.children[0].type, 'Button');
  assert.equal(tooltip.children[0].props['aria-haspopup'], 'dialog');
});

test('each slot carries its own team dropdown inside the preset row', () => {
  const f = fixture();
  let tree = f.render('ConfigDialog');
  const teamSelects = () => walk(tree, node => node.type === 'select' && Object.hasOwn(node.props, 'data-model-roles-team'));
  assert.deepEqual(teamSelects().map(node => node.props['data-model-roles-team']), ['planning', 'execution', 'execution2']);
  assert.ok(teamSelects().every(node => node.props.value === ''), '未记录的槽默认显示未设置');

  // 团队协作下拉放在模型/推理强度那一行，不再额外占一行。
  const rows = walk(tree, node => node.props.className === 'dsh-model-roles-row');
  assert.equal(rows.length, 3);
  assert.equal(walk(rows[0], node => Object.hasOwn(node.props, 'data-model-roles-team')).length, 1);
  assert.equal(walk(rows[1], node => Object.hasOwn(node.props, 'data-model-roles-team')).length, 1);
  assert.equal(walk(tree, node => String(node.props.className).includes('dsh-model-roles-team') && node.type === 'div').length, 3);

  const options = walk(teamSelects()[0], node => node.type === 'option').map(node => node.children.join(''));
  assert.deepEqual(options, ['团队协作 · 未设置', '团队协作 · 开启', '团队协作 · 关闭']);

  teamSelects()[0].props.onChange({ target: { value: 'on' } });
  tree = f.render('ConfigDialog');
  assert.equal(teamSelects()[0].props.value, 'on');
  assert.equal(teamSelects()[1].props.value, '', '各槽独立记录，互不影响');
  teamSelects()[0].props.onChange({ target: { value: 'off' } });
  tree = f.render('ConfigDialog');
  assert.equal(teamSelects()[0].props.value, 'off', '显式关闭与未设置分开记');
  teamSelects()[0].props.onChange({ target: { value: '' } });
  tree = f.render('ConfigDialog');
  assert.equal(teamSelects()[0].props.value, '', '选回未设置会清掉记录');
  assert.match(f.client.ui.css, /\.dsh-model-roles-team\{flex:0 0 auto/);
});

test('saving stores team flags with the preset and applies the active one', async () => {
  const f = fixture();
  f.stateRef.current = { provider: 'p', model: 'plain' };
  let tree = f.render('ConfigDialog');
  walk(tree, node => node.type === 'select' && node.props['data-model-roles-team'] === 'execution')[0].props.onChange({ target: { value: 'on' } });
  tree = f.render('ConfigDialog');
  walk(tree.props.footer, node => Object.hasOwn(node.props, 'data-model-roles-save'))[0].props.onClick();
  await Promise.resolve();
  const saved = JSON.parse(f.raw());
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.team, { execution: true });
  assert.deepEqual(f.applies, [['session', true]], '当前生效的预设保存后立即同步团队开关');
  assert.equal(f.closes(), 1);
});

test('saving the active preset re-applies its recorded team flag', async () => {
  const f = fixture();
  f.presets.reload();
  f.presets.save({ planning: { provider: 'p', model: 'reasoning', reasoningEffort: 'high' },
    execution: { provider: 'p', model: 'plain' }, execution2: null },
  f.presets.getSnapshot().revision, { planning: true });
  f.stateRef.current = { provider: 'p', model: 'reasoning', reasoningEffort: 'high' };
  const tree = f.render('ConfigDialog');
  walk(tree.props.footer, node => Object.hasOwn(node.props, 'data-model-roles-save'))[0].props.onClick();
  await Promise.resolve();
  // 预设是准绳：即使没改开关，保存命中的预设也把记录的状态下发一次，保证失败后重试能补救。
  assert.deepEqual(f.applies, [['session', true]]);
  assert.equal(f.closes(), 1);
});

test('team bridge probes the host and maps failures to readable messages', async () => {
  const bridge = loadClient().ui.teamBridge;
  assert.equal(bridge({}).available, false, '没有 remote.agentTeams 时不显示开关行');
  assert.match(await bridge({}).apply('session', true), /不可用/);
  assert.equal(bridge({ reflect: { get: () => { throw new Error('boom'); } } }).available, false, '探测失败按不可用处理');

  const ok = bridge({ reflect: { get: () => ({ setEnabled: async () => ({ ok: true }) }) } });
  assert.equal(ok.available, true);
  assert.equal(await ok.apply('session', true), null);

  const rejected = bridge({ reflect: { get: () => ({ setEnabled: async () => ({ ok: false, error: { message: 'remote rejected' } }) }) } });
  assert.equal(await rejected.apply('session', true), 'remote rejected');

  const silent = bridge({ reflect: { get: () => ({ setEnabled: async () => ({ ok: false }) }) } });
  assert.match(await silent.apply('session', true), /未保存/);

  const lead = bridge({ reflect: { get: () => ({ setEnabled: async () => { throw Object.assign(new Error('raw'), { code: 'TEAM_LEAD_REQUIRED' }); } }) } });
  assert.equal(await lead.apply('session', true), '只能在主会话上切换团队协作。');
});

test('team row is hidden when the host offers no team switch', () => {
  const f = fixture();
  f.props.team = { available: false, apply: async () => null };
  const tree = f.render('ConfigDialog');
  assert.equal(walk(tree, node => Object.hasOwn(node.props, 'data-model-roles-team')).length, 0);
  assert.equal(walk(tree, node => String(node.props.className).includes('dsh-model-roles-team')).length, 0);
});

test('removing a slot moves its team flag to the next position', () => {
  const f = fixture();
  f.presets.reload();
  f.presets.save({ planning: { provider: 'p', model: 'reasoning', reasoningEffort: 'high' },
    execution: { provider: 'p', model: 'plain' }, execution2: null },
  f.presets.getSnapshot().revision, { planning: true, execution: true });
  let tree = f.render('ConfigDialog');
  walk(tree, node => node.props['aria-label'] === '删除执行模型1')[0].props.onClick();
  tree = f.render('ConfigDialog');
  const teamSelects = walk(tree, node => node.type === 'select' && Object.hasOwn(node.props, 'data-model-roles-team'));
  assert.deepEqual(teamSelects.map(node => node.props.value), ['on', '']);
  walk(tree.props.footer, node => Object.hasOwn(node.props, 'data-model-roles-save'))[0].props.onClick();
  assert.deepEqual(JSON.parse(f.raw()).team, { planning: true });
});

test('team apply failure keeps the dialog open with the host message', async () => {
  const f = fixture();
  f.stateRef.current = { provider: 'p', model: 'reasoning', reasoningEffort: 'high' };
  f.props.team.apply = async () => '只能在主会话上切换团队协作。';
  let tree = f.render('ConfigDialog');
  walk(tree, node => node.type === 'select' && node.props['data-model-roles-team'] === 'planning')[0].props.onChange({ target: { value: 'on' } });
  tree = f.render('ConfigDialog');
  walk(tree.props.footer, node => Object.hasOwn(node.props, 'data-model-roles-save'))[0].props.onClick();
  await Promise.resolve();
  tree = f.render('ConfigDialog');
  assert.equal(f.closes(), 0, '开关未生效时不关闭，便于用户看到失败原因');
  const alerts = walk(tree, node => node.props.role === 'alert').map(node => node.children.join(''));
  assert.match(String(alerts[0]), /只能在主会话上切换团队协作。/);
  // 重试保存不能因为自己上一次已写入而误报“其他窗口修改”。
  walk(tree.props.footer, node => Object.hasOwn(node.props, 'data-model-roles-save'))[0].props.onClick();
  await Promise.resolve();
  tree = f.render('ConfigDialog');
  const retried = walk(tree, node => node.props.role === 'alert').map(node => node.children.join(''));
  assert.equal(retried.length, 1);
  assert.match(String(retried[0]), /只能在主会话上切换团队协作。/);
  assert.equal(f.closes(), 0);
});
