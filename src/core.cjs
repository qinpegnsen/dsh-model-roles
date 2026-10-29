'use strict';

const STORAGE_KEY = 'dsh.model-roles.v1';
const emptyPresets = () => ({ planning: null, execution: null, execution2: null });

/** Execution slots are named execution, execution2, execution3… in display order. */
const executionKey = number => (number === 1 ? 'execution' : `execution${number}`);

function executionNumber(role) {
  if (role === 'execution') return 1;
  if (!/^execution[1-9][0-9]*$/.test(role)) return null;
  const number = Number(role.slice(9));
  return Number.isSafeInteger(number) && number >= 2 ? number : null;
}

function rolesFor(presets) {
  return ['planning', ...Object.keys(presets).filter(role => role !== 'planning')
    .sort((a, b) => executionNumber(a) - executionNumber(b))];
}

function roleLabel(role) {
  if (role === 'planning') return '规划模型';
  const number = executionNumber(role);
  if (number === null) throw new Error('未知模型角色。');
  return `执行模型${number}`;
}

/** Add one unconfigured execution slot at the end; returns a new preset object. */
function addExecution(presets) {
  return { ...presets, [executionKey(rolesFor(presets).length)]: null };
}

/** Remove one execution slot and renumber the rest, preserving every selection. */
function removeExecution(presets, role) {
  if (role === 'planning' || !Object.hasOwn(presets, role)) throw new Error('只能删除已有的执行模型。');
  const next = { planning: presets.planning };
  let number = 1;
  for (const current of rolesFor(presets)) {
    if (current !== 'planning' && current !== role) next[executionKey(number++)] = presets[current];
  }
  return next;
}

function isSelection(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.provider === 'string' && value.provider.length > 0
    && typeof value.model === 'string' && value.model.length > 0
    && (value.reasoningEffort === undefined || (typeof value.reasoningEffort === 'string' && value.reasoningEffort.length > 0))
    && Object.keys(value).every(key => ['provider', 'model', 'reasoningEffort'].includes(key));
}

function parsePresets(raw) {
  if (raw === null) return emptyPresets();
  const doc = JSON.parse(raw);
  const invalid = () => { throw new Error('模型预设格式不正确或版本不受支持，请先检查本浏览器的插件配置。'); };
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || ![1, 2].includes(doc.version)
    || Object.keys(doc).some(key => !['version', 'presets'].includes(key))
    || doc.presets === null || typeof doc.presets !== 'object' || Array.isArray(doc.presets)
    || !Object.hasOwn(doc.presets, 'planning')) invalid();
  const keys = Object.keys(doc.presets);
  if (keys.some(role => role !== 'planning' && executionNumber(role) === null)
    || keys.some(role => doc.presets[role] !== null && !isSelection(doc.presets[role]))) invalid();
  if (doc.version === 1) {
    // 0.1.x and the first 0.2.0 draft stored either two or three slots.
    if (!Object.hasOwn(doc.presets, 'execution')
      || keys.some(role => !['planning', 'execution', 'execution2'].includes(role))) invalid();
    return { planning: doc.presets.planning, execution: doc.presets.execution, execution2: doc.presets.execution2 ?? null };
  }
  const roles = rolesFor(doc.presets);
  if (roles.slice(1).some((role, index) => role !== executionKey(index + 1))) invalid();
  return Object.fromEntries(roles.map(role => [role, doc.presets[role]]));
}

function sameSelection(a, b) {
  return a != null && b != null && a.provider === b.provider && a.model === b.model
    && a.reasoningEffort === b.reasoningEffort;
}

function findModel(groups, selection) {
  if (!selection) return undefined;
  return groups.find(group => group.id === selection.provider)?.models.find(model => model.id === selection.model);
}

function validateSelection(groups, selection) {
  if (!isSelection(selection)) throw new Error('尚未配置模型。');
  const model = findModel(groups, selection);
  if (!model) throw new Error(`预设模型当前不可用：${selection.provider}/${selection.model}。请重新配置，不会自动替换为其他模型。`);
  if (selection.reasoningEffort !== undefined
    && !model.reasoning?.efforts.some(level => level.id === selection.reasoningEffort)) {
    throw new Error('预设的推理强度当前不可用，请重新配置。');
  }
  return model;
}

class PresetStore {
  constructor(storage) {
    this.storage = storage;
    this.listeners = new Set();
    this.state = { presets: emptyPresets(), revision: null, error: null };
    this.getSnapshot = () => this.state;
    this.subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    this.reload();
  }
  publish(state) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  reload() {
    try {
      const revision = this.storage.getItem(STORAGE_KEY);
      this.publish({ presets: parsePresets(revision), revision, error: null });
    } catch (error) {
      this.publish({ ...this.state, error: error.message || '无法读取模型预设。' });
    }
  }
  save(presets, expectedRevision) {
    const raw = JSON.stringify({ version: 2, presets });
    const checked = parsePresets(raw);
    const before = this.storage.getItem(STORAGE_KEY);
    parsePresets(before);
    if (before !== expectedRevision) {
      this.reload();
      throw new Error('模型预设已在其他窗口修改，请关闭配置后重新打开。');
    }
    this.storage.setItem(STORAGE_KEY, raw);
    const after = this.storage.getItem(STORAGE_KEY);
    if (after !== raw) {
      this.reload();
      throw new Error('模型预设保存后读回不一致，请重新打开配置核对。');
    }
    this.publish({ presets: checked, revision: raw, error: null });
  }
}

class RoleSwitcher {
  constructor({ presets, directoryFor, notify, isAvailable, isAlive = () => true }) {
    this.presets = presets;
    this.directoryFor = directoryFor;
    this.notify = notify;
    this.isAvailable = isAvailable;
    this.isAlive = isAlive;
    this.busy = new Set();
  }
  async switchTo(role, sessionId) {
    if (this.busy.has(sessionId)) return;
    this.busy.add(sessionId);
    try {
      if (!this.isAvailable(sessionId)) throw new Error('当前对话不支持切换模型。');
      this.presets.reload();
      const saved = this.presets.getSnapshot();
      if (saved.error) throw new Error(saved.error);
      if (!Object.hasOwn(saved.presets, role)) throw new Error('该模型预设已删除，请重新打开菜单。');
      const label = roleLabel(role);
      const selection = saved.presets[role];
      if (!selection) throw new Error(`请先点击“配置模型预设”，设置${label}。`);
      const directory = this.directoryFor(sessionId);
      const state = await directory.load();
      if (!this.isAlive()) return;
      if (!this.isAvailable(sessionId)) throw new Error('原对话已关闭，未切换模型。');
      const model = validateSelection(state.groups, selection);
      if (directory.store.getSnapshot().pending) throw new Error('当前对话正在切换模型，请稍后再试。');
      if (sameSelection(directory.store.getSnapshot().current, selection)) {
        this.notify(`当前已是${label}：${model.name}`, true);
        return;
      }
      const result = await directory.select({ ...selection });
      if (!this.isAlive()) return;
      if (!result.ok) throw new Error(result.error.message || result.error.code || '模型切换失败。');
      // 与内置选择器同源读回；不得把 RPC 受理当成切换完成。
      if (!sameSelection(directory.store.getSnapshot().current, selection)) {
        throw new Error('模型切换结果尚未同步，请核对输入框旁的当前模型，不要重复切换。');
      }
      this.notify(`已切换到${label}：${model.name}；下次请求生效`, true);
    } catch (error) {
      if (this.isAlive()) this.notify(error.message || '模型切换失败。', false);
    } finally {
      this.busy.delete(sessionId);
    }
  }
}

function currentMainSession(sessions, layout) {
  if (layout.panelInfo.getSnapshot().activePanelId !== null) return undefined;
  const candidates = Object.values(sessions.list.getSnapshot().byId)
    .filter(item => (item.retainedBy.mainView ?? 0) > 0);
  if (candidates.length !== 1) return undefined;
  const id = candidates[0].id;
  return sessions.subagentAddress(id) === undefined && sessions.binding(id) ? id : undefined;
}

function shortcutFor(role, resolveTarget, switchTo) {
  // 规划模型 Digit1；执行模型 N 使用 Digit(N+1)，第 10 个起复用 Digit0，更多角色由用户自行绑定。
  const digit = role === 'planning' ? 1 : executionNumber(role) + 1;
  const binding = digit <= 10 ? { code: `Digit${digit % 10}`, modifiers: ['primary', 'alt'] } : undefined;
  return {
    id: `model-roles.${role}`,
    label: () => `切换到${roleLabel(role)}`,
    aliases: [role, `${role} model`, roleLabel(role)],
    defaults: binding ? { 'web:macos': binding, 'web:windows': binding, 'desktop:macos': binding, 'desktop:windows': binding } : {},
    regions: ['page', 'editable'],
    modals: [],
    resolve: () => {
      const sessionId = resolveTarget();
      return sessionId === undefined ? { status: 'pass' } : {
        status: 'handled', run: () => { void switchTo(role, sessionId); }
      };
    }
  };
}

/** Keep registered shortcuts in step with the saved preset list. */
function syncShortcuts(presets, register, resolveTarget, switchTo) {
  const registered = new Map();
  const sync = () => {
    const snapshot = presets.getSnapshot();
    if (snapshot.error) return;
    const roles = rolesFor(snapshot.presets);
    for (const [role, dispose] of registered) {
      if (!roles.includes(role)) { dispose(); registered.delete(role); }
    }
    for (const role of roles) {
      if (!registered.has(role)) registered.set(role, register(shortcutFor(role, resolveTarget, switchTo)));
    }
  };
  const unsubscribe = presets.subscribe(sync);
  sync();
  return () => { unsubscribe(); for (const dispose of registered.values()) dispose(); registered.clear(); };
}

module.exports = { STORAGE_KEY, rolesFor, roleLabel, executionNumber, addExecution, removeExecution,
  syncShortcuts, parsePresets, sameSelection, findModel, validateSelection, PresetStore, RoleSwitcher,
  currentMainSession, shortcutFor };
