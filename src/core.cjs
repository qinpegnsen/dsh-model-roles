'use strict';

const STORAGE_KEY = 'dsh.model-roles.v1';
const ROLES = ['planning', 'execution'];
const LABELS = { planning: '规划', execution: '执行' };
const emptyPresets = () => ({ planning: null, execution: null });

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
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || doc.version !== 1
    || Object.keys(doc).some(key => !['version', 'presets'].includes(key))
    || doc.presets === null || typeof doc.presets !== 'object' || Array.isArray(doc.presets)
    || Object.keys(doc.presets).length !== 2
    || !ROLES.every(role => Object.hasOwn(doc.presets, role) && (doc.presets[role] === null || isSelection(doc.presets[role])))) {
    throw new Error('模型预设格式不正确或版本不受支持，请先检查本浏览器的插件配置。');
  }
  return doc.presets;
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
    const raw = JSON.stringify({ version: 1, presets });
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
    if (!ROLES.includes(role)) throw new Error('未知模型角色。');
    if (this.busy.has(sessionId)) return;
    this.busy.add(sessionId);
    try {
      if (!this.isAvailable(sessionId)) throw new Error('当前对话不支持切换模型。');
      this.presets.reload();
      const saved = this.presets.getSnapshot();
      if (saved.error) throw new Error(saved.error);
      const selection = saved.presets[role];
      if (!selection) throw new Error(`请先点击“配置双模型”，设置${LABELS[role]}模型。`);
      const directory = this.directoryFor(sessionId);
      const state = await directory.load();
      if (!this.isAlive()) return;
      if (!this.isAvailable(sessionId)) throw new Error('原对话已关闭，未切换模型。');
      const model = validateSelection(state.groups, selection);
      if (directory.store.getSnapshot().pending) throw new Error('当前对话正在切换模型，请稍后再试。');
      if (sameSelection(directory.store.getSnapshot().current, selection)) {
        this.notify(`当前已是${LABELS[role]}模型：${model.name}`, true);
        return;
      }
      const result = await directory.select({ ...selection });
      if (!this.isAlive()) return;
      if (!result.ok) throw new Error(result.error.message || result.error.code || '模型切换失败。');
      // 与内置选择器同源读回；不得把 RPC 受理当成切换完成。
      if (!sameSelection(directory.store.getSnapshot().current, selection)) {
        throw new Error('模型切换结果尚未同步，请核对输入框旁的当前模型，不要重复切换。');
      }
      this.notify(`已切换到${LABELS[role]}模型：${model.name}；下次请求生效`, true);
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
  const binding = { code: role === 'planning' ? 'Digit1' : 'Digit2', modifiers: ['primary', 'alt'] };
  return {
    id: `model-roles.${role}`,
    label: () => `切换到${LABELS[role]}模型`,
    aliases: [role, `${role} model`, LABELS[role]],
    defaults: { 'web:macos': binding, 'web:windows': binding, 'desktop:macos': binding, 'desktop:windows': binding },
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

module.exports = { STORAGE_KEY, ROLES, LABELS, parsePresets, sameSelection, findModel,
  validateSelection, PresetStore, RoleSwitcher, currentMainSession, shortcutFor };
