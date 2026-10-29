const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const presetsDocument = count => JSON.stringify({ version: 2, presets: Object.fromEntries([
  ['planning', null],
  ...Array.from({ length: count }, (_, index) => [index === 0 ? 'execution' : `execution${index + 1}`, null])
]) });

test('bundle declares transitive session remote and regenerates shortcuts with presets', () => {
  let exports;
  const listeners = new Map();
  const styles = [];
  let stored = null;
  const context = {
    window: { localStorage: { getItem: () => stored, setItem: (_key, value) => { stored = value; } },
      addEventListener: (event, fn) => listeners.set(event, fn),
      removeEventListener: (event, fn) => { if (listeners.get(event) === fn) listeners.delete(event); },
      __ModuleLoader__: { load: entry => {
        assert.equal(entry.id, 'dsh-model-roles');
        exports = entry.factory(id => {
          if (id === 'react') return { createElement() {} };
          if (id === '@deepseek-ai/dsh-client-ui-primitives') return {};
          throw new Error(`Undeclared bundle import: ${id}`);
        });
      } } },
    document: {
      createElement: () => ({ dataset: {}, remove() { styles.splice(styles.indexOf(this), 1); } }),
      head: { appendChild: style => styles.push(style) }
    }, console
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf8'), context);
  assert.ok(exports.inject.includes('remote'));
  assert.ok(exports.inject.includes('remote.session'), 'directoryFor accesses remote.session through calling Cordis scope');
  const disposers = [];
  const commands = new Map();
  const seats = new Map();
  const ctx = {
    effect: fn => disposers.push(fn()),
    shortcuts: { register: command => { commands.set(command.id, command); return () => commands.delete(command.id); } },
    modelDirectories: { directoryFor: id => {
      if (!exports.inject.includes('remote.session')) throw new Error('cannot get property "remote.session" without inject');
      return { sessionId: id };
    } },
    sessions: { subagentAddress: () => undefined },
    slots: { inject: (_name, fn) => { disposers.push(fn()); }, register: (descriptor, component) => {
      // Match the installed DSH SlotCore contract: name is a declared slot, id is the entry identity.
      const declared = new Set(['conversation.input.left', 'shell.overlay']);
      if (!declared.has(descriptor.name)) throw new Error(`slot "${descriptor.name}" is not declared`);
      assert.equal(typeof descriptor.id, 'string', 'list slots require an explicit entry id');
      assert.ok(descriptor.id.length > 0);
      assert.equal(seats.has(descriptor.id), false, 'entry ids must be unique');
      seats.set(descriptor.id, { descriptor, component }); return () => seats.delete(descriptor.id);
    } }
  };
  exports.apply(ctx);
  assert.equal(commands.size, 3);
  assert.equal(seats.size, 2);
  assert.equal(styles.length, 1);
  assert.equal(seats.get('model-roles').descriptor.inject('ordinary-session').directory.sessionId, 'ordinary-session');

  // 与其他标签页同步：新增执行模型后快捷键随之注册，删除后随之释放。
  stored = presetsDocument(6);
  listeners.get('storage')({ key: 'dsh.model-roles.v1' });
  assert.equal(commands.size, 7);
  assert.deepEqual([...commands.keys()].filter(id => id === 'model-roles.execution6'), ['model-roles.execution6']);

  stored = presetsDocument(2);
  listeners.get('storage')({ key: 'dsh.model-roles.v1' });
  assert.equal(commands.size, 3);
  assert.equal(commands.has('model-roles.execution3'), false);

  // 读取失败时不按旧快照增删快捷键。
  stored = 'invalid';
  listeners.get('storage')({ key: 'dsh.model-roles.v1' });
  assert.equal(commands.size, 3);

  for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose();
  assert.equal(commands.size, 0);
  assert.equal(seats.size, 0);
  assert.equal(styles.length, 0);
  assert.equal(listeners.size, 0);
});
