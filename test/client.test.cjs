const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PresetStore } = require('../src/core.cjs');

// 用最小 React/组件替身渲染配置窗口与菜单，只校验结构与交互契约，不替代实机 UI 验收。
function loadClient() {
  const source = fs.readFileSync(path.join(__dirname, '../src/client.cjs'), 'utf8');
  const state = [];
  const effects = [];
  let cursor = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat().filter(child => child !== null && child !== undefined) }),
    Fragment: 'Fragment',
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useState: initial => {
      const key = cursor++;
      if (!(key in state)) state[key] = typeof initial === 'function' ? initial() : initial;
      return [state[key], value => { state[key] = typeof value === 'function' ? value(state[key]) : value; }];
    },
    useEffect: effect => effects.push(effect)
  };
  const primitives = Object.fromEntries(['Button', 'Menu', 'Modal', 'Toast', 'Tooltip', 'IconCheckOutlineRegular',
    'IconDataOutlineRegular', 'IconSettingsOutlineRegular'].map(name => [name, name]));
  const module = { exports: {} };
  const factory = new Function('require', 'module', 'window', `${source}\nmodule.exports.__ui = { ConfigDialog, Toolbar, css };`);
  factory(name => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    if (name === './core.cjs') return require('../src/core.cjs');
    throw new Error(`Unexpected client import: ${name}`);
  }, module, { navigator: { platform: 'Win32' } });
  const ui = module.exports.__ui;
  return { ui, state, effects, render: (name, props) => { cursor = 0; return ui[name](props); } };
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
    onClose: () => { closes++; }
  };
  // 首次渲染后标记目录已加载，跳过异步载入等待。
  const render = name => {
    client.render(name, props);
    if (name === 'ConfigDialog' && client.state[3] !== undefined) { client.state[3] = false; client.state[4] = true; }
    return client.render(name, props);
  };
  return { client, props, presets, stateRef, render, writes: () => writes, closes: () => closes, raw: () => raw };
}

test('every slot has one model selector and an unlabelled reasoning selector in the same row', () => {
  const f = fixture();
  const tree = f.render('ConfigDialog');
  const rows = walk(tree, node => node.props.className === 'dsh-model-roles-row');
  assert.equal(rows.length, 3);
  const selects = row => walk(row, node => node.type === 'select');
  assert.deepEqual(selects(rows[0]).map(node => node.props.id), ['dsh-model-roles-planning', 'dsh-model-roles-planning-effort']);
  assert.equal(selects(rows[1]).length, 1);
  assert.equal(selects(rows[2]).length, 1);
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

test('saving a new slot persists version 2 and the menu lists it immediately', () => {
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
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.presets.execution3, { provider: 'p', model: 'reasoning' });
  assert.equal(saved.presets.execution2, null);

  const menu = f.render('Toolbar');
  const menuNode = walk(menu, node => node.type === 'Menu')[0];
  const items = menuNode.props.items;
  assert.deepEqual(items.filter(item => /^execution/.test(item.id)).map(item => item.label),
    ['执行模型1', '执行模型2', '执行模型3']);
  // 当前选中只保留条目自带的勾，菜单不再叠加选中标记。
  assert.equal(menuNode.props.selectedId, undefined);
  assert.equal(items.find(item => item.id === 'execution').icon, undefined);
  f.stateRef.current = { provider: 'p', model: 'plain' };
  const active = walk(f.render('Toolbar'), node => node.type === 'Menu')[0].props.items;
  assert.equal(active.find(item => item.id === 'execution').icon.type, 'IconCheckOutlineRegular');
  assert.equal(active.find(item => item.id === 'planning').icon, undefined);
  assert.equal(items.at(-1).label, '配置模型预设…');
  const anchor = walk(menu, node => node.type === 'Menu')[0].props.anchor;
  const trigger = anchor.children[0];
  assert.equal(trigger.props['data-dsh-model-roles'], '');
  assert.equal(trigger.children.join(''), '模型预设');
});
