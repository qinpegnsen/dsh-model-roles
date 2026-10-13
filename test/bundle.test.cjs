const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('bundle declares transitive session remote and cleans all registrations on unload', () => {
  let exports;
  const listeners = new Map();
  const styles = [];
  const context = {
    window: { localStorage: { getItem: () => null, setItem: () => {} },
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
      seats.set(descriptor.id, { descriptor, component }); return () => seats.delete(descriptor.id);
    } }
  };
  exports.apply(ctx);
  assert.equal(commands.size, 2);
  assert.equal(seats.size, 2);
  assert.equal(styles.length, 1);
  assert.equal(seats.get('model-roles').descriptor.inject('ordinary-session').directory.sessionId, 'ordinary-session');
  for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose();
  assert.equal(commands.size, 0);
  assert.equal(seats.size, 0);
  assert.equal(styles.length, 0);
  assert.equal(listeners.size, 0);
});
